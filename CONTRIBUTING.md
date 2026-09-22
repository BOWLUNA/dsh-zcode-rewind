# Contributing

[English](./CONTRIBUTING.md) | [简体中文](./CONTRIBUTING.zh.md)

> Read `AGENTS.md` first — it lists the invariants this repository will not trade away.

## Getting started

```bash
git clone https://github.com/BOWLUNA/dsh-zcode-rewind
cd dsh-zcode-rewind
node test/run.mjs          # 2 suites, 73 checks — no DSH needed
```

## The three guards

```bash
node test/run.mjs
node tools/verify-translation-pairing.mjs --write
node tools/verify-doc-numbers.mjs
bash -n install.sh && bash -n uninstall.sh
node tools/verify-version-consistency.mjs --dsh 0.1.6-alpha.2
node tools/boot-check.mjs --port 31860        # needs pnpm and a harness install
```

A change is not finished until every guard is green, and until you have confirmed the relevant guard
can actually fail — run it against a copy with a known defect injected.

The boot guard is the only one that installs the plugin into a throwaway `DSH_HOME` and starts it.
Nothing else catches "installs cleanly, then takes the profile down at boot".

## Documentation rules

- Bilingual pairs are authoritative in both languages: edit both, then re-record the hashes.
- Numbers in documentation are claims; the guard compares them with the real run.
- Anything a change makes false — a count, a range, a version, a limitation — is part of the change.

## Pull requests

- One topic per pull request, with the reproduction command in the description.
- New behaviour needs an assertion, not just code.
- Say what you measured, with the command and the raw output.
- If you touched `lib/index.js` or `cordis.patch.yml`, boot a real instance before claiming success.

## Reporting bugs

- Use the issue templates; they ask for the versions and the store state we need.
- Never paste credentials — reference `DEEPSEEK_API_KEY` by name, never by value.
