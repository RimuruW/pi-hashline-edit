![pi-hashline-edit](assets/banner.jpeg)

# pi-hashline-edit

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that replaces the built-in `read` and `edit` tools with a hash-anchored line-editing workflow.

Every line returned by `read` carries a short content hash. Edits reference these hashes instead of raw text, so the tool can detect stale context and reject outdated changes before they reach the file.

Inspired by [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Installation

```bash
# From npm
pi install npm:pi-hashline-edit

# From a local checkout
pi install /path/to/pi-hashline-edit
```

## How It Works

### `read` — tagged line output

Text files are returned with a `LINE#HASH:` prefix on every line:

```text
10#VR:function hello() {
11#KT:  console.log("world");
12#BH:}
```

- `LINE` — 1-indexed line number.
- `HASH` — 2-character content hash from the alphabet `ZPMQVRWSNKTXJBYH`.

Optional parameters:
- `offset` — start reading from this line number (1-indexed).
- `limit` — maximum number of lines to return.

Images (JPEG, PNG, GIF, WebP) are passed through as attachments. Binary and directory paths are rejected with a descriptive error. Empty files return an advisory instead of a synthetic anchor.

### `edit` — hash-anchored modifications

Edits use the `LINE#HASH` anchors from `read` output to target lines precisely:

```json
{
  "path": "src/main.ts",
  "edits": [
    { "op": "replace", "pos": "11#KT", "lines": ["  console.log('hashline');"] }
  ]
}
```

| Op | Purpose | Fields |
|---|---|---|
| `replace` | Replace one line (`pos`) or an inclusive range (`pos` + `end`). | `pos` required, `end` optional, `lines` |
| `append` | Insert lines after `pos`. Omit `pos` to append at EOF. | `pos` optional, `lines` |
| `prepend` | Insert lines before `pos`. Omit `pos` to prepend at BOF. | `pos` optional, `lines` |

All edits in a single call validate against the same pre-edit snapshot and apply bottom-up, so line numbers stay consistent across operations.

### Chained edits

After a successful edit, the result includes an `--- Updated anchors ---` block with fresh `LINE#HASH` references for the changed region. These can be used directly in the next `edit` call on the same file without a full re-read, provided the next edit targets the same or nearby lines. For distant changes, use `read` first.

### Diff preview

Each edit result includes a compact `Diff preview:` block showing the changed lines with `+`/`-` markers and their new `LINE#HASH` anchors, making quick follow-up edits possible without a full re-read.

## Design Decisions

- **Stale anchors fail.** A hash mismatch means the file has changed since the last `read`. The error includes a snippet with fresh `LINE#HASH` references for retry.
- **No fallback relocation.** Mismatched anchors are never silently relocated to a "close enough" line. This trades convenience for correctness.
- **Hidden legacy compatibility.** When a caller sends a top-level `oldText`/`newText` payload (the built-in edit format), the tool attempts an exact unique match. Usage is surfaced to the interactive UI so the operator can see that the model isn't using hashline mode.
- **Atomic writes.** Files are written via temp-file-then-rename to avoid corruption from interrupted writes. Symlink chains are resolved so the target file is updated in place.
- **Display prefix stripping.** If the model accidentally pastes `LINE#HASH:` prefixes or diff `+`/`-` markers into replacement content, they are detected and stripped automatically. With `PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS=1`, `\t` escape sequences in replacement content are also converted to literal tabs when the target file uses tab indentation.
- **Per-file mutation queue.** Edits run inside Pi's `withFileMutationQueue()`, preventing lost updates when multiple tools mutate the same file concurrently in one turn.

## Hashing

Hashes are computed with [xxhashjs](https://github.com/pierrec/js-xxhash) (xxHash32), then mapped to a 2-character string from a custom 16-character alphabet.

The alphabet (`ZPMQVRWSNKTXJBYH`) excludes hex digits, common vowels, and visually ambiguous letters (D/G/I/L/O), so a reference like `5#MQ` can never be confused with code content, hex literals, or English words.

Lines that contain no alphanumeric characters (e.g. a lone `}`) use their line number as the hash seed to reduce collisions on structurally identical markers.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun test
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

Set `PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS=1` to enable `\t` → tab autocorrection in edit replacement content.

## Credits

Thanks to [can1357](https://github.com/can1357) for the original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept.

## License

[MIT](LICENSE)
