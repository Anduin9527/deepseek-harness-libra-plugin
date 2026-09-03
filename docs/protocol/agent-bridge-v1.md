# Agent Bridge v1 — transport and handshake

## Transport

- One JSON-RPC 2.0 object per NDJSON line on stdout.
- Diagnostics only on stderr; stdout pollution is a protocol violation.
- Default request deadline: 30 seconds.
- Frame cap: 256 KiB per line; result and event limits are also checked as UTF-8 bytes.

## Handshake (`initialize`)

The client sends:

```json
{"jsonrpc":"2.0","method":"initialize","params":{"protocol":{"major":1,"minor":1}},"id":1}
```

The bridge returns capability negotiation: `protocol`, `limits`, `methods`, `source`.
Protocol major mismatch is fail-closed before any other method is accepted.

## Request terminal states

Each in-flight request ends in exactly one terminal state:

| State | Meaning |
| --- | --- |
| `success` | JSON-RPC result returned |
| `error_retryable` | JSON-RPC error with `data.retryable: true` |
| `error_fatal` | JSON-RPC error without retryability |

The `initialize` handshake request is recorded with the same terminal-state model as
subsequent bridge methods.

## Client constraints

The TypeScript client only spawns a configured `libra` executable with argv
`agent bridge --stdio`. Model-provided executables or argv are rejected at
configuration normalization.

## Current Memory method

After `session.open`, the Memory adapter calls `memory.recall` with only the DSH
session id and accepted user query. Libra owns query normalization, repository
scope, principal derivation, policy, selection, budget, rendering, and receipt
persistence. A successful non-null response carries the exact prompt section and
its receipt/view/bundle metadata; the adapter verifies the bundle hash before
injection. Protocol, scope, transport, or Memory failures stop the model turn.

## Deferred legacy surfaces

Event ingress, the durable TypeScript outbox, tools, UI, and general context
projection described by the older TS-03 design are not composed or exported by
the current Memory-only bundle. Their packages remain historical source material
until a separate design and release slice reactivates them.
