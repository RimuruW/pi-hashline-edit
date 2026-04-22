Patch a UTF-8 text file using `LINE#HASH` anchors copied from `read`.

Use `read` first unless you are doing an unambiguous exact-text replacement with `replace_text`.

Submit one `edit` call per file and include all operations for that file in a single `edits` array.

Operations:
- `replace`: replace the line at `pos`, or the inclusive range from `pos` through `end`, with `lines`
- `append`: insert `lines` after `pos`; omit `pos` to append at end of file
- `prepend`: insert `lines` before `pos`; omit `pos` to insert at start of file
- `replace_text`: replace one exact unique `oldText` match with `newText`

Minimal example:
```json
{
  "path": "src/main.ts",
  "edits": [
    { "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] }
  ]
}
```

Critical rules:
- Copy anchors verbatim from `read`; do not guess, shift, or synthesize them.
- `lines` must be literal file content. Do not include `LINE#HASH:` prefixes or diff markers like `+` or `-`.
- All anchors in one call must come from the same pre-edit snapshot. Merge overlapping or adjacent edits.
- `replace_text` must match exactly once. If it does not, re-read and switch to anchors.

`returnMode` is optional. `changed` (default) returns fresh anchors for the changed region when they fit the budget; otherwise it returns a short hint to `read` before continuing. If the file becomes empty, it returns the empty-file insertion hint instead. `full` and `ranges` return post-edit previews in `details`.

If the edit succeeds, prefer the returned fresh anchors for nearby follow-up edits. If you hit stale-anchor or match errors, re-read and retry with current anchors or narrower text.