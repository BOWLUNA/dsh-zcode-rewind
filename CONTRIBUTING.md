# Contributing

1. Fork, branch off `main`, keep PRs single-topic.
2. `npm test` must pass (offline smoke suite, 52 assertions). New behavior needs a new assertion in `tools/smoke.mjs`.
3. Zero-runtime-dependency is a hard rule — do not add dependencies. The built-in Myers diff and fingerprint walker exist for this reason.
4. Read `docs/DESIGN.md` §4 before touching the plugin assembly (`lib/index.js`): `ctx.effect` must not wrap tool registrations, and `export const inject` must list every service touched.
5. Commits: conventional style (`fix:`, `feat:`, `docs:`, `test:`).
