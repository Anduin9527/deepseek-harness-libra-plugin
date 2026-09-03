# MEM-DSH-01 implementation evidence (2026-08-30)

This is a Docker-only implementation receipt, not a publish receipt. Both the
Libra and plugin worktrees remain uncommitted, and the Libra protocol authority
revision remains `UNRELEASED` until the corresponding Libra change is reviewed
and committed.

## Fixed authorities

| Field | Value |
| --- | --- |
| DSH release | `v0.1.2-alpha.1` |
| DSH commit | `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| Libra bridge | protocol `1.1`, Libra `0.21.25`, revision `UNRELEASED` |
| Protocol source SHA256 | `60ed0117473332e701f57019501855a3a47126cb11a3ecf69541c8c2ace8ecab` |
| TypeScript fixture SHA256 | `f60701ecf7a555ea3b830d903edb75b02048296f2b28bcd897147f484e28d39c` |
| Bundle | `@libra-tools/dsh-bundle@0.1.0` development tarball |
| Execution environment | `libra-dev-anduin` on leris; no local build or install |

The pinned DSH repository does not contain a standalone official plugin-template
repository. Its first-party plugin tutorial, package manifests, profile CLI, and
Cordis implementation are the API and packaging authority used by this slice.

## Verification results

### Plugin regression gate

From `/workspace/libra/.dsh-plugin-dev` inside the container:

```text
pnpm check
```

Result: lint passed, TypeScript project references passed, 8 test files passed
and 2 were intentionally skipped, 64 tests passed and 2 were intentionally
skipped, and the distribution build passed.

### Packed fresh-profile gate

The integration runner was given only the pinned DSH checkout, the PR-head Libra
binary, an isolated initialized repository, and the query/fact fixture values:

```text
DSH_CHECKOUT=/cache/dsh-alpha1
LIBRA_BINARY=/cache/cargo-target/debug/libra
LIBRA_REPO=/tmp/libra-dsh-memory.IpaNcR
LIBRA_GATE_QUERY=libradshlivegatefact
LIBRA_GATE_EXPECTED_SUBSTRING=cobalt-orchid-7319
pnpm test:integration
```

The runner:

1. packed the nested bundle and asserted its installed runtime file closure;
2. created a fresh `DSH_HOME` and ran real `dsh plugin add`;
3. asserted both the profile dependency and `dsh.profile.bundles` activation;
4. composed the profile and loaded the installed artifact through the pinned
   real Loader, Session, and AgentLoop;
5. asserted that the session log and model request received the exact Libra
   prompt section and source metadata;
6. correlated the returned receipt id, budget, selection count, and bundle hash
   with a read-only exact-id query against the Libra receipt store.

Final receipt metadata from the refreshed gate:

```json
{
  "receiptId": "01a052b4-20eb-7d51-b4f3-d0f7a999afc4",
  "bundleHash": "sha256:a4153a3e5d1270e21df0215bf896e2033bccaef8b46b047ae9efb42584f75ec0",
  "selectedCount": 1,
  "tokenBudget": 1600
}
```

The final sanitized runner result was:

```json
{
  "kind": "libra-packaged-profile-gate",
  "dshCommit": "cd5ef8148158c3a752a658978873241fdf8e2bbc",
  "bundle": "@libra-tools/dsh-bundle",
  "profileInstalled": true,
  "profileComposed": true,
  "runtimeInjected": true,
  "receiptPersisted": true
}
```

### Live DeepSeek acceptance

The DeepSeek key remained in
`/cache/libra-secrets/deepseek-api-key` inside the development container. The
runner received only that file path, read the value in-process, and injected it
only into the live DSH child. It was not copied locally, printed, or passed to
install, composition, or keyless test processes. The expected fact was removed
from the live child environment and used only by the parent as an oracle.

The same tarball/fresh-profile path then ran the standard installed `headless`
profile. Its configured `deepseek-v4-flash` model's final assistant stdout was
required to equal, not merely contain, the fact that existed only in the seeded
Libra Memory. The runner emitted only this sanitized result:

```json
{
  "kind": "libra-live-profile-acceptance",
  "model": "deepseek-v4-flash",
  "installedThrough": "dsh plugin add",
  "answerMatched": true
}
```

### Libra-side gates

The related Libra change was also verified only inside the same Docker
development environment: formatting and all-target/all-feature Clippy passed;
the focused Agent Bridge integration suite passed 65 tests; the audited Memory
delivery and bridge tests passed; and the ignored test-only fixture wrote the
admissible Memory through the real `MemoryWriter` into the isolated repository.
The final scope regression additionally passed all 10 ingress tests, including
cross-worktree reopen/close/append rejection against one shared database.
This receipt does not claim a full unfiltered `cargo test --all` run.

### Independent worktree review

The final read-only reviews used plugin baseline
`49d2e31c31eac82ccc8df3b0be85aed435786bf8` and all current uncommitted files:

- Standards: PASS, zero blocking findings;
- Memory MVP spec: PASS, zero blocking findings;
- Libra scope/correctness follow-up: PASS; the cross-worktree P1 was closed.

One non-blocking diagnostic tradeoff remains: the bridge client continuously
drains but does not retain child stderr, so a child that exits before returning
a structured bridge error reports only exit code/signal. Retaining diagnostics
is deferred until it can be bounded and sanitized without weakening the Memory
error privacy contract.

## Proven boundary

This evidence proves the Memory MVP as an installable DSH plugin artifact:

- Libra remains authoritative for selection, policy, budget, rendering, and
  receipt persistence;
- DSH installs and composes the bundle through its real profile CLI;
- the installed Cordis adapter recalls and injects the exact audited section
  before the model request;
- refreshed, zero-hit, and null deliveries retire any previously visible Memory
  body from the DSH surface without rewriting the append-only session log;
- the standard DSH profile can obtain a real DeepSeek model response grounded in
  that Memory.

It does not claim npm publication, direct install from the monorepo GitHub root,
a frozen Libra commit authority, generated upstream DSH types, or real-Cordis
coverage of every compaction/retry/HMR edge. Those remain later release-hardening
tasks rather than blockers for the basic recall closure.
