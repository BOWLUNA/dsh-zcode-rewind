# Security Policy

[English](./SECURITY.md) | [简体中文](./SECURITY.zh.md)

> This plugin writes file contents to disk by design. Treat its store as sensitive.

## Supported versions

| Version | Supported |
| --- | --- |
| `1.0.0` | Supported |
| `< 1.0.0` | Not supported — please update |

## Reporting a vulnerability

- Open a private GitHub security advisory on this repository.
- Include the plugin version, the dsh version, and a redacted ledger excerpt.
- Never paste real credentials or key material into the report.
- Expect an initial reply within a few days; this is a spare-time project.

## Data handling

- Files whose names match `secretNames` are **never** content-captured: only the fact of their change is recorded.
- Contents are stored **uncompressed and unencrypted**, because a restore must work when nothing else can read the disk.
- The store lives outside the workspace, under `$DSH_HOME/workspace-rewind/`, and is excluded from its own captures.
- A restore plan keeps content-unknown paths untouched; it never guesses their history or deletes them.

## Not a vulnerability

- Being able to read the store as the same user who can already read the workspace files.
- A restore plan reporting "kept as is" for a secret-named or oversized file.
- Records surviving after the plugin is uninstalled — `uninstall.sh` keeps the store until you pass `--purge --yes`.
