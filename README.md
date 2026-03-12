![pi-hashline-edit banner](assets/banner.jpeg)

# pi-hashline-edit

A [pi coding agent](https://github.com/mariozechner/pi-coding-agent) extension that overrides the built-in `read` and `edit` tools with strict `LINE#HASH:content` references.

Inspired by [oh-my-pi](https://github.com/can1357/oh-my-pi), but narrowed to fit pi's minimal and reliability-first philosophy: a small surface, explicit integrity checks, and no fallback modes that hide stale context.

---

## What it overrides

- **`read`**: Prefixes every line with `LINE#HASH:` for precise referencing.
- **`edit`**: Accepts a structured payload using these hash anchors for surgical line modifications.

This extension intentionally avoids any separate search override workflow to maintain simplicity and reliability.

---

## How it works

### Read
`read` returns text files as full tagged lines:

```text
10#VR:function hello() {
11#KT:  console.log("world");
12#BH:}
```

- **`LINE`**: The current 1-indexed line number.
- **`HASH`**: A 2-character content hash derived from the custom alphabet `ZPMQVRWSNKTXJBYH`.

If the first selected line is too large to fit safely within the read budget, `read` returns an advisory instead of a partial tagged line. This prevents unusable or misleading anchors.

### Edit
`edit` accepts only this payload shape:

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

#### Supported Operations:

| Op | Purpose | Parameters |
|---|---|---|
| `replace` | Replace one line (`pos`) or an inclusive range (`pos` + `end`). | `pos`, `end` (optional), `lines` |
| `append` | Insert after `pos`. Omit `pos` for end of file (EOF). | `pos` (optional), `lines` |
| `prepend` | Insert before `pos`. Omit `pos` for beginning of file (BOF). | `pos` (optional), `lines` |

---

## Strictness Guarantees

- **Stale Anchors Fail**: Mismatched hashes do not relocate. You must re-read the file and use the updated `LINE#HASH` references from the error snippet.
- **No Substring Fallback**: Edits must use hash anchors instead of legacy free-text replacement modes.
- **Hidden compatibility path**: When models omit `edits` and send a legacy top-level exact replace payload, the tool may adapt it internally only if the match is exact and unique. Compatibility use is surfaced to the interactive UI, not to the model.
- **Atomic Application**: All edits in a single call validate against the same pre-edit snapshot and apply bottom-up to ensure line integrity.
- **Whitespace-aware Hashing**: Internal spaces are significant; trailing spaces are ignored during hash computation.
- **Display Prefix Stripping**: Automatically handles accidental inclusion of display prefixes (like `10#VR:`) copied from `read` output or diffs.

---

## Technical Details

- **Hashing Engine**: Uses `xxhashjs` for deterministic 32-bit hashes, mapped to a custom 16-character alphabet optimized for readability and uniqueness (`ZPMQVRWSNKTXJBYH`).
- **Symbol-line Seeding**: Lines with no alphanumeric content (e.g., a single `}`) mix in their line number to the hash seed to reduce collisions on structural markers.
- **Safety Mechanisms**:
    - **Atomic Writes**: Writes to a temporary file before renaming to prevent file corruption during interruptions.
    - **Abort Signaling**: Supports cancellation of long-running or large edit operations via `AbortSignal`.
    - **Duplicate Correction**: Automatically detects and strips duplicate boundary lines frequently echoed by LLMs during range edits.

---

## Installation

```bash
pi install https://github.com/RimuruW/pi-hashline-edit
```

## Development

This project is developed using **Bun**.

```bash
# Install dependencies
bun install

# Run tests
bun test
```

## Credits

Special thanks to [can1357](https://github.com/can1357) for the original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept.

## License

[MIT](LICENSE)
