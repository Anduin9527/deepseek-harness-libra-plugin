# Template-aligned DSH × Libra Memory MVP

Date: 2026-08-30
Status: implemented, verified, and reviewed; awaiting owner review
DSH authority: `deepseek-ai/deepseek-harness@cd5ef8148158c3a752a658978873241fdf8e2bbc`

## What changed from the previous plan

The pinned DSH repository has no standalone official plugin-template
repository. Its first-party tutorials, package manifests, Cordis lifecycle,
and profile CLI are the authority. Community templates are useful examples for
packaging and CI, but not API contracts.

The existing Memory adapter already uses the correct DSH seams: a normal
Cordis plugin, `agents`/`sessions` service injection, accepted
`agent/pre-step` messages, `replaceGeneration`, `MessageSourceMap`, and an
async disposer. Rewriting that core would add churn without improving the
boundary.

The missing proof is the distribution path. The old gate copied a staged
module directly into a DSH test checkout. It proved runtime compatibility but
did not prove that DSH recognizes, installs, composes, and boots the artifact
as a bundle.

## Architecture decision

- Libra remains authoritative for Memory selection, ACL, sensitivity,
  budgeting, receipt persistence, and rendered prompt text.
- The DSH bundle remains a host-only lifecycle adapter. No UI, tools, outbox,
  Episode writer, or general DSH runtime moves into this MVP.
- The monorepo is not flattened during this slice. The nested bundle is built
  into a self-contained tarball and installed with `dsh plugin add`, which is a
  first-class official distribution path.
- Direct `github:libra-tools/deepseek-harness-libra-plugin` installation is a
  later repository-facade/release task because the repository root is a private
  workspace package rather than the bundle manifest.

## Execution plan

1. Align the bundle contract with first-party package conventions.
   - optional Schemastery fields must allow config → environment → default
     resolution;
   - bundle runtime closure must be self-contained except for DSH host peers;
   - manifest must expose the patch and carry Node/repository/discoverability
     metadata.
2. Produce an installable nested bundle artifact.
   - build `dist` in Docker;
   - stage `dist`, `cordis.patch.yml`, README, LICENSE, and the publish manifest;
   - run `pnpm pack` and inspect the resulting tarball through installation.
3. Add a fresh-profile gate against the exact DSH source revision.
   - create a fresh `DSH_HOME`;
   - run `dsh plugin --profile headless add <tarball>`;
   - assert the dependency and `dsh.profile.bundles` entry;
   - assert the composed plugin row, then boot the installed runtime rather
     than treating `--dump-config` as completion.
4. Preserve and strengthen the data-path gate.
   - run real Cordis Loader, Session, and AgentLoop with the installed artifact;
   - use the real Libra binary and seeded Memory repository;
   - assert exact session/model text and source hash;
   - verify the returned receipt id and metadata against the durable Libra DB.
5. Run one live product-path acceptance.
   - use the same installed fresh `headless` profile;
   - call its default `deepseek-v4-flash` model once;
   - ask for the fact available only in the seeded Memory and assert the answer.
6. Refresh current compatibility and evidence documents, run Docker-only
   regression gates, and stop before stage/commit/push for review.

## Acceptance

The MVP is proven only when all of the following hold in Docker:

- the packed artifact root declares `dsh.bundle` and contains every file in
  its runtime closure;
- real `dsh plugin add` activates it in a fresh profile;
- the fresh profile composes and boots successfully;
- an accepted DSH turn performs `memory.recall` before the model call;
- the session log and model request contain the exact Libra section and source;
- the exact receipt is committed with selector, budget, bundle hash, selection
  count, and reproducibility metadata;
- the standard headless profile's real DeepSeek response contains the unique
  Memory-only fact;
- lint, typecheck, unit tests, build, pack/profile gate, and relevant Libra
  checks pass without any local build or dependency installation.

## Deferred after the basic closure

- root GitHub-install facade or npm `0.2.0` publication;
- generated exact DSH dev types replacing the temporary hand-written shim;
- real-Cordis expansion of every compaction/retry/HMR edge test;
- plugin CI and registry metadata;
- Libra tools, UI, event projection, outbox, and automatic Episode generation.

These are tracked gaps, not prerequisites for proving the basic installed
Memory recall path.

## Verification outcome

The Docker-only gates completed on 2026-08-30:

- plugin lint, typecheck, 64 tests, and build passed;
- a fresh profile installed the packed artifact through real `dsh plugin add`;
- the installed tarball passed the pinned Loader/AgentLoop byte-equality and
  source-hash gate;
- hit-to-zero/null regression tests proved that prior visible Memory bodies are
  retired from the DSH surface while remaining auditable in the append-only log;
- sibling worktrees sharing one Libra database were rejected for session
  reopen and mutation;
- the returned receipt was verified by exact id against the Libra SQLite store;
- the installed standard `headless` profile called `deepseek-v4-flash` and
  returned exactly the Memory-only fact as its final assistant text.

See `docs/release-evidence-MEM-DSH-01.md` for the exact boundary. No local build,
dependency installation, stage, commit, push, npm publish, or API-key copy was
performed.
