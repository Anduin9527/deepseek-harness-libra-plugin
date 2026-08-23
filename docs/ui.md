# Harness UI cards

Cards expose redacted summaries for checkpoint, diff, commit, evidence, and approval states. Read actions are auto-approved; commit/restore routes through the tools facade and Harness approval policy.

Actions carry `operation_id` for idempotent routing.
