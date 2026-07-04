![pi-hashline-edit](assets/banner.jpeg)

# pi-hashline-edit

Hash-anchored `read` and `edit` tools for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

LLMs edit code by quoting the text they see on screen. But by the time the edit runs, the file may have changed: a concurrent write, an earlier edit in the same turn, or drift from a stale read. The hashline protocol gives every line a short content hash, so edits carry verifiable references instead of raw text. Stale anchors are caught before they touch the file: no silent corruption, no wrong-line rewrites.

Inspired by [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Installation

```bash
# From npm
pi install npm:pi-hashline-edit

# From a local checkout
pi install /path/to/pi-hashline-edit
```

## How It Works

### `read`: tagged line output

Text files are returned with a `LINE#HASH:` prefix on every line. Line numbers may be left-padded within each returned block so the `#HASH:` columns align:

```text
 8#VR:function hello() {
 9#KT:  console.log("world");
10#BH:}
```

- `LINE`: 1-indexed line number.
- `HASH`: content hash from the alphabet `ZPMQVRWSNKTXJBYH`; 2 characters by default, configurable up to 4 (see [Configuration](#configuration)).

Optional parameters:
- `offset`: start reading from this line number (1-indexed).
- `limit`: maximum number of lines to return.
- `raw`: set to `true` to return plain file content without `LINE#HASH:` prefixes. Raw reads do not update the read snapshot and do not participate in stale-anchor recovery.

Images (JPEG, PNG, GIF, WebP) are passed through as attachments and do not participate in the hashline protocol. Binary and directory paths are rejected with a descriptive error. Empty files return an advisory suggesting `prepend`/`append` instead of a synthetic anchor.

### `edit`: hash-anchored modifications

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
| `replace_text` | Replace an exact unique substring anywhere in the file. Fails if the text is not found or matches more than once. | `oldText`, `newText` |

All edits in a single call validate against the same pre-edit snapshot and apply bottom-up, so line numbers stay consistent across operations.

### grep: hashline-anchored search

`grep` uses ripgrep to search files and returns every matched line as a `LINE#HASH:content` anchor in the same format as `read` output. These anchors can be passed directly into `edit` without a prior `read`, closing the grep-to-edit loop without a separate round-trip.

- Pattern is a regular expression by default; set `literal: true` for a fixed-string search.
- Results respect `.gitignore` (ripgrep's default). Use `path` to scope to a file or directory; use `glob` to filter by filename pattern (e.g. `"**/*.ts"`).
- Set `context` (0-5) to include surrounding lines around each match. Set `limit` to cap matched lines (default 50, max 200).
- The tool is off by default. It is registered only when enabled in [Configuration](#configuration) (`"grep": true`) *and* `rg` (ripgrep) is found on `PATH`; otherwise it is silently omitted and installing this extension leaves pi's tool surface unchanged beyond `read`/`edit`.

### Chained edits

After a successful edit in the default `changed` return mode, the result text includes an `--- Anchors A-B ---` block with fresh `LINE#HASH` references for the changed region. These anchors (or anchors from a `grep` result) can be used directly in the next `edit` call on the same file without a full re-read, provided the next edit targets the same or nearby lines. For distant changes, use `read` first.

### Diff preview

The full diff is stored in `details.diff` for the host UI. The model-visible text stays compact and focuses on fresh anchors, warnings, and retry guidance.

## Design Decisions

- **Stale anchors may be recovered, then fail.** A hash mismatch first attempts snapshot-merge recovery: if the anchors are valid against the model's last read snapshot, the edit is replayed against that snapshot and 3-way-merged (fuzzFactor 0, exact alignment required) onto the live file. If the snapshot is absent or the merge conflicts, the original `[E_STALE_ANCHOR]` error surfaces with fresh `LINE#HASH` references for immediate retry. Anchors are never relocated to nearby lines.
- **No fallback relocation.** Mismatched anchors are never silently relocated to a "close enough" line. This trades convenience for correctness.
- **Strict patch content.** If `lines` contains `LINE#HASH:` display prefixes or diff `+`/`-` markers, the edit is rejected with `[E_INVALID_PATCH]`. The model must send literal file content; the runtime does not silently strip accidental prefixes.
- **Native edit normalization.** When a caller sends a top-level `oldText`/`newText` payload (the built-in edit format), the request is normalized into `op: "replace_text"` and uses the same strict exact-unique-match semantics as any other `replace_text` edit. Inexact or non-unique matches are rejected; there is no fuzzy legacy fallback or separate compatibility notifier.
- **Noop loop guard.** Three consecutive byte-identical no-op edit payloads on the same content throw `[E_NOOP_LOOP]`, preventing the model from silently looping on an edit that produces no change.
- **Atomic writes.** Files are written via temp-file-then-rename to avoid corruption from interrupted writes. Symlink chains are resolved so the target file is updated without replacing the symlink. Hard-linked files are updated in place to preserve the shared inode. File permissions are preserved across atomic renames.
- **Per-file mutation queue.** Edits queue by the canonical write target, so concurrent edits through different symlink paths still serialize onto the same underlying file.

## Hashing

Hashes are computed with [xxhashjs](https://github.com/pierrec/js-xxhash) (xxHash32), then mapped to a string from a custom 16-character alphabet, 2 characters by default (up to 4 via `hashLength`).

The alphabet (`ZPMQVRWSNKTXJBYH`) excludes hex digits, common vowels, and visually ambiguous letters (D/G/I/L/O), so a default reference like `5#MQ` is not confusable with code content, hex literals, or English words. At longer lengths some real uppercase tokens (e.g. `HTTP`, `MQTT`) do fall inside the alphabet, so bare `HASH:`-shaped content is never rejected on shape alone.

Each line's hash is computed from its content together with its immediate neighbors: the input to xxHash32 is `prev + "\0" + curr + "\0" + next`, where each component is the normalized (trailing whitespace stripped, `\r` removed) text of the preceding line, the current line, and the following line respectively. Lines at file boundaries use `""` for the missing neighbor.

This means editing line N invalidates anchors for lines N−1, N, and N+1 (an intended safety property) while distant anchors remain stable. Two identical lines (e.g. `}`) that appear in different contexts receive different hashes, so no line-number tiebreaker is needed.

When an anchor includes a `:content` hint (e.g. `5#MQ:some text`), the runtime cross-checks the hint against the actual file line. If the hash matches but the hint clearly differs from the actual line, the anchor is treated as stale, guarding the 1/256 collision case at zero extra token cost.

## Configuration

Optional. Create `~/.pi/agent/hashline.json`:

```json
{
  "hashLength": 2,
  "grep": false
}
```

| Key | Default | Range | Meaning |
|---|---|---|---|
| `hashLength` | `2` | 2 to 4 | Characters per line hash in `read`/`grep` output and `edit` anchors. Longer hashes reduce the chance that a stale edit slips through undetected, at the cost of extra tokens on every line and every anchor. They do **not** reduce `[E_STALE_ANCHOR]` errors; stale anchors are rejected either way. |
| `grep` | `false` | boolean | Registers the hashline-anchored `grep` tool (also requires ripgrep on `PATH`). |

The file is read once at session start; there is no hot reload. Anchors from before a length change are invalid by design and produce a re-read hint. A missing file means defaults. Invalid values fall back to the defaults for that field and produce a one-time session warning; a broken config never disables the extension.

## Development

Requires [Node.js](https://nodejs.org) and npm.

```bash
npm install
npm test
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

## Credits

Thanks to [can1357](https://github.com/can1357) for the original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline technique.

## License

[MIT](LICENSE)
