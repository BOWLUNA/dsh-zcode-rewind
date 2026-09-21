# Security Policy

## Scope

This plugin snapshots workspace file contents into `$DSH_HOME/workspace-rewind/`.

## Data-handling guarantees

- Files whose names match `secretNames` (default: `.env`, `.env.*`, `*.pem`, `*.key`,
  `id_rsa*`, `id_ed25519*`, `.credentials.yaml`, `*.p12`, `*.pfx`) are **never**
  content-captured. Only the fact of their change is recorded.
- Contents are stored **uncompressed and unencrypted** by design (restore must work
  when nothing else can read the disk). Treat the store root as sensitive.
- The store lives outside the workspace and is excluded from its own captures.

## Reporting

Open a private GitHub security advisory, or contact the maintainer directly.
Please include the plugin version and a redacted ledger excerpt — never paste
real secrets into a report.
