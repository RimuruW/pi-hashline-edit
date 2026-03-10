Applies precise file edits using `LINE#ID` tags from `read` output.

<workflow>
1. You **SHOULD** issue a `read` call before editing if you have no tagged context for a file.
2. You **MUST** pick the smallest operation per change site.
3. You **MUST** submit one `edit` call per file with all operations, think your changes through before submitting.
</workflow>

<prohibited>
You **MUST NOT** use this tool for formatting-only edits: reindenting, realigning, brace-style changes, whitespace normalization, or line-length wrapping. Any edit whose diff is purely whitespace is a formatting operation — run the appropriate formatter for the project instead.
</prohibited>

<operations>
Every edit has `op`, `pos`, and `lines`. Range replaces also have `end`. Both `pos` and `end` use `"N#ID"` format (e.g. `"23#XY"`).
**`pos`** — the anchor line. Meaning depends on `op`:
- `replace`: start of range (or the single line to replace)
- `prepend`: insert new lines **before** this line; omit for beginning of file
- `append`: insert new lines **after** this line; omit for end of file
**`end`** — range replace only. The last line of the range (inclusive). Omit for single-line replace.
**`lines`** — the replacement content:
- `["line1", "line2"]` — replace with these lines (array of strings)
- `"line1"` — shorthand for `["line1"]` (single-line replace)
- `[""]` — replace content with a blank line (line preserved, content cleared)
- `null` or `[]` — **delete** the line(s) entirely

### Line or range replace/delete
- `{ path: "…", edits: [{ op: "replace", pos: "N#ID", lines: null }] }` — delete one line
- `{ path: "…", edits: [{ op: "replace", pos: "N#ID", end: "M#ID", lines: null }] }` — delete a range
- `{ path: "…", edits: [{ op: "replace", pos: "N#ID", lines: [...] }] }` — replace one line
- `{ path: "…", edits: [{ op: "replace", pos: "N#ID", end: "M#ID", lines: [...] }] }` — replace a range

### Insert new lines
- `{ path: "…", edits: [{ op: "prepend", pos: "N#ID", lines: [...] }] }` — insert before tagged line
- `{ path: "…", edits: [{ op: "prepend", lines: [...] }] }` — insert at beginning of file (no tag)
- `{ path: "…", edits: [{ op: "append", pos: "N#ID", lines: [...] }] }` — insert after tagged line
- `{ path: "…", edits: [{ op: "append", lines: [...] }] }` — insert at end of file (no tag)

### File-level controls
- `{ path: "…", delete: true, edits: [] }` — delete the file
- `{ path: "…", move: "new/path.ts", edits: [...] }` — move file to new path (edits applied first)
**Atomicity:** all ops in one call validate against the same pre-edit snapshot; tags reference the last `read`. Edits are applied bottom-up, so earlier tags stay valid even when later ops add or remove lines.
</operations>

<rules>
1. **Minimize scope:** You **MUST** use one logical mutation per operation.
2. **Prefer insertion over neighbor rewrites:** You **SHOULD** anchor on structural boundaries (`}`, `]`, `},`), not interior lines.
3. **`end` is inclusive:** If `lines` includes a closing token (`}`, `]`, `)`, `);`, `},`), `end` **MUST** include the original boundary line. To delete a line while keeping neighbors, use `lines: null` — do not replace it with an adjacent line's content.
4. **Copy indentation from `read` output:** Leading whitespace in `lines` **MUST** follow adjacent lines exactly. Do not reconstruct from memory.
5. **Verify the splice before submitting:** For each edit op, mentally read the result:
   - Does the last `lines` entry duplicate the line surviving after `end`? → extend `end` or remove the duplicate.
   - Does the first `lines` entry duplicate the line before `pos`? → the edit is wrong.
   - For `prepend`/`append`: does new code land inside or outside the enclosing block? Trace the braces.
</rules>

<recovery>
**Tag mismatch (`>>>`):** You **MUST** retry using fresh tags from the error snippet. If snippet lacks context, or if you repeatedly fail, you **MUST** re-read the file and issue less ambitious edits, i.e. single op.
**No-op (`identical`):** You **MUST NOT** resubmit. Re-read target lines and adjust the edit.
</recovery>

<example name="inclusive end avoids duplicate boundary">
```ts
70#VR:if (ok) {
71#KT:  run();
72#BH:}
73#MQ:after();
```
Bad — `end` stops before `}` while `lines` already includes `}`:
```
{
  path: "…",
  edits: [{
    op: "replace",
    pos: "70#VR",
    end: "71#KT",
    lines: [
      "if (ok) {",
      "  runSafe();",
      "}"
    ]
  }]
}
```
Good — include original `}` in the replaced range when replacement keeps `}`:
```
{
  path: "…",
  edits: [{
    op: "replace",
    pos: "70#VR",
    end: "72#BH",
    lines: [
      "if (ok) {",
      "  runSafe();",
      "}"
    ]
  }]
}
```
Also apply the same rule to `);`, `],`, and `},` closers: if replacement includes the closer token, `end` must include the original closer line.
</example>

<example name="insert between siblings">
```ts
44#KT:  "build": "bun run compile",
45#MQ:  "test": "bun test"
```
```
{
  path: "…",
  edits: [{
    op: "prepend",
    pos: "45#MQ",
    lines: ["  \"lint\": \"biome check\","]
  }]
}
```
Result:
```ts
44#KT:  "build": "bun run compile",
45#VR:  "lint": "biome check",
46#MQ:  "test": "bun test"
```
</example>

<example name="anchor to structure, not whitespace">
Trailing `""` in `lines` preserves blank-line separators. Anchor to the structural line, not the blank line above — blank lines are ambiguous and shift.
```ts
101#BH:}
102#ZZ:
103#VR:export function serialize(data: unknown): string {
```
Bad — append after `}`
Good — prepend before the structural line:
```
{
  path: "…",
  edits: [{
    op: "prepend",
    pos: "103#VR",
    lines: [
      "function validate(data: unknown): boolean {",
      "  return data != null && typeof data === \"object\";",
      "}",
      ""
    ]
  }]
}
```
</example>

<critical>
- Edit payload: `{ path, edits[] }`. Each entry: `op`, `lines`, optional `pos`/`end`. No extra keys.
- Every tag **MUST** be copied exactly from fresh tool result as `N#ID`.
- You **MUST** re-read after each edit call before issuing another on same file.
- Formatting is a batch operation. You **MUST NOT** use this tool to reformat, reindent, or adjust whitespace — run the project's formatter instead. If the only change is whitespace, it is formatting; do not touch it.
- `lines` entries **MUST** be literal file content with indentation copied exactly from the `read` output. If the file uses tabs, use `\t` in JSON (a real tab character) — you **MUST NOT** use `\\t` (two characters: backslash + t), which produces the literal string `\t` in the file.
</critical>
