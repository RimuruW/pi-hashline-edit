![pi-hashline-edit](assets/banner.jpeg)

# pi-hashline-edit

[![npm version](https://img.shields.io/npm/v/pi-hashline-edit)](https://www.npmjs.com/package/pi-hashline-edit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Hash-anchored `read` and `edit` tool override for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) — every line carries a content hash, so edits never land on the wrong line, even when the file has changed.
>
> Inspired by [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Why

LLMs edit code by quoting the text they see on screen. But by the time the edit runs, the file may have changed — a concurrent write, an earlier edit in the same turn, or drift from a stale read. The hashline protocol gives every line a short content hash, so edits carry verifiable references instead of raw text. Stale anchors are caught before they touch the file: no silent corruption, no wrong-line rewrites.

## Features

- 📖 **Hashline Read** — file content with `LINE#HASH:` prefixes, providing verifiable line-level anchors
- ✏️ **Anchored Edit** — `replace` / `append` / `prepend` / `replace_text`, all validated against content hashes before applying
- 🔍 **Grep** — ripgrep-backed search returning `LINE#HASH:` anchors, usable directly in `edit` without a prior `read` (opt-in)
- 🔗 **Chained Edits** — successful edits return fresh anchors, enabling consecutive edits without re-reading
- 🛡️ **Stale Anchor Recovery** — 3-way snapshot merge attempts automatic recovery; on failure, returns fresh anchors for immediate retry
- 🚫 **Strict by Design** — no silent relocation, no fuzzy matching, no accidental overwrites
- ⚡ **Atomic Writes** — temp-file + rename, symlink and hardlink safe

## Quick Start

```bash
pi install npm:pi-hashline-edit
```

Once installed, pi's `read` and `edit` tools are replaced by hashline versions. Reading a file will look like:

```text
 8#VR:function hello() {
 9#KT:  console.log("world");
10#BH:}
```

To edit, reference `LINE#HASH` anchors from the `read` output:

```json
{
  "path": "src/main.ts",
  "edits": [
    { "op": "replace", "pos": "9#KT", "lines": ["  console.log('hashline');"] }
  ]
}
```

If the file has changed since the last read, stale anchors are caught with explicit re-read guidance — no silent errors.

## How It Works

### `read`: tagged line output

Text files are returned with a `LINE#HASH:` prefix on every line:

- `LINE` — 1-indexed line number, left-padded for column alignment.
- `HASH` — content hash from the alphabet `ZPMQVRWSNKTXJBYH`; 2 characters by default, configurable up to 4 (see [Configuration](#configuration)).

Optional parameters: `offset` (start line), `limit` (max lines), `raw` (plain content without prefixes).

Images (JPEG, PNG, GIF, WebP) are passed through as attachments. Binary and directory paths are rejected with a descriptive error.

### `edit`: hash-anchored modifications

Edits use `LINE#HASH` anchors to target lines precisely. All edits in a single call validate against the same pre-edit snapshot and apply bottom-up, so line numbers stay consistent.

| Op | Purpose | Fields |
|---|---|---|
| `replace` | Replace one line (`pos`) or an inclusive range (`pos` + `end`). | `pos` required, `end` optional, `lines` |
| `append` | Insert lines after `pos`. Omit `pos` to append at EOF. | `pos` optional, `lines` |
| `prepend` | Insert lines before `pos`. Omit `pos` to prepend at BOF. | `pos` optional, `lines` |
| `replace_text` | Replace an exact unique substring. Fails if not found or matches more than once. | `oldText`, `newText` |

### `grep`: hashline-anchored search

Ripgrep-backed search returning `LINE#HASH:content` anchors in the same format as `read` output. These anchors can be passed directly into `edit`, closing the grep-to-edit loop without a separate round-trip.

- Pattern is regex by default; set `literal: true` for fixed-string search.
- Results respect `.gitignore`. Use `path` to scope and `glob` to filter by filename pattern.
- Set `context` (0–5) for surrounding lines; `limit` to cap matches (default 50, max 200).
- **Off by default.** Registered only when enabled in config (`"grep": true`) *and* `rg` is found on `PATH`.

### Chained edits

After a successful edit, the result includes an `--- Anchors A-B ---` block with fresh `LINE#HASH` references for the changed region. These can be used directly in the next `edit` call without a full re-read, provided the next edit targets the same or nearby lines.

## Configuration

Optional. Create `~/.pi/agent/hashline.json`:

```json
{
  "hashLength": 2,
  "grep": false,
  "replaceText": true
}
```

| Key | Default | Range | Meaning |
|---|---|---|---|
| `hashLength` | `2` | 2–4 | Characters per line hash. Longer hashes reduce false-accept risk at the cost of extra tokens per line. |
| `grep` | `false` | boolean | Register the `grep` tool (also requires ripgrep on `PATH`). |
| `replaceText` | `true` | boolean | Allow the `replace_text` op. Set `false` to enforce anchor-only edits. |

The file is read once at session start. A missing file means defaults. Invalid values fall back to defaults with a one-time warning.

## Design Decisions

- **No fallback relocation.** Mismatched anchors are never silently relocated to a "close enough" line. This trades convenience for correctness.
- **Stale anchors: recover, then fail.** A hash mismatch first attempts snapshot-merge recovery (3-way merge, fuzzFactor 0). If the snapshot is absent or the merge conflicts, `[E_STALE_ANCHOR]` tells the model to re-read; content-matched candidates are listed only when the anchor included a text hint.
- **Strict patch content.** If `lines` contains display prefixes or diff markers, the edit is rejected with `[E_INVALID_PATCH]`. The model must send literal file content.
- **Noop loop guard.** Three consecutive identical no-op edits throw `[E_NOOP_LOOP]`, preventing the model from silently looping.
- **Atomic writes.** Files are written via temp-file-then-rename. Symlink chains are resolved; hard-linked files preserve the shared inode; permissions are preserved.
- **Context-based hashing.** Each line's hash includes its immediate neighbors (`prev + curr + next`), so identical lines in different contexts get different hashes, and editing line N only invalidates anchors for N−1, N, and N+1.

For more details, see the [FAQ](docs/FAQ.md).

## Development

```bash
git clone https://github.com/RimuruW/pi-hashline-edit.git
cd pi-hashline-edit
npm install
```

```bash
npm test          # Run tests (vitest)
npm run typecheck # Type checking
npm run lint      # Biome linter
npm run check     # All checks (typecheck + lint + knip + test)
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

## Contributing

Contributions are welcome! Feel free to open an [Issue](https://github.com/RimuruW/pi-hashline-edit/issues) or submit a Pull Request.

Please run `npm run check` before submitting to ensure all checks pass.

Have questions? See the [FAQ](docs/FAQ.md).

## Credits

Thanks to [can1357](https://github.com/can1357) for the original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline technique.

## License

[MIT](LICENSE)
