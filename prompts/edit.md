Applies precise file edits using `LINE#HASH` tags from `read` output.

<workflow>
1. You **SHOULD** issue a `read` call before editing if you do not already have fresh tagged context for the file.
2. You **MUST** submit one `edit` call per file with all planned operations.
3. You **MUST** use the smallest operation per change site.
</workflow>

<prohibited>
You **MUST NOT** use this tool for formatting-only edits: reindenting, realigning, brace-style changes, whitespace normalization, or line-length wrapping. If the diff is only whitespace, do not use `edit`.
</prohibited>

<contract>
Payload shape: `{ path, edits }`
- `path`: target file path
- `edits`: array of strict hashline edit operations
- No extra root keys
- No legacy search override, destructive file operations, or substring replacement fields
</contract>

<operations>
Every edit entry has `op`, `lines`, and optional `pos` / `end`.
- `replace`: replace one line (`pos`) or a range (`pos` + `end`)
- `append`: insert after `pos`; omit `pos` for end of file
- `prepend`: insert before `pos`; omit `pos` for beginning of file

Anchors use `"N#ID"` format from fresh `read` output.
Examples:
- `{ path: "src/file.ts", edits: [{ op: "replace", pos: "12#MQ", lines: ["const x = 1;"] }] }`
- `{ path: "src/file.ts", edits: [{ op: "replace", pos: "12#MQ", end: "14#VR", lines: null }] }`
- `{ path: "src/file.ts", edits: [{ op: "append", pos: "20#NK", lines: ["footer();"] }] }`
- `{ path: "src/file.ts", edits: [{ op: "prepend", lines: ["// header"] }] }`
</operations>

<rules>
1. `end` is inclusive.
2. Copy indentation exactly from fresh `read` output.
3. `lines` must be literal file content; do not include hashline prefixes unless copied accidentally.
4. Extra keys are invalid.
</rules>

<recovery>
**Tag mismatch (`>>>`)**: retry using the `>>> LINE#HASH:content` lines from the error snippet. If needed, re-read the file and make a smaller edit.
**Diff preview hashes**: hashes shown on unchanged and added diff lines are hints for immediate re-edit. Re-read if the file may have been modified by other processes.
**No-op (`identical`)**: do not resubmit unchanged content. Re-read and change actual file content.
</recovery>
