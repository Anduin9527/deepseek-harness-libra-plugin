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

## Memory module extension

The Memory recall module has an additional validated combination:

| Surface | Memory module value | Evidence/state |
| --- | --- | --- |
| Libra Agent Bridge | protocol `1.1`, Libra `0.21.25` development revision | `protocol/agent-bridge.v1.receipt.json` |
| DeepSeek Harness | `v0.1.2-alpha.1`, commit `cd5ef8148158c3a752a658978873241fdf8e2bbc` | real profile install and Loader/AgentLoop gate |
| Live model | `deepseek-v4-flash` | `docs/release-evidence-MEM-DSH-01.md` |

This table records the Memory module slice only; it does not replace the plugin's
existing compatibility record above.
