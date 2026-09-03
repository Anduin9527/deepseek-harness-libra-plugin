# DeepSeek Harness Libra Memory Adapter

`@libra-tools/dsh-bundle` injects audited Libra project Memory into DeepSeek
Harness (DSH) model requests. DSH owns the AgentLoop and Session lifecycle;
Libra remains authoritative for Memory selection, ACL and sensitivity policy,
budgeting, receipt persistence, and prompt rendering.

This worktree targets:

- DSH `v0.1.2-alpha.1`, commit
  `cd5ef8148158c3a752a658978873241fdf8e2bbc`;
- Libra Agent Bridge protocol `1.1`, with `memory.recall` in the negotiated
  21-method list;
- Node.js `^22.19.0 || >=24.0.0`, matching the pinned DSH checkout.

It is a development integration and is not ready for npm publication. The
protocol authority receipt intentionally remains `UNRELEASED` until the
corresponding Libra change has a fixed commit.

## Runtime boundary

The public Cordis interface is deliberately small:

```ts
export const name = "@libra-tools/dsh-bundle";
export const inject = ["agents", "sessions"];
export const Config = z.object({
  libraExecutable: z.string(),
  repositoryRoot: z.string(),
});
export async function apply(ctx, config): Promise<AsyncDisposer>;
```

Configuration has two optional values:

| Field | Resolution |
| --- | --- |
| `libraExecutable` | Config, then `LIBRA_BINARY`; must resolve to an absolute executable file |
| `repositoryRoot` | Config, then `LIBRA_REPO`, then `process.cwd()`; canonicalized at startup |

One plugin composition owns one long-lived
`libra agent bridge --stdio` child. The adapter verifies protocol negotiation,
tracks existing and newly created DSH sessions, opens Libra sessions lazily,
and closes only sessions that DSH actually disposes.

On the first accepted AgentLoop step, the adapter extracts accepted
user-sourced text and calls:

```json
{
  "method": "memory.recall",
  "params": {
    "session_id": "dsh-session-id",
    "query_text": "accepted user query"
  }
}
```

The returned `prompt_section` is hash-verified and appended as one
`libra-memory` user message with receipt, view, bundle, selection, and budget
metadata. The same byte sequence enters the DSH session log and model request.
After compaction or overflow retry, `replaceGeneration` triggers at most one
refresh for that turn and generation.

Transport, protocol, scope, Memory, and hash errors stop the model call.
`delivery: null` and a zero-hit delivery are the only no-Memory success
paths. The adapter does not re-render, sort, trim, or redact Libra's returned
section.

## Current MVP scope

Included:

- real Cordis Loader, Session, and AgentLoop integration;
- audited Memory recall and exact message injection;
- compaction-generation and request-retry refresh hooks;
- resume/HMR session seeding and tracked disposal;
- FIFO bridge transport, stderr draining, timeout handling, and child shutdown.

Deferred:

- full DSH event projection and an outbox;
- model-visible Libra tools;
- workspace/UI integration;
- automatic Episode generation;
- same-turn query regeneration after steering;
- npm publication.

Legacy packages for those deferred surfaces remain in the monorepo for now,
but the published bundle does not compose or export them.

## DSH plugin authority

There is no verified standalone plugin-template repository owned by the
`deepseek-ai` GitHub organization at the pinned revision. This adapter follows
the first-party [plugin tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/user/develop/basic/index.md),
[configuration contract](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/user/develop/basic/config.md),
[bundle/install contract](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/user/develop/basic/publish.md),
and exact Cordis source instead. Community templates were reviewed for useful
pack/test conventions, but they are not treated as runtime authority.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
```

The default Vitest suite uses a deterministic bridge process. It does not
substitute for the pinned DSH runtime gate.

All installs, builds, packs, and tests for this worktree are run in the Libra
development container. `pnpm pack:bundle` produces the standalone nested
bundle tarball used by `dsh plugin add`. The repository root remains a private
workspace package, so direct GitHub-root installation is not supported in this
MVP; use the packed tarball until the separate npm/repository-facade release
slice.

## Pinned DSH runtime gate

Prepare a source checkout at the exact commit above, run its frozen install and
build, then build this plugin. The integration runner packs the standalone
bundle, creates a fresh `DSH_HOME`, installs it through the real
`dsh plugin --profile headless add <tarball>` path, verifies profile
reconciliation and patch composition, and runs the installed artifact through
the real DSH Loader and AgentLoop:

```bash
DSH_CHECKOUT=/absolute/path/to/deepseek-harness \
LIBRA_BINARY=/absolute/path/to/libra \
LIBRA_REPO=/absolute/path/to/initialized/test-repo \
LIBRA_GATE_QUERY=libradshlivegatefact \
LIBRA_GATE_EXPECTED_SUBSTRING=cobalt-orchid-7319 \
pnpm test:integration
```

The Libra test repository must already contain one admissible Memory fixture.
The companion Libra ignored test
`external_dsh_fixture_seeds_real_repository` writes it through the real
`MemoryWriter` without adding a production write endpoint.

For one live acceptance with `deepseek-v4-flash`, keep the key in an owner-only
file inside the development container and pass only its path to the runner:

```bash
DEEPSEEK_API_KEY_FILE=/cache/libra-secrets/deepseek-api-key \
DSH_CHECKOUT=/absolute/path/to/deepseek-harness \
LIBRA_BINARY=/absolute/path/to/libra \
LIBRA_REPO=/absolute/path/to/initialized/test-repo \
LIBRA_GATE_QUERY=libradshlivegatefact \
LIBRA_GATE_EXPECTED_SUBSTRING=cobalt-orchid-7319 \
pnpm test:integration -- --live
```

The keyless gate asserts that the installed artifact is active in the profile,
the Memory source is present in the DSH session, the model request uses the
identical text, and the exact receipt is durably present in Libra's database.
On the live path the runner boots the standard installed `headless` profile,
which uses `deepseek-v4-flash`, and asserts that its final assistant text equals
the fact available only from the seeded Memory. The key value is read only by
the runner and is never passed to install or profile-composition children.

## License

MIT — see [LICENSE](LICENSE).
