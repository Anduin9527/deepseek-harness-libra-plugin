# Context injection

`@libra/dsh-context` queries Libra `context.get` through the tools facade and injects a bounded,
redacted summary (≤ 4 KiB / 1,500 tokens per turn) with `anchor_id`, `schema_version`, and
`source` metadata. The actual response buckets are `sessions` and `recent_checkpoints`; unknown
or legacy buckets are treated as generic bounded data.

Compaction/resume re-queries current context through the host adapter rather than copying a stale
parent anchor. If the DSH injection capability is unavailable, the result contains a warning and
does not claim successful host injection.

## Project Memory recall

Memory recall is an additional module and does not change `context.get`. Before an
accepted model turn, the bundle can call `memory.recall` with the DSH session id
and accepted user query. Libra returns the already filtered and rendered prompt
section together with receipt provenance; the plugin injects that section without
rewriting it.

The module refreshes its snapshot after DSH surface replacement so a compacted or
retried request does not depend on a stale Memory selection.
