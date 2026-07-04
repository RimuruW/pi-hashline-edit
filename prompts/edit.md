Patch a text file at `LINE#HASH` anchors copied verbatim from the latest read/grep result or the anchors block of a previous edit.

Batch every change to a file into one `edit` call: all operations go in the `edits` array, every edit sets `op`, and all anchors must come from the same pre-edit read. Edits validate against one snapshot and apply together, so line numbers never shift between entries of the same call.

Ops:
- `replace` — replace the single line at `pos`, or the inclusive span `pos`..`end`. `lines` is the complete new content for the whole span; `lines: []` deletes it. Without `end`, exactly one line is replaced no matter how many entries `lines` has.
- `append` — insert `lines` after `pos`; omit `pos` to append at end of file.
- `prepend` — insert `lines` before `pos`; omit `pos` to insert at start of file.
- `replace_text` — `{ "op": "replace_text", "oldText": ..., "newText": ... }` replaces one exact, unique occurrence and fails otherwise. Prefer anchors; use this only when uniqueness is certain. `oldText`/`newText` are invalid on any other op.

Example — single-line and span replace in one call:
```json
{ "path": "src/main.ts", "edits": [
  { "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] },
  { "op": "replace", "pos": "5#VR", "end": "8#QV", "lines": [
    "function greet(name) {",
    "  return `Hello, ${name}`;",
    "}"
  ] }
] }
```

Rules:
- `lines` is literal file content with exact indentation. Never include `LINE#HASH:` or bare `HH:` prefixes, diff `+`/`-` markers, or a copy of a neighboring line — the `:content` part of an anchor is context for you, not payload, and repeating a boundary line duplicates it in the file.
- Anchors are opaque: copy them exactly, never compute, shift, or guess one.
- Edits in one call must not overlap or touch adjacent lines — merge such changes into a single edit.

On success the result is an `--- Anchors A-B ---` block with fresh `LINE#HASH` lines for the changed region: use them directly for nearby follow-up edits, `read` again for distant ones. Errors start with a bracketed code (`[E_STALE_ANCHOR]`, `[E_INVALID_PATCH]`, …) and say how to retry; stale-anchor errors include the current `>>> LINE#HASH:content` lines, ready to copy.
