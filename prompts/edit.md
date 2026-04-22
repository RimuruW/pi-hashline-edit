Apply edits to a file using `LINE#HASH` anchors from `read` output.

<usage>
Submit one `edit` call per file. Include all operations for that file in a single call.

Use `read` first if you do not have current `LINE#HASH` references for the target file.
</usage>

<payload>
```json
{
  "path": "src/main.ts",
  "returnMode": "changed",
  "edits": [
    { "op": "replace", "pos": "12#MQ", "lines": ["..."] }
  ]
}
```

- `path` — target file path.
- `returnMode` — optional. `changed` (default) returns a Changes summary plus fresh anchors for the changed region. `full` and `ranges` return a structure outline (when structural markers are found) and place payloads in `details.fullContent` / `details.returnedRanges`. The full diff is always available in `details.diff`.
- `returnRanges` — required when `returnMode="ranges"`. Array of `{ "start": number, "end"?: number }` post-edit windows.
- `edits` — array of edit operations.
</payload>

<operations>
Each entry has an `op`.

- `replace` — replaces the line at `pos`, or all lines from `pos` through `end` inclusive, with `lines`. `end` is optional.
- `append` — inserts `lines` after `pos`. Omit `pos` to insert at end of file.
- `prepend` — inserts `lines` before `pos`. Omit `pos` to insert at start of file.
- `replace_text` — replaces one exact unique `oldText` match with `newText`. Use when you do not have anchors yet, or for unambiguous string substitutions.

`end` is only valid with `replace`. Anchor format: `"LINE#HASH"` copied verbatim from `read` output (e.g. `"12#MQ"`).
</operations>

<examples>
Single line replace:

```json
{ "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] }
```

Range replace — `lines` is the complete new content for that range, surrounding lines are not echoed:

```json
{ "op": "replace", "pos": "12#MQ", "end": "14#VR", "lines": ["line a", "line b"] }
```
</examples>

<constraints>
- Copy `LINE#HASH` anchors verbatim from `read` output — do not guess, construct, or shift them.
- Copy indentation exactly.
- `lines` must be literal file content. Do NOT prefix with `LINE#HASH:` or with diff `+`/`-` markers — the runtime rejects those instead of stripping them.
- `replace_text` is exact-only: it must match exactly once. Zero or multiple matches → re-read and use anchors.
- All anchors in one call refer to the same pre-edit snapshot. Do not chain anchors from one edit's result into another edit in the same call.
- Do not emit overlapping or adjacent edits — merge nearby changes.
- Submitting content identical to the current file returns `classification: "noop"` rather than an error.
</constraints>

<errors>
Errors are returned as text prefixed with a stable code in brackets:

- `[E_INVALID_PATCH]` — `lines` contained `LINE#HASH:` or diff prefixes. Strip them locally and resend literal content.
- `[E_NO_MATCH]` — `replace_text` had no match. Re-read and use anchored ops.
- `[E_MULTI_MATCH]` — `replace_text` matched more than once. Narrow `oldText` or switch to anchors.
- `[E_STALE_ANCHOR]` — anchor hash mismatched. The error body lists the current `>>> LINE#HASH:...` lines; copy them and retry. For range replaces, refresh both endpoints.
- `[E_RANGE_OOB]` — anchor line is past EOF. Re-read.
- `[E_BAD_REF]` / `[E_BAD_OP]` / `[E_EDIT_CONFLICT]` — request shape is invalid. Read the message and fix the call.
</errors>

<after-edit>
A successful edit returns:
- `Changes: +N -M` summary line.
- `--- Anchors A-B ---` block with fresh `LINE#HASH` references for the changed region; usable in the next call without re-reading. Distant edits still need a fresh `read`.

The full unified diff lives in `details.diff`, not in the returned text. `full` and `ranges` modes also emit a `Structure outline:` block when the returned content contains recognisable markers (functions, classes, headings, …); when nothing structural is found the outline is omitted entirely.
</after-edit>
