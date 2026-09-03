# Security defaults

- Bridge-only writes; no direct `.libra` database access from TypeScript.
- Actor and workspace identity come from bridge handshake and session lineage.
- Dangerous tools default to deny until Harness approval policy enables them.
- Redaction fail-closed for session projection (see `docs/privacy.md`).

The Memory module accepts no client-supplied actor, repository, selector, ACL, or
budget. Libra derives the agent principal from the opened DSH session and applies
the repository's Memory policy before returning a prompt section.
