#!/usr/bin/env bash
# 安装 dsh-zcode-rewind 到某个 DSH profile。
#
# 用法:
#   ./install.sh                       # 装 npm 上的最新版到 profile web
#   ./install.sh --profile tui         # 换 profile
#   ./install.sh --local               # 装本仓库当前源码(link: 挂载,开发用)
#   ./install.sh --dsh /path/to/dsh    # dsh 不在 PATH 上时显式指定
#   ./install.sh --dry-run             # 只打印将要执行的命令
#
# 它**不会**:重启 dsh、改你的 settings.yaml、动别的工作区、要 sudo。
set -euo pipefail

PKG="dsh-zcode-rewind"
PROFILE="web"
MODE="npm"
DSH_BIN="${DSH_BIN:-dsh}"
DRY_RUN=0
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'USAGE'
用法:
  ./install.sh                       # 装 npm 上的最新版到 profile web
  ./install.sh --profile tui         # 换 profile
  ./install.sh --local               # 装本仓库当前源码(link: 挂载,开发用)
  ./install.sh --dsh /path/to/dsh    # dsh 不在 PATH 上时显式指定
  ./install.sh --dry-run             # 只打印将要执行的命令
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile 需要值}"; shift 2 ;;
    --local) MODE="local"; shift ;;
    --dsh) DSH_BIN="${2:?--dsh 需要值}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then say "  [dry-run] $*"; else say "  \$ $*"; "$@"; fi
}

say "dsh-zcode-rewind 安装"
say "  profile : $PROFILE"
say "  来源    : $([ "$MODE" = local ] && echo "本仓库源码（link: $REPO_DIR）" || echo "npm 上的最新版")"

# ── 前置自检 ────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  say "✗ 找不到 node（本插件需要 Node ≥ 20）"; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "✗ Node $NODE_MAJOR 太旧，需要 ≥ 20"; exit 1
fi
say "  node    : $(node -v)"

if ! command -v "$DSH_BIN" >/dev/null 2>&1; then
  say "✗ 找不到 dsh（试过：$DSH_BIN）"
  say "  若 dsh 装在某处但不在 PATH：./install.sh --dsh /path/to/dsh"
  exit 1
fi

DSH_VERSION="$("$DSH_BIN" --version 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
say "  dsh     : ${DSH_VERSION:-（无法读取版本）}"

# 兼容性:与本包声明的区间核对(与 tools/verify-version-consistency.mjs 同一套判定)
if [ -n "$DSH_VERSION" ] && command -v node >/dev/null 2>&1; then
  if ! node "$REPO_DIR/tools/verify-version-consistency.mjs" --dsh "$DSH_VERSION" >/dev/null 2>&1; then
    say ""
    say "✗ 停下：dsh $DSH_VERSION 不在本包声明的兼容区间内。"
    node "$REPO_DIR/tools/verify-version-consistency.mjs" --dsh "$DSH_VERSION" 2>&1 | sed 's/^/    /' || true
    say "    这不是安装故障，而是**声明与事实不符**：本包没在你这版 dsh 上验证过。"
    say "    两条正路：升级/降级 dsh 到区间内；或到本仓库开 issue 报告你的版本。"
    say "    脚本不提供跳过开关 —— 明知不兼容还装进去，只会让后面更难查。"
    exit 3
  fi
  say "  兼容性  : ✓ 在声明区间内"
fi

# ── 安装 ────────────────────────────────────────────────────────────────────
if [ "$MODE" = local ]; then
  SPEC="link:$REPO_DIR"
else
  SPEC="$PKG"
fi

say ""
say "执行："
run "$DSH_BIN" plugin --profile "$PROFILE" add "$SPEC"

say ""
say "完成。接下来（这两步必须由你来）："
say "  1. 重启运行中的 dsh —— bundle 插件只在启动装配期生效；"
say "  2. 验证装配：$DSH_BIN --profile $PROFILE --dump-config | grep workspace-rewind"
say ""
say "工具会在新会话里出现：rewind_now / rewind_list / rewind_diff / rewind_restore / rewind_undo / rewind_status"
