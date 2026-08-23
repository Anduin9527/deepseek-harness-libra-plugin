# Security defaults

- Bridge-only writes; no direct `.libra` database access from TypeScript.
- Actor and workspace identity come from bridge handshake and session lineage.
- Dangerous tools default to deny until Harness approval policy enables them.
- Redaction fail-closed for session projection (see `docs/privacy.md`).
