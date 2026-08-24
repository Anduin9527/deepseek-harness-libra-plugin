# Context injection

`@libra/dsh-context` queries Libra `context.get` through the tools facade and injects a bounded,
redacted summary (≤ 4 KiB / 1,500 tokens per turn) with `anchor_id`, `schema_version`, and
`source` metadata. The actual response buckets are `sessions` and `recent_checkpoints`; unknown
or legacy buckets are treated as generic bounded data.

Compaction/resume re-queries current context through the host adapter rather than copying a stale
parent anchor. If the DSH injection capability is unavailable, the result contains a warning and
does not claim successful host injection.
