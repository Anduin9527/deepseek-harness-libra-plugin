# Agent Bridge v1 — transport and handshake

## Transport

- One JSON-RPC 2.0 object per NDJSON line on stdout.
- Diagnostics only on stderr; stdout pollution is a protocol violation.
- Default request deadline: 30 seconds.
- Frame cap: 256 KiB per line; result and event limits are also checked as UTF-8 bytes.

## Handshake (`initialize`)

The client sends:

```json
{"jsonrpc":"2.0","method":"initialize","params":{"protocol":{"major":1,"minor":0}},"id":1}
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

## Event ingress and outbox (TS-03)

Harness session events are batched by `(session_id, event_seq)` and sent through
`event.append`. The plugin keeps a bounded, owner-only outbox under the Harness profile
storage seam; `last_acked_seq` and `per_event` statuses drive durable state. Accepted or
duplicate events are pruned, while conflict/rejected events remain bounded diagnostics.
Duplicate `(session_id, event_seq)` with the same digest is a successful replay; digest
conflicts are fail-closed. All frame, event, result, batch, outbox, and context limits use
UTF-8 encoded byte counts.
