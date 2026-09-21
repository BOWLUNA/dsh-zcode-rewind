# Publishing

[English](./PUBLISHING.md) | [简体中文](./PUBLISHING.zh.md)

> The full release chain, including the three post-publish checks that are easy to skip.

## Release checklist

```bash
node test/run.mjs
node tools/verify-translation-pairing.mjs --write
node tools/verify-doc-numbers.mjs
bash -n install.sh && bash -n uninstall.sh
node tools/verify-version-consistency.mjs --dsh 0.1.6-alpha.2

# bump the version in package.json, both READMEs, SECURITY.md and both CHANGELOGs,
# then re-run guards 2 and 3 — the numbers guard names every place that drifted.
git add -A && git commit -m "fix(x.y.z): …"
git tag -a vx.y.z -m "vx.y.z" && git push origin vx.y.z
gh run list --repo BOWLUNA/dsh-zcode-rewind --limit 6
```

## After the workflow reports success

- A green publish job does **not** mean the package reached npm: check `npm view <pkg> version` and allow a couple of minutes.
- Open the published tarball and confirm this round's strings are inside it — CI green only means "something was uploaded".
- Write a release record: version, commit, tag, workflow run id, propagation time, tarball fingerprints, leftovers.

## Market entries

| Market | How to submit | Threshold |
| --- | --- | --- |
| awesome-dsh-plugin (dshmarket.com, in-harness market) | PR editing `data/plugins/BOWLUNA__dsh-zcode-rewind.yml` | description must match the code; one entry per PR |
| dsh-market/dsh-market | automatic, from the repository description | none |
| 2BingLing/dsh.market | automatic, from description and topics | none |

## Two things to warn users about

- pnpm has a 24-hour release cooldown, so a bare install right after a release silently resolves to the previous version — pin `@x.y.z` to get the new one immediately.
- On a machine already serving sessions, upgrading the profile is the user's call, not a side effect of an iteration.
