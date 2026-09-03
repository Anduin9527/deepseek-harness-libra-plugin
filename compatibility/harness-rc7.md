# Harness compatibility — dsh-v0.1.0-rc.7

> Historical receipt. The current Memory MVP targets DSH `v0.1.2-alpha.1`; see
> `compatibility/harness-alpha1.md` and `docs/compatibility.md`.

| Component | Pin |
| --- | --- |
| DeepSeek Harness | `dsh-v0.1.0-rc.7` / `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` |
| Libra bridge | protocol v1 (`b073f078fb67078729fb0a4975294e3ab2dbdefa` / libra `0.21.22`) |
| npm bundle | `@libra-tools/dsh-bundle@0.1.0` |

Libra protocol source SHA256: `fcf67d190ebf70bb7691ad9bb5f0e1febcff6416cfb5a243e460a4521957c0d5`.
The pinned DSH CLI/runtime receipt is still `remote-pending`; local adapter tests do not
claim a real Harness lifecycle pass.

Upgrade policy: bump Harness only with an explicit compatibility note and refreshed contract fixture SHA.
