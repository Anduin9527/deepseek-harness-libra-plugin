# DeepSeek Harness Libra Plugin

TypeScript monorepo for `@libra/dsh-bundle`, a DeepSeek Harness profile plugin that talks to
Libra through `libra agent bridge --stdio` (JSON-RPC NDJSON).

## Packages

| Package | Role |
| --- | --- |
| `@libra/dsh-protocol` | Consumes the Libra bridge contract fixture (`DEP-LB-01`) |

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm build` compiles all packages and produces a profile-installable bundle under
`.profile-bundle-staging/` (via `node scripts/stage-bundle-for-profile.mjs`).

## Profile install

```bash
pnpm build
pnpm test:integration -- --profile libra
# or manually:
npx @deepseek-ai/dsh plugin --profile libra add file:$(node scripts/stage-bundle-for-profile.mjs)
npx @deepseek-ai/dsh --profile libra --dump-config
```

Bridge integration tests use Libra built from `/Volumes/Data/GitMono/libra`
(`LIBRA_BINARY` env override supported).

## Protocol authority

Libra Rust bridge (`REL-LB-01`) is the only authoritative source for methods, limits, error
codes and handshake semantics. This repository stores a versioned receiver fixture under
`protocol/agent-bridge.v1.schema.json` and derives TypeScript types from it.
