# Workspace modes

| Mode | Behavior |
| --- | --- |
| `linked` | Linked worktree sharing common storage with scoped HEAD |
| `isolated` | Isolated worktree scope |
| `readonly` | Read-only workspace lease |

Actor identity is always `deepseek-harness:<session_id>` or `deepseek-harness:<agent_id>` from the authenticated bridge session. Model parameters cannot override actor, repository root, or lease fence.
