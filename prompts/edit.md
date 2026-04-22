Patch a UTF-8 text file using `LINE#HASH` anchors copied verbatim from `read`.

Submit one `edit` call per file. All operations for that file go in a single `edits` array; anchors within one call must all come from the same pre-edit read.

Ops:
- `replace` — replace the line at `pos`, or the inclusive range `pos`..`end`, with `lines`.
- `append` — insert `lines` after `pos`; omit `pos` to append at EOF.
- `prepend` — insert `lines` before `pos`; omit `pos` to insert at BOF.
- `replace_text` — replace the one exact unique occurrence of `oldText` with `newText`. Only when a match is guaranteed unique; otherwise read first and use anchors.

Example:
```json
{ "path": "src/main.ts", "edits": [
  { "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] }
] }
```

Rules:
- `lines` is literal file content: no `LINE#HASH:` prefix, no leading `+`/`-`. Match indentation exactly.
- Do not guess, shift, or construct anchors. Copy them from the most recent `read` of this file.
- Do not emit overlapping or adjacent edits — merge them into one.

On success (`changed` mode, default) the returned text is an `--- Anchors A-B ---` block with fresh `LINE#HASH` lines for the changed region. Use those for nearby follow-up edits in the same file without re-reading. For distant follow-ups, or on any error, call `read` again. `full` and `ranges` modes place previews in `details` for the host; the model still only needs what's in the text.

Errors come back as text starting with a bracketed code (e.g. `[E_STALE_ANCHOR]`, `[E_INVALID_PATCH]`, `[E_NO_MATCH]`). The message is self-describing and tells you what to retry; stale-anchor errors include the current `>>> LINE#HASH:` lines, ready to copy.