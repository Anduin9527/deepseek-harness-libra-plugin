# Libra tools (model-visible facade)

> Deferred legacy design. The current Memory-only bundle does not register or
> export model-visible Libra tools.

| Tool | Bridge method | Risk |
| --- | --- | --- |
| `libra_context` | `context.get` | read |
| `libra_status` | `status.get` | read |
| `libra_diff` | `diff.get` | read |
| `libra_history_search` | `history.search` | read |
| `libra_checkpoint` | `checkpoint.list` | read |
| `libra_checkpoint_create` | `checkpoint.create` | write |
| `libra_commit` | `commit.create` | write |
| `libra_review` | `review.run` | write |
| `libra_restore_checkpoint` | `checkpoint.restore` | restore |

Tool results are a single object: `{ schema_version, operation_id, status, data?, error?, warnings? }`.

Write and restore tools require Harness approval policy to enable.
