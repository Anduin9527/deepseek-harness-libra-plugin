# Harness UI cards

Cards expose bounded, redacted summaries for checkpoint, diff, commit, evidence, and approval states.
Commit/restore routes through the tools facade and the server-side Libra approval gate; the UI
approval action only records the operation decision that is sent with the subsequent mutation.
When the DSH UI capability is missing, card publication is reported as a warning rather than a
local ready state.

Actions carry `operation_id` for idempotent routing.
