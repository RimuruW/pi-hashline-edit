![pi-hashline-edit banner](assets/banner.jpeg)

# pi-hashline-edit

A [pi coding agent](https://github.com/mariozechner/pi-coding-agent) extension that overrides the built-in `read`, `grep`, and `edit` tools with content-anchored line references (`LINE#HASH:content`).

Based on [oh-my-pi](https://github.com/can1357/oh-my-pi)'s hashline engine. Hashline anchors let the LLM target exact lines by content hash rather than fragile line numbers, reducing edit drift and incorrect replacements.

---

## How It Works

### 1. Read
The `read` tool outputs each line with a unique identifier: `LINE#HASH:content`.
- **LINE**: The current line number (1-indexed).
- **HASH**: A 2-character content hash from a custom alphabet (`ZPMQVRWSNKTXJBYH`).

```text
10#VR:function hello() {
11#KT:  console.log("world");
12#BH:}
```

### 2. Grep
The `grep` tool also emits hashline references (`path:>>LINE#HASH:content`), allowing for a seamless Search → Edit workflow.
By default, `grep` remains disabled unless explicitly enabled via `--tools ...grep...`.

### 3. Edit
The `edit` tool uses these anchors to perform surgical modifications via a flat `{op, pos, end, lines}` schema:

```json
{
  "path": "src/main.ts",
  "edits": [
    {
      "op": "replace",
      "pos": "11#KT",
      "lines": ["  console.log('hashline');"]
    }
  ]
}
```

#### Operations
| Op | Purpose |
|---|---|
| `replace` | Replace a single line (`pos`) or range (`pos` + `end`). `lines: null` deletes. |
| `append` | Insert new lines after `pos`. Omit `pos` for end of file. |
| `prepend` | Insert new lines before `pos`. Omit `pos` for beginning of file. |

#### File-level operations
| Field | Purpose |
|---|---|
| `delete: true` | Delete the file. Cannot be combined with other operations. |
| `move: "new/path"` | Move/rename the file. Edits are applied first. Rejects if destination exists. |
| `text_replace` | Fallback substring replacement (no anchors needed). |

---

## Key Features

- **Smart Relocation**: If a line number drifts, the tool relocates by `HASH` within a ±20 line window. Only triggers when the hash match is unique in that window.
- **Boundary Duplicate Correction**: Detects when a model echoes the line before or after a range replace and auto-corrects to prevent doubled lines.
- **Hallucination-Resistant Hashes**: Uses a 16-character alphabet that excludes hex digits (A–F), confusable letters, and most vowels. References like `MQ` or `ZP` can never be mistaken for code content.
- **Prefix Stripping**: Removes hashline display prefixes from replacement text when 100% of non-empty lines carry the prefix. The regex is constrained to exactly 2 NIBBLE_STR characters to avoid false-matching comment patterns like `# Note:`.
- **Conflict Diagnostics**: If hashes don't match and relocation fails, the tool rejects the edit with a diff-like error showing what changed and the new `LINE#HASH` references.
- **Atomic Application**: All edits in a single call are validated against the file state before any writes occur. Edits are applied bottom-up to preserve line numbering.

---

## Design Divergences from oh-my-pi

This extension shares oh-my-pi's core hashline engine and regularly backports upstream bug fixes. It deliberately takes a **stricter approach** to validation and error handling in several areas — stricter anchor parsing, file operation guards, explicit error on empty payloads, auto-relocation, and a `text_replace` fallback. See **[docs/divergences.md](docs/divergences.md)** for the full comparison and rationale.

---

## Installation

```bash
# From local path
pi install /path/to/pi-hashline-edit

# From npm
pi install npm:pi-hashline-edit
```

## Technical Details

- **Hashing**: Uses `xxhashjs` for deterministic 32-bit hashes, truncated to 2 characters from a custom alphabet.
- **Hash Alphabet**: `ZPMQVRWSNKTXJBYH` — 16 consonants chosen to be visually distinct from digits and disjoint from hex.
- **Symbol-Line Seeding**: Lines with no alphanumeric content (e.g., `}`, `---`, blank lines) mix the line number into the hash seed to prevent collisions on structural markers.
- **Safety**: Atomic application — all edits validated before any writes. Strict anchor parsing, file operation guards, and conflict detection.

## Credits

Special thanks to [can1357](https://github.com/can1357) for the original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept.

## License

[MIT](LICENSE)
