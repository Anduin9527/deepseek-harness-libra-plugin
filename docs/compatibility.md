# Compatibility matrix

| Surface | Current value | Evidence/state |
| --- | --- | --- |
| Libra Agent Bridge | protocol `1.1`, Libra `0.21.25`, revision `UNRELEASED` | `protocol/agent-bridge.v1.receipt.json`; freeze after the Libra change is committed |
| Protocol source | `protocol.rs` SHA256 `60ed0117473332e701f57019501855a3a47126cb11a3ecf69541c8c2ace8ecab` | authority receipt |
| Initialize golden frame | fixture SHA256 `b34ac2e5d9b17af4450508360c671845156a6808ebe491ec9a7036633065f753` | receipt |
| TypeScript protocol fixture | SHA256 `f60701ecf7a555ea3b830d903edb75b02048296f2b28bcd897147f484e28d39c` | authority receipt |
| DeepSeek Harness | `v0.1.2-alpha.1`, commit `cd5ef8148158c3a752a658978873241fdf8e2bbc` | real Docker profile install, Loader/AgentLoop, and live headless gate |
| Node.js | `^22.19.0 || >=24.0.0` | matches the pinned Harness package policy |
| Bundle | `@libra-tools/dsh-bundle@0.1.0` development tarball | installable with `dsh plugin add`; not published |

The adapter does not silently follow newer Libra or Harness revisions. A protocol
or Harness change requires a refreshed receipt, compatibility note, and the real
pack/profile gate. Current execution evidence is recorded in
`docs/release-evidence-MEM-DSH-01.md`; the older rc7 receipt is historical only.
