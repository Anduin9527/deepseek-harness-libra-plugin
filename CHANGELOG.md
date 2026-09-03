# Changelog

## Unreleased — DSH × Libra Memory MVP (2026-08-30)

- reduced the public runtime to a Memory-only Cordis adapter backed by Libra's
  audited `memory.recall` method in Agent Bridge protocol `1.1`;
- pinned DeepSeek Harness `v0.1.2-alpha.1` at
  `cd5ef8148158c3a752a658978873241fdf8e2bbc`;
- added a self-contained bundle tarball and a fresh-profile gate that exercises
  real `dsh plugin add`, profile composition, Loader/AgentLoop injection, and
  durable receipt verification;
- passed a live acceptance through the installed standard `headless` profile
  and its `deepseek-v4-flash` model;
- bound durable sessions to Libra's resolved repository/worktree scope and
  retire prior visible Memory bodies before a zero-hit/null or refreshed recall;
- deferred npm publication, direct installation from the monorepo root, tools,
  UI, outbox, and event projection until after the Memory recall closure.

This is not a publish declaration. The Libra protocol authority revision is
still `UNRELEASED`, and the package version remains `0.1.0`.

## Historical — REL-TS-02 implementation slice (2026-08-24)

- refreshed the Libra Agent Bridge v1 fixture and authority receipt for Libra `0.21.22`;
- hardened bridge environment, UTF-8 frame/result validation, handshake checks, and child crash handling;
- added durable outbox corruption/path/quota protection and server ack/per-event replay handling;
- aligned typed tools, mutation operation IDs, approval decisions, workspace owner/fence leases,
  context injection, compaction resume, UI card quotas, and bundle lifecycle disposal;
- replaced floating DSH integration resolution with explicit pinned `DSH_CLI`/revision gates and
  temporary staging;
- recorded local verification and the remaining real Libra/DSH gates as `remote-pending` in
  `docs/release-evidence-REL-TS-02.md`.

This is not a publish declaration. The package version remains `0.1.0` until the fixed external
contract and clean-profile release gates are complete.

## 0.1.0 — 2026-08-24

- Initial `@libra-tools/dsh-bundle` release for DeepSeek Harness `dsh-v0.1.0-rc.7`.
- Protocol receiver for Libra agent bridge v1.
- Bridge client, session projection/outbox, tools facade, workspace binding, context injection, and UI cards.
