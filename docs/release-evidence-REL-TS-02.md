# REL-TS-02 implementation evidence (2026-08-24)

> Historical receipt, superseded for the Memory MVP by
> `docs/release-evidence-MEM-DSH-01.md`. Its rc7 and `remote-pending` statements
> describe the 2026-08-24 slice only.

This is an implementation receipt, not a publish receipt. The family release
remains pending until the fixed Libra binary/repository and pinned DSH host are
available; no external pass is inferred from the fake bridge tests.

| Field | Value |
| --- | --- |
| Package surface | `@libra-tools/dsh-bundle@0.1.0` (not bumped in this implementation slice) |
| Libra authority | revision `b073f078fb67078729fb0a4975294e3ab2dbdefa`, version `0.21.22` |
| Protocol source SHA256 | `fcf67d190ebf70bb7691ad9bb5f0e1febcff6416cfb5a243e460a4521957c0d5` |
| Golden initialize fixture SHA256 | `b34ac2e5d9b17af4450508360c671845156a6808ebe491ec9a7036633065f753` |
| TypeScript fixture SHA256 | `23512edd34cf8dac705d3b43213207efb8c858ce7480b56ec4824416661ee549` |
| Authority receipt | `protocol/agent-bridge.v1.receipt.json` |
| DSH target | `dsh-v0.1.0-rc.7` (external compatibility evidence: `remote-pending`) |
| Tarball allowlist dry-run | staged package: `dist/index.js`, `dist/index.js.map`, `dist/index.d.ts`, `dist/protocol/agent-bridge.v1.schema.json`, `dist/protocol/agent-bridge.v1.receipt.json`, `package.json`, `cordis.patch.yml` |
| Staged tarball dry-run | 7 entries, 48,587 bytes packed, npm shasum `7a5d443626a3a46c716d27296de92dd847b6a998` |

## Local verification

| Gate | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass: 54 tests; 2 real Libra tests skipped without explicit environment |
| `pnpm test:contract -- --protocol-version 1 --events --tools --workspace` | pass; real Libra flag not requested |
| `pnpm build` | pass; bundle dist and publish manifest generated |
| `npm pack --dry-run` in temporary staged bundle | pass; allowlist above |
| `git diff --check` | pass |
| `scripts`/`tests` floating `npx`/`pnpm dlx` scan | no matches |

## Remote-pending gates

The following commands are intentionally not reported as pass until their
inputs are supplied:

```bash
LIBRA_BINARY=/absolute/path/to/libra \
LIBRA_REPO=/absolute/path/to/initialized/libra-repo \
pnpm test:contract -- --protocol-version 1 --libra-release b073f078fb67078729fb0a4975294e3ab2dbdefa

DSH_CLI=/absolute/path/to/pinned/dsh-v0.1.0-rc.7 \
pnpm test:integration -- --profile libra --revision dsh-v0.1.0-rc.7 --context --ui
```

The tests do not fall back to an old absolute path, floating registry lookup,
or fake bridge result for these gates. Evidence must record executable/repository
SHA, DSH revision/CLI SHA, exact command, sanitized output, and a clean profile
install/load/dispose result before `REL-TS-02` can become a release receipt.
