# @libra/dsh-protocol

TypeScript **receiver** for the Libra agent bridge contract (`DEP-LB-01`).

## Responsibilities

- Load `protocol/agent-bridge.v1.schema.json` from the repository root.
- Validate the fixture shape at runtime (methods, limits, `protocol_version`, error catalogue).
- Expose typed helpers for downstream packages (`bridge-client`, `session`, `tools`, …).

## Blocked strategy

When the fixture file is **missing** or **zero bytes**, the receiver returns `{ status: "blocked" }`
instead of inventing a parallel server schema. Downstream cards must treat that as `GAP-09` /
`DEP-LB-01` not yet materialized and must not mark real bridge integration complete.

When the fixture is present, TypeScript types and runtime checks are derived **only** from that
file. Libra Rust (`src/internal/ai/agent_bridge/protocol.rs`) remains the protocol authority;
if the fixture and Rust constants diverge, refresh the fixture from `REL-LB-01` evidence rather
than patching TypeScript semantics locally.

## Usage

```ts
import { assertSupportedProtocolMajor, loadProtocolReceiver } from "@libra/dsh-protocol";

const receiver = loadProtocolReceiver();
const contract = assertSupportedProtocolMajor(receiver, { major: 1, minor: 0 });
console.log(contract.methods.length); // 20
```
