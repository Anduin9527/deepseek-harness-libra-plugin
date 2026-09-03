# Memory module compatibility — Harness v0.1.2-alpha.1

| Component | Pin |
| --- | --- |
| DeepSeek Harness | `v0.1.2-alpha.1` / `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| Libra bridge | protocol `1.1`, Libra `0.21.25`, revision `UNRELEASED` |
| Bundle | `@libra-tools/dsh-bundle@0.1.0` development tarball |
| Node.js | `^22.19.0 || >=24.0.0` |

This compatibility record applies to the Memory module. The gate runs in the
Libra Docker development container. It packs
the nested bundle, installs it into a fresh DSH `headless` profile through real
`dsh plugin add`, checks profile composition, loads the installed artifact through
the pinned Loader/AgentLoop, verifies the durable Libra receipt, and optionally
runs the profile's real `deepseek-v4-flash` model.

The Libra revision must replace `UNRELEASED` before publication. Direct GitHub-root
installation and npm publication are not claimed by this receipt.
