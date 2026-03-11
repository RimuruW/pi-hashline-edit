# Design Divergences from oh-my-pi

This extension shares oh-my-pi's core hashline engine (hash computation, edit application, display format) and regularly backports upstream bug fixes and heuristics. However, it deliberately takes a **stricter approach to validation and error handling** in several areas. These are intentional design choices, not sync gaps.

## Strict anchor validation

**oh-my-pi**: Uses `tryParseTag()` — a malformed anchor (e.g., `pos: "garbage"`) silently degrades to the anchorless behavior (append→EOF, prepend→BOF).

**pi-hashline-edit**: Uses `parseLineRef()` directly — a *provided* anchor that fails to parse always throws. Omitting `pos` entirely is still valid for anchorless append/prepend.

*Rationale*: A malformed anchor indicates the model intended to target a specific line and got it wrong. Silently reinterpreting it as a different operation is surprising and error-prone. "Missing is fine, malformed is not."

## File operation guards

**oh-my-pi**: Move silently overwrites if the destination exists. `delete` combined with other operations silently ignores the non-delete parts.

**pi-hashline-edit**: Move rejects if the destination exists. `delete` combined with `move`, `edits`, or `text_replace` is rejected as conflicting.

*Rationale*: File-level operations are destructive. Implicit overwrites and partially-applied intents should fail explicitly rather than silently clobber data or discard work.

## Empty insert payloads

**oh-my-pi**: `lines: []` on append/prepend is silently converted to `[""]` (inserts a blank line).

**pi-hashline-edit**: `lines: []` on append/prepend throws an error.

*Rationale*: An empty payload on an insert operation is more likely a model error than an intentional blank-line insert. Use `lines: [""]` explicitly for that.

## Auto-relocation

**oh-my-pi**: Requires exact line number match; any mismatch throws.

**pi-hashline-edit**: Searches a ±20 line window for a unique hash match when the line number is stale.

*Rationale*: When using hashline edits alongside other tools or in multi-edit flows, line numbers can drift between the `read` and `edit` calls. Relocation recovers from this without forcing a re-read, while the uniqueness constraint prevents ambiguous matches.

## text_replace fallback

**oh-my-pi**: Hashline mode only supports anchor-based edits. Substring replacement is a separate tool mode.

**pi-hashline-edit**: Includes `text_replace` as a fallback within the same tool.

*Rationale*: Provides a safety hatch when anchors are unavailable (e.g., the model hasn't read the file yet) without requiring a mode switch.
