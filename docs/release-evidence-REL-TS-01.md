# REL-TS-01 release evidence (TS-09)

| Field | Value |
| --- | --- |
| Package | `@libra-tools/dsh-bundle@0.1.0` |
| Protocol fixture | `protocol/agent-bridge.v1.schema.json` (libra `0.21.0`) |
| Fixture SHA256 | `efaf94ec6ad90df2a677b0683fe392c5804d2b318295700cf6a78d59e91cbf6a` |
| Harness revision | `dsh-v0.1.0-rc.7` / `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` |
| Libra binary | `/Volumes/Data/GitMono/libra/target/release/libra` (`0.21.0`) |
| Staging tarball | `libra-tools-dsh-bundle-0.1.0.tgz` via staging script + `npm pack --dry-run` |
| Tarball SHA256 | `629e991196980a48d0169a0cf062ce68c8dcc8c2` (npm shasum, 30.8 kB) |
| Publisher | `genedna` |
| npm registry | https://www.npmjs.com/package/@libra-tools/dsh-bundle |
| DEP-TS-01 handoff | published `@libra-tools/dsh-bundle@0.1.0` to npm (2026-08-24) |

## Verification matrix (2026-08-24)

| Gate | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass (51 tests) |
| `pnpm test:contract -- --protocol-version 1` | pass |
| `pnpm test:contract -- --libra-release REL-LB-01` | pass |
| `pnpm test:contract -- --events` | pass |
| `pnpm test:contract -- --tools` | pass |
| `pnpm test:contract -- --workspace` | pass |
| `pnpm test:integration -- --profile libra` | pass (`dsh plugin add` + `--dump-config`) |
| `pnpm build` | pass (tsc + esbuild bundle dist) |
| Claude Review TS-01..TS-09 | PASS |

## Install path

```bash
pnpm build
node scripts/stage-bundle-for-profile.mjs
dsh plugin --profile libra add file:.profile-bundle-staging
dsh --profile libra --dump-config
```

Peer dependency: `@deepseek-ai/cordis` (provided by Harness runtime).

## Remote-pending (non-blocking)

- npm registry publish and publisher identity registration (ER-12).
- Harness `headless`/`web` profile integration gates (`--context`, `--ui`) not run in this slice.
