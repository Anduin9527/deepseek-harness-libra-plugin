# Compatibility matrix

| Surface | Current value | Evidence/state |
| --- | --- | --- |
| Libra Agent Bridge | protocol `1.0`, Libra `0.21.22`, revision `b073f078fb67078729fb0a4975294e3ab2dbdefa` | `protocol/agent-bridge.v1.receipt.json` |
| Protocol source | `protocol.rs` SHA256 `fcf67d190ebf70bb7691ad9bb5f0e1febcff6416cfb5a243e460a4521957c0d5` | receipt; refresh before any authority change |
| Initialize golden frame | fixture SHA256 `b34ac2e5d9b17af4450508360c671845156a6808ebe491ec9a7036633065f753` | receipt |
| DeepSeek Harness | `dsh-v0.1.0-rc.7` | external CLI/runtime receipt `remote-pending` |
| Bundle | `@libra-tools/dsh-bundle@0.1.0` | local build/pack dry-run |

The TypeScript adapter does not update Libra Rust or silently follow a newer DSH
revision. A protocol or Harness change requires a new receipt, compatibility note,
focused tests, and a new release plan. Missing external binaries are reported as
`remote-pending`; fake bridge tests are not release evidence for the real gates.
