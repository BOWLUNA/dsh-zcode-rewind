# AGENTS.md — repository contract for coding agents

Read this before changing anything. It records invariants that were **paid for** with real
failures; each one exists because breaking it cost time or data.

## What this repository is

`dsh-zcode-rewind` is a **host-plane** plugin for DeepSeek Harness (DSH) with **no client UI**:
it registers agent tools and hooks the `fs` service's tool-execution events. It has **zero runtime
dependencies** and no build step. Everything under `lib/` is plain ESM for Node ≥ 20.

## Hard rules (do not break these)

1. **`lib/` must contain no bare imports.** `lib/index.js` imports only `node:*` builtins and
   relative `./*.js` files; the `@deepseek-ai/*` peers are resolved through a multi-anchor
   `createRequire` (own location → `$DSH_ROOT` → `process.execPath`-derived global install).
   Why: a `link:`-installed plugin resolves a bare specifier from the **repository's real path**,
   which has no `node_modules`. A plugin that imports `@deepseek-ai/schemastery` directly dies at
   **startup assembly** with `Cannot find package` — while `--dump-config` stays exit 0 / stderr 0
   and looks perfectly healthy. Verified on DSH 0.1.6-alpha.2.
2. **Never wrap tool registration in `ctx.effect`.** The official pattern is a direct
   `ctx.tools.register(defineTool({...}))` inside `apply()`; the registry is already effect-scoped.
   Wrapping it made registrations **silently not happen** on 0.1.6-alpha.2 — no error on stderr,
   only in the harness logger.
3. **Declare every service you touch in `export const inject`.** Missing it fails startup with
   `cannot get property "tools" without inject`.
4. **`--dump-config` does not prove the plugin loads.** It composes configuration without applying
   plugins. Only a real `--port` boot (or a `--patch` probe on a live instance) reveals tool-name
   collisions, missing `inject`, and resolution failures. Every change to `lib/index.js` or
   `cordis.patch.yml` needs a real boot before you call it done.
5. **Never overwrite an existing row of the host composition.** `cordis.patch.yml` may only
   `insert` our own row. Do not `disabled:` a base row, and never point a base service at a
   different provider — that changes fleet-wide behaviour for everyone.
6. **The row id `workspace-rewind` must stay unique** and equal the plugin's exported `name`.
   A duplicate id is a **startup hard failure**.
   The row's `name` field is a *different* thing: it is the **package name**, which the loader
   resolves as a module specifier **from the profile directory** while applying the tree — so it
   must match `package.json`'s `name` exactly. Renaming the package and missing that one field ships
   a plugin that installs cleanly, passes 73 unit tests and produces `--dump-config` with exit 0 and
   an empty stderr, and then **takes the whole profile down at boot**:
   `Cannot find package 'dsh-workspace-rewind' imported from …/profiles/web/`.
   `--dump-config` can never catch this (it composes configuration without applying plugins, and a
   failed row resolution leaves no trace in the dump). `tools/boot-check.mjs` exists for it, and
   **on rename, check four places at once**: `package.json` name / repository name / the row `name`
   here / directory name.
7. **Secret-named paths are never content-captured.** `.env`, `*.pem`, `*.key`, `id_rsa*`,
   `.credentials.yaml` and friends are recorded as *events* (`secret: true`, `h: null`). Never
   store their bytes, and never let a restore plan delete them: in the ledger fold, a `null` hash
   from a content-less entry must be treated as **unknown**, not as "did not exist" — the latter
   once produced a plan that would have deleted a live `.env`.
8. **A restore must always be undoable.** `applyRestore` writes a `rescue` record *before* touching
   the filesystem, and `restore`/`rescue` records are exempt from quota eviction. Removing either
   property breaks the "rewind is itself reversible" promise.
9. **Credentials never enter the repo, logs, fixtures, or issue text.** Reference the variable
   name only (`DEEPSEEK_API_KEY`), never a value.
10. **Do not widen the declared compatibility range beyond what was tested.** `engines.dsh` and the
    dsh peers list the versions this plugin has actually run on. Remember node-semver's prerelease
    rule: `>=0.1.2-alpha.1` can never match `0.1.6-alpha.1`; a comparator must share the version's
    `major.minor.patch` tuple. `tools/verify-version-consistency.mjs --dsh <version>` enforces this.

## The three guards (order is part of the contract)

```bash
node test/run.mjs                                   # 1) tests and check counts
node tools/verify-translation-pairing.mjs --write    # 2) re-record bilingual pair hashes
node tools/verify-doc-numbers.mjs                    # 3) documented numbers vs the real run
bash -n install.sh && bash -n uninstall.sh           # 4) shell syntax
node tools/verify-version-consistency.mjs --dsh <version>   # 5) requires --dsh; bare run exits 1 by design
node tools/boot-check.mjs --port 31860              # 6) installs into a throwaway DSH_HOME and boots it
```

Two rules: **run all of them** (missing one turns CI red), and **verify the guards can fail** —
run them against a mutated copy with a known defect injected before trusting them.

Guard 6 is the only one that applies the plugin to a real harness. Guards 1–5 all pass on a plugin
that cannot start; see invariant 6 for the measured case. It needs `pnpm` on PATH and a harness in
`node_modules/@deepseek-ai/dsh` (CI installs both).

Current reality: **2 suites, 73 checks**. If you change either number, update `README.md`,
`README.zh.md`, `AGENTS.md`, `CONTRIBUTING.md` and `test/README.md`, then re-run guards 2 and 3.

## Documentation rules

- Bilingual pairs are **authoritative in both languages**; edit both, then `--write`.
- A pair is checked for hash drift, cross-language links, language purity, **and structural
  parity** (heading levels, code fences, table rows, quotes, list items must match item by item).
- Numbers in docs are claims: `tools/verify-doc-numbers.mjs` compares them with the real run.
- Invariant 13 of the sibling project (every user-visible host result carries a `code` plus
  `params`, and the page renders it from its own bilingual dictionary) is **not applicable here**:
  this plugin has no client and no HTTP route, so nothing it returns is rendered by a page.
  If a client is ever added, that rule applies from the first commit.

## Working discipline

- One change at a time; report and stop.
- Records are not evidence — re-measure. If a record contradicts reality, correct the record.
- Destructive operations (deleting a store, rewriting a ledger) need a stated blast radius first.
- No `push --force`, no `reset --hard`, no global git config writes.
