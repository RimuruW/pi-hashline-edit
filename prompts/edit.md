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
Each entry has an `op` and a `lines` array of replacement content.

- `replace` — replace one line (`pos`) or an inclusive range (`pos` + `end`). `pos` is required.
- `append` — insert lines after `pos`. Omit `pos` to append at EOF.
- `prepend` — insert lines before `pos`. Omit `pos` to prepend at BOF.

`end` is only valid with `replace`.

Anchor format: `"LINE#HASH"` copied from `read` output (e.g. `"12#MQ"`).
</operations>

<chained-edits>
After a successful edit, the tool returns an "Updated anchors" block with fresh
`LINE#HASH` references for the changed region. You may use these anchors directly
in your next edit call on the same file without calling `read` again, provided
your next edit targets the same region or nearby lines.

If your next edit targets a distant part of the file, use `read` first to get
fresh anchors for that region.
</chained-edits>

<examples>

Replace one line:

```json
{
  "path": "src/main.ts",
  "edits": [
    { "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] }
  ]
}
```

Replace a range:

```json
{
  "path": "src/main.ts",
  "edits": [
    { "op": "replace", "pos": "12#MQ", "end": "14#VR", "lines": ["merged"] }
  ]
}
```

Delete a range:

```json
{
  "path": "src/main.ts",
  "edits": [
    { "op": "replace", "pos": "12#MQ", "end": "14#VR", "lines": [] }
  ]
}
```

Multiple edits in one call:

```json
{
  "path": "README.md",
  "edits": [
    { "op": "replace", "pos": "33#YW", "lines": ["updated line"] },
    { "op": "append", "pos": "50#NK", "lines": ["", "## New Section"] },
    { "op": "prepend", "lines": ["// header"] }
  ]
}
```
</examples>

<constraints>
- Copy indentation exactly from `read` output.
- `lines` must be literal file content. Do not include `LINE#HASH:` prefixes.
- Extra keys inside edit entries are rejected.
- Submitting content identical to the current file is rejected.
- Each edit targets anchors from the same pre-edit snapshot. Do not emit overlapping or nested edits — merge nearby changes into one entry.
- Keep each edit as small as possible; do not pad with large unchanged regions.
</constraints>

<errors>
- **Stale anchor** (`>>>`): the file has changed. Use the `>>> LINE#HASH:content` lines from the error snippet to retry.
- **No-op** (`identical`): your replacement matches existing content. Re-read and supply different content.
</errors>
