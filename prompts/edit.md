Apply edits to a file using `LINE#HASH` anchors from `read` output.

<usage>
Submit one `edit` call per file. Include all operations for that file in a single call.

Use `read` first if you do not have current `LINE#HASH` references for the target file.
</usage>

<payload>
```json
{
  "path": "src/main.ts",
  "edits": [
    { "op": "replace", "pos": "12#MQ", "lines": ["..."] }
  ]
}
```

- `path` — target file path.
- `edits` — array of edit operations.
</payload>

<operations>
Each entry has an `op`.

- `replace` — replaces the line at `pos`, or all lines from `pos` through `end` inclusive, with the contents of `lines`. `pos` is required; `end` is optional.
- `append` — inserts `lines` after `pos`. Omit `pos` to insert at end of file.
- `prepend` — inserts `lines` before `pos`. Omit `pos` to insert at start of file.
- `replace_text` — replaces one exact unique `oldText` match with `newText`. Use this when you do not have anchors yet, or for exact string substitutions that can safely coexist with anchored edits in the same request.

`end` is only valid with `replace`.

Anchor format: `"LINE#HASH"` copied exactly from `read` output (e.g. `"12#MQ"`).
</operations>

<examples>

Replace one line:

```json
{ "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] }
```

Replace a range — `lines` is the complete new content for that range, not including the surrounding lines:

```json
{ "op": "replace", "pos": "12#MQ", "end": "14#VR", "lines": ["line a", "line b"] }
```

Delete lines:

```json
{ "op": "replace", "pos": "12#MQ", "end": "14#VR", "lines": [] }
```

Insert after a line:

```json
{ "op": "append", "pos": "50#NK", "lines": ["", "## New Section"] }
```

Exact unique text replacement:

```json
{ "op": "replace_text", "oldText": "before", "newText": "after" }
```

Mixed edits in one call — all anchors refer to the same pre-edit snapshot, and `replace_text` matches against that same snapshot:

```json
{
  "path": "README.md",
  "edits": [
    { "op": "replace",      "pos": "33#YW", "lines": ["updated line"] },
    { "op": "replace_text", "oldText": "draft title", "newText": "final title" },
    { "op": "append",       "pos": "50#NK", "lines": ["", "## New Section"] },
    { "op": "prepend",                      "lines": ["// header"] }
  ]
}
```
</examples>

<constraints>
- Copy `LINE#HASH` anchors exactly from `read` output — do not guess or construct them.
- Copy indentation exactly from `read` output.
- `lines` must be literal file content. Do not include `LINE#HASH:` prefixes or diff markers.
- `replace_text` is exact-only: it must match exactly once in the current file. If it matches zero or multiple times, re-read and use anchors instead.
- Do not echo the line immediately before or after the replaced range into `lines` — include only the new content for the targeted lines.
- Each edit in a call targets anchors from the same pre-edit snapshot. Do not use anchors from the result of one edit as input to another edit in the same call.
- Do not emit overlapping or adjacent edits — merge nearby changes into a single entry.
- Keep each edit as small as possible; do not pad with large unchanged regions.
- Submitting content identical to the current file is rejected.
</constraints>

<after-edit>
A successful edit returns:
- `Diff preview` — changed lines with `+`/`-` markers.
- `Updated anchors` — fresh `LINE#HASH` references for the changed region, usable in the next call without re-reading. For edits outside that region, use `read` first.
</after-edit>

<errors>
- **Stale anchor**: the file has changed since your last `read`. The error shows the current content with `>>>` marking the lines you need. Copy those `>>> LINE#HASH` values and retry. For a range replace, update both `pos` and `end`.
- **Identical content**: your replacement matches what the file already contains. Re-read to confirm the current state, then supply different content.
</errors>
