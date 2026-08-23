# Context injection

`@libra/dsh-context` queries `libra_context` through the tools facade and injects a bounded summary (≤ 4 KiB / 1,500 tokens per turn) with `anchor_id`, `schema_version`, and `source` metadata.

Compaction/fork/resume reuses parent anchors without re-fetching full transcripts.
