# DeepSeek Harness Libra Plugin

`@libra-tools/dsh-bundle` is a [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) profile plugin that connects Harness sessions to [Libra](https://github.com/libra) through a typed JSON-RPC NDJSON bridge (`libra agent bridge --stdio`).

Harness owns the agent loop, session persistence, and approval policy. Libra owns repository state, checkpoints, workspace leases, and durable projections. This plugin is the TypeScript client and Cordis bundle that sits between them—it does not read `.libra/libra.db` or spawn arbitrary shell commands.

**npm:** [@libra-tools/dsh-bundle](https://www.npmjs.com/package/@libra-tools/dsh-bundle) · **Harness pin:** `dsh-v0.1.0-rc.7` · **Libra bridge:** protocol v1 (fixture from libra `0.21.0`)

## What it does

When you run DeepSeek Harness with the `libra` profile, the bundle:

1. Registers a Cordis layer (`libra`) that loads bridge-backed Libra integration.
2. Spawns `libra agent bridge --stdio` as a long-lived child process (fixed argv; model cannot override the executable).
3. Negotiates protocol v1 via `initialize`, then routes all Libra writes and queries through an allowlisted method set.
4. Projects Harness session events through a local outbox (redaction, batching, crash resume) before `event.append` / `session.flush` on the bridge.
5. Exposes typed tools (`libra_status`, `libra_commit`, …) with approval gates for write/restore operations.
6. Binds workspace leases and actor identity (`deepseek-harness:<session_id>`) so the model cannot forge provenance.
7. Injects bounded Libra context (history, evidence, skills) and renders redacted UI cards for checkpoint/diff/commit/evidence/approval states.

```
┌─────────────────────┐     NDJSON JSON-RPC      ┌──────────────────────────┐
│  DeepSeek Harness   │ ◄──────────────────────► │  libra agent bridge      │
│  (agent loop, UI,   │   stdin / stdout         │  --stdio (Libra 0.21+)   │
│   approval policy)  │                          └────────────┬─────────────┘
└──────────┬──────────┘                                       │
           │ @libra-tools/dsh-bundle                           │ Rust bridge
           │ (this repo)                                       ▼
           │                                    Libra storage, workspace,
           │                                    checkpoints, provenance
           ▼
     Local outbox, redaction,
     typed tools facade
```

## Requirements

| Component | Version / notes |
| --- | --- |
| Node.js | `>= 22` |
| DeepSeek Harness | `dsh-v0.1.0-rc.7` (`@deepseek-ai/dsh`) |
| Libra | `0.21.0+` with `agent bridge --stdio` |
| Repository | Libra-initialized worktree (`libra init`) |

Peer dependency at runtime: `@deepseek-ai/cordis` (provided by Harness).

## Install

### From npm (recommended)

```bash
npx @deepseek-ai/dsh plugin --profile libra add @libra-tools/dsh-bundle
npx @deepseek-ai/dsh --profile libra --dump-config
```

### From this monorepo (development)

The workspace `packages/bundle` manifest uses `workspace:*` dependencies and is not installable outside the monorepo. Build a self-contained staging artifact first:

```bash
pnpm install
pnpm build
node scripts/stage-bundle-for-profile.mjs
npx @deepseek-ai/dsh plugin --profile libra add file:.profile-bundle-staging
npx @deepseek-ai/dsh --profile libra --dump-config
```

Ensure the Libra binary is on `PATH`, or set `LIBRA_BINARY` when running integration tests / bundle runtime config.

## Model-visible tools

All tools map to contract methods only—no wildcard bridge access.

| Tool | Bridge method | Risk | Default |
| --- | --- | --- | --- |
| `libra_context` | `context.get` | read | allowed |
| `libra_status` | `status.get` | read | allowed |
| `libra_diff` | `diff.get` | read | allowed |
| `libra_history_search` | `history.search` | read | allowed |
| `libra_checkpoint` | `checkpoint.list` | read | allowed |
| `libra_review` | `review.run` | read | allowed |
| `libra_commit` | `commit.create` | write | denied until approval |
| `libra_restore_checkpoint` | `checkpoint.restore` | restore | denied until approval |

Tool results are always a single object: `{ schema_version, operation_id, status, data?, error?, warnings? }`. Bridge and transport failures surface as `status: "error"`—never silent empty success.

See [docs/tools.md](docs/tools.md) for approval policy and error mapping.

## Monorepo packages

Published artifact is only `@libra-tools/dsh-bundle`. Internal packages are compiled into the esbuild `dist/` bundle for profile install.

| Package | Role |
| --- | --- |
| `@libra-tools/dsh-bundle` | Cordis bundle entry, profile install surface |
| `@libra/dsh-protocol` | Loads `protocol/agent-bridge.v1.schema.json` (`DEP-LB-01` fixture) |
| `@libra/dsh-bridge-client` | NDJSON transport, handshake, `requestMethod` client |
| `@libra/dsh-session` | Event outbox, redaction, projection / flush / dispose |
| `@libra/dsh-tools` | Typed tools facade + approval binding |
| `@libra/dsh-workspace` | Workspace lease claim/renew/release, subagent scope |
| `@libra/dsh-context` | Context injection with token/byte budget |
| `@libra/dsh-ui` | Harness UI cards and action routing |

## Security and privacy defaults

- **Bridge-only:** no direct `.libra/` database or object store access from TypeScript.
- **Fail-closed:** protocol major mismatch, actor/lease conflict, redaction uncertainty, and forbidden model parameters (e.g. `actor`, `repository_root`, `database_path`) are rejected.
- **Redaction:** secrets and oversized payloads are blocked or stripped before outbox persistence and UI projection; failures retain diagnostic state instead of falling back to raw text.
- **Actor binding:** `deepseek-harness:<session_id>` is set by the plugin; model-supplied identity fields are ignored.

Details: [docs/security.md](docs/security.md), [docs/privacy.md](docs/privacy.md).

## Protocol authority

Libra Rust bridge (`REL-LB-01`) is the authoritative source for methods, limits, error codes, and handshake semantics. This repository stores a versioned receiver fixture at `protocol/agent-bridge.v1.schema.json` (sourced from libra `0.21.0`) and validates runtime behavior against it—not a second invented schema.

Transport summary: one JSON-RPC 2.0 object per NDJSON line on stdout; stderr for diagnostics; 256 KiB frame cap; 30 s default deadline.

See [docs/protocol/agent-bridge-v1.md](docs/protocol/agent-bridge-v1.md).

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

### Verification matrix

```bash
pnpm test:contract -- --protocol-version 1
pnpm test:contract -- --libra-release REL-LB-01
pnpm test:contract -- --events
pnpm test:contract -- --tools
pnpm test:contract -- --workspace
pnpm test:integration -- --profile libra
```

Libra integration tests expect a release binary at `libra/target/release/libra` (override with `LIBRA_BINARY`). Build Libra from the sibling repo when testing real handshake and contract flow.

## Documentation

| Topic | Path |
| --- | --- |
| Profile setup | [docs/profile.md](docs/profile.md) |
| Tools & approval | [docs/tools.md](docs/tools.md) |
| Workspace & subagent | [docs/workspace.md](docs/workspace.md) |
| Context injection | [docs/context.md](docs/context.md) |
| UI cards | [docs/ui.md](docs/ui.md) |
| Harness compatibility | [compatibility/harness-rc7.md](compatibility/harness-rc7.md) |
| Release evidence | [docs/release-evidence-REL-TS-01.md](docs/release-evidence-REL-TS-01.md) |
| Implementation plan | [docs/plan/plan-20260818.md](docs/plan/plan-20260818.md) |

## License

MIT — see [LICENSE](LICENSE).
