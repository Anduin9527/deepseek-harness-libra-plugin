# Workspace modes

> Deferred legacy design. The current Memory-only bundle accepts no client
> workspace/lease parameters and uses the Libra bridge process's server-side
> repository/worktree scope.

| Mode | Behavior |
| --- | --- |
| `linked` | Linked worktree sharing common storage with scoped HEAD |
| `isolated` | Isolated worktree scope |
| `readonly` | Read-only workspace lease |

The bridge derives owner identity from the authenticated session. The TypeScript client sends
`path`, returned `workspace_id`, `owner`, `fence`, and optional `lease_ttl_ms` according to the
Rust contract; it does not send a model-controlled actor credential. Model parameters cannot
override owner, repository root, or lease fence.
