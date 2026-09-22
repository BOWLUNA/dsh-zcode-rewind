#!/usr/bin/env bash
# 卸载 dsh-zcode-rewind。
#
# 用法:
#   ./uninstall.sh                    # 从 profile web 卸载（**保留**快照库）
#   ./uninstall.sh --profile tui      # 换 profile
#   ./uninstall.sh --dsh /path/to/dsh # dsh 不在 PATH 上时显式指定
#   ./uninstall.sh --dry-run          # 只打印将要执行的命令
#   ./uninstall.sh --purge --yes      # ⚠️ 连快照库一起删（不可逆，会丢全部检查点与 undo 依据）
#
# 默认**不删数据**：快照库是你唯一的回滚依据，卸载插件不该顺手毁掉它。
set -euo pipefail

PKG="dsh-zcode-rewind"
PROFILE="web"
DSH_BIN="${DSH_BIN:-dsh}"
DRY_RUN=0
PURGE=0
CONFIRMED=0

usage() {
  cat <<'USAGE'
用法:
  ./uninstall.sh                    # 从 profile web 卸载（保留快照库）
  ./uninstall.sh --profile tui      # 换 profile
  ./uninstall.sh --dsh /path/to/dsh # dsh 不在 PATH 上时显式指定
  ./uninstall.sh --dry-run          # 只打印将要执行的命令
  ./uninstall.sh --purge --yes      # 连快照库一起删（不可逆）
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile 需要值}"; shift 2 ;;
    --dsh) DSH_BIN="${2:?--dsh 需要值}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --purge) PURGE=1; shift ;;
    --yes) CONFIRMED=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then say "  [dry-run] $*"; else say "  \$ $*"; "$@"; fi
}

# 快照库位置:与 lib/index.js 的解析规则一致 —— <DSH_HOME>/workspace-rewind。
#
# DSH_HOME 的解析顺序：$DSH_HOME → $DSH_INSTALL/harness → ~/.dsh。
# **不要写死桌面版的位置** —— 2026-09-21 那次 harness 搬迁让所有硬编码路径同时失效
# （旧地址 %APPDATA%\dsh-desktop\harness 与 C:\BL\AI\DSH Desktop 都已进回收站）。
# 以后换 harness 位置，只改 DSH_INSTALL 这一个变量：
#   export DSH_INSTALL="C:/BL/AI/dsh-harness"
if [ -n "${DSH_HOME:-}" ]; then
  DSH_HOME_DIR="$DSH_HOME"
elif [ -n "${DSH_INSTALL:-}" ]; then
  DSH_HOME_DIR="$DSH_INSTALL/harness"
else
  DSH_HOME_DIR="$HOME/.dsh"
fi
STORE="$DSH_HOME_DIR/workspace-rewind"

say "dsh-zcode-rewind 卸载"
say "  profile : $PROFILE"
say "  快照库  : $STORE"

if ! command -v "$DSH_BIN" >/dev/null 2>&1; then
  say "✗ 找不到 dsh（试过：$DSH_BIN）；用 --dsh 指定路径"
  exit 1
fi

say ""
say "执行："
run "$DSH_BIN" plugin --profile "$PROFILE" remove "$PKG"

if [ "$PURGE" -eq 1 ]; then
  say ""
  if [ "$CONFIRMED" -ne 1 ]; then
    say "⚠️  --purge 会删除 $STORE —— 里面是本插件记录的全部检查点与 blob，"
    say "    **删掉之后再也无法用它们恢复任何文件**。确认要删就再加一个 --yes。"
    exit 4
  fi
  if [ ! -e "$STORE" ]; then
    say "快照库不存在（$STORE），无需删除。"
  else
    SIZE="$(du -sh "$STORE" 2>/dev/null | cut -f1 || echo '?')"
    say "⚠️  删除快照库（$SIZE）：$STORE"
    run rm -rf "$STORE"
    say "  已删除。若那是你唯一的回滚依据，它现在没了。"
  fi
else
  say ""
  say "快照库**保留**在：$STORE"
  say "  想连它一起删：./uninstall.sh --purge --yes"
  say "  想先看看里面有什么：rewind_status（插件还在时）或直接 ls 那个目录。"
fi

say ""
say "重启 dsh 后插件行才会真正消失。"
