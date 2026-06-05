Patch a text file using `LINE#HASH` anchors copied verbatim from `read`.

Submit one `edit` call per file. All operations for that file go in a single `edits` array; every edit must set `op`; anchors within one call must all come from the same pre-edit read.

Ops:
- `replace` — replace the line at `pos`. Add `end` to replace the inclusive range `pos`..`end`. Without `end`, only the single line at `pos` is replaced — even if `lines` has many entries.
- `append` — insert `lines` after `pos`; omit `pos` to append at EOF.
- `prepend` — insert `lines` before `pos`; omit `pos` to insert at BOF.
- `replace_text` — one edit item `{ "op": "replace_text", "oldText": ..., "newText": ... }` replacing the one exact unique occurrence. Only when a match is guaranteed unique; otherwise read first and use anchors. `oldText`/`newText` are only valid with `op` set to `replace_text`.

Examples:
```json
{ "path": "src/main.ts", "edits": [
  { "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] }
] }
```
```json
{ "path": "src/main.ts", "edits": [
  { "op": "replace", "pos": "5#AB", "end": "8#QV", "lines": [
    "function greet(name) {",
    "  return `Hello, ${name}`;",
    "}"
  ] }
] }
```

Rules:
- Anchors define the span being replaced; `lines` is the complete new content for that whole span. To replace more than one line, set `end` — do not rely on a single `pos`.
- Do not copy boundary content into `lines`. The text after `:` in an anchor is for your reference only; including a neighboring line's content in `lines` duplicates that line.
- `lines` is literal file content: no `LINE#HASH:` prefix, no bare `HH:` hash, no leading `+`/`-`. The anchor goes in `pos`/`end` only — never copy a hash you saw in `read` output into `lines`. Match indentation exactly.
- Do not guess, shift, or construct anchors. Copy them from the most recent `read` of this file.
- Do not emit overlapping or adjacent edits — merge them into one.

On success (`changed` mode, default) the returned text is an `--- Anchors A-B ---` block with fresh `LINE#HASH` lines for the changed region. Use those for nearby follow-up edits in the same file without re-reading. For distant follow-ups, or on any error, call `read` again. `full` and `ranges` modes place previews in `details` for the host; the model still only needs what's in the text.

Errors come back as text starting with a bracketed code (e.g. `[E_STALE_ANCHOR]`, `[E_INVALID_PATCH]`, `[E_NO_MATCH]`). The message is self-describing and tells you what to retry; stale-anchor errors include the current `>>> LINE#HASH:` lines, ready to copy.
