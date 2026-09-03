# Security defaults

> The tools, projection, approval, and outbox items below are deferred legacy
> design. The current bundle exposes only fail-closed audited Memory recall.

- Bridge-only writes; no direct `.libra` database access from TypeScript.
- Actor and workspace identity come from bridge handshake and session lineage.
- Dangerous tools default to deny until Harness approval policy enables them.
- Redaction fail-closed for session projection (see `docs/privacy.md`).
