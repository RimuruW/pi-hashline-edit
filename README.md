![pi-hashline-edit banner](assets/banner.jpeg)

# pi-hashline-edit

A [pi coding agent](https://github.com/mariozechner/pi-coding-agent) extension that overrides the built-in `read`, `grep`, and `edit` tools with content-anchored line references (`LINE#HASH:content`).

Inspired by [oh-my-pi](https://github.com/can1357/oh-my-pi)'s hashline mode. Hashline anchors let the LLM target exact lines by content hash rather than fragile line numbers, reducing edit drift and incorrect replacements.

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
The `edit` tool uses these anchors to perform surgical modifications.

```json
{
  "path": "src/main.ts",
  "edits": [
    {
      "set_line": {
        "anchor": "11#KT",
        "new_text": "  console.log('hashline');"
      }
    }
  ]
}
```

#### Edit Variants
| Variant | Purpose |
|---|---|
| `set_line` | Replace a single anchored line. |
| `replace_lines` | Replace a range of lines between `start_anchor` and `end_anchor`. |
| `insert_after` | Insert new content immediately after an anchor. |
| `replace` | Fallback for fuzzy substring replacement (no hashes needed). |

---

## Key Features

- **Smart Relocation**: If a line number drifts, the tool treats `LINE` as a hint and relocates by `HASH` within a local window (±20 lines). Relocation only happens when the hash match is unique in that window.
- **Trailing Duplicate Correction**: Detects when a model echoes the boundary line after a range replace and auto-corrects to prevent doubled lines.
- **Hallucination-Resistant Hashes**: Uses a custom 16-character alphabet that excludes hex digits (A–F), visually confusable letters (I, L, O, D, G), and most vowels. Hash references like `MQ` or `ZP` can never be mistaken for code content.
- **Prefix Stripping**: Safely removes hashline display prefixes from replacement text when 100% of non-empty lines carry the prefix (prevents false positives on real content).
- **Conflict Diagnostics**: If hashes don't match (e.g., the file was modified externally), the tool rejects the edit and provides a "diff-like" error showing exactly what changed and the new `LINE#HASH` references.
- **Atomic Application**: All edits in a single call are validated against the file state before any writes occur. Edits are applied bottom-up to preserve line numbering.

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
- **Safety**: Atomic application — all edits in a single call are validated against the file state before any writes occur.

## Credits

Special thanks to [can1357](https://github.com/can1357) for the original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept.

## License

[MIT](LICENSE)
