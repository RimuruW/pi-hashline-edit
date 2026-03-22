# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-03-23

### Added

- **Compact diff preview in edit results.** Each successful edit now returns a condensed `Diff preview:` block showing changed lines with `+`/`-` markers and their new `LINE#HASH` anchors, making quick follow-up edits possible without a full re-read.
- **Legacy compatibility mode.** When a caller sends a top-level `oldText`/`newText` or `old_text`/`new_text` payload (the built-in edit format), the tool attempts an exact unique match and applies it. Usage is surfaced to the interactive UI as a warning — not to the model — so operators can see when hashline mode is not being used.
- **Compatibility notifications.** A turn-end notification is emitted to the UI when one or more edits in a turn fell back to legacy mode, with a count of affected edits.
- **Input autocorrections.** The tool now automatically strips accidental `LINE#HASH:` display prefixes or diff `+`/`-` markers copied into replacement `lines`, and corrects `\t`-escaped tab indentation when the environment variable `PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS=1` is set.
- **Binary and image file detection.** Both `read` and `edit` now classify files before processing: images (JPEG, PNG, GIF, WebP) are handled by the built-in read tool as attachments; binary files are rejected with a descriptive error; only UTF-8 text files proceed to hashline processing.
- **Out-of-range read offset reporting.** Requesting an `offset` beyond the end of file now returns a clear advisory with the file's actual line count and valid offset range.
- **`grep` tool removed.** The grep override has been dropped to simplify the extension surface. Use the built-in grep tool instead.

### Fixed

- **Stale anchor error snippets now include valid retry anchors.** When a hash mismatch occurs, the error snippet marks mismatched lines with `>>>` and includes their current `LINE#HASH` for immediate retry, along with surrounding context lines for range edits.
- **Diff preview prefix stripping handles mixed `+`/`-` contexts.** Copying lines from a diff preview (including deletion rows) into `lines` is now correctly handled — deletion rows are dropped and added/context lines are stripped of their prefix.
- **Escaped-tab autocorrection is correctly scoped.** The `\t` → tab correction only applies when the file uses tab indentation and the replacement content uses `\t` escape sequences, preventing false positives in other contexts.
- **Atomic writes preserve symlink targets.** Writing through a symlink chain now resolves to the final target and writes in place, rather than replacing the symlink with a regular file.
- **Atomic writes preserve file mode.** The target file's permissions are copied to the newly written file after an atomic rename.
- **Symlink loops are detected and reported.** Circular symlink chains produce an `ELOOP` error instead of hanging.
- **Hash semantics tightened.** Symbol-only lines (no alphanumeric characters) use their line number as the hash seed, reducing collisions on structurally identical lines like lone `}` or `{`.
- **Unsafe truncated previews are rejected.** If the first selected line exceeds the byte budget, `read` returns an advisory instead of a partial hashline, since partial lines produce unusable anchors.
- **Caller-owned edit arrays are not mutated.** `applyHashlineEdits` now clones its input before deduplication and in-place modifications, so callers that reuse the same array across calls see consistent data.
- **Schema validation accepts legacy payloads.** The published TypeBox schema now includes optional `oldText`/`newText`/`old_text`/`new_text` fields so AJV validation does not reject valid legacy calls before execution.
- **Mixed camelCase/snake_case legacy keys are rejected.** Payloads combining `oldText` with `new_text` (or vice versa) are rejected at the assertion layer with a clear error.

### Changed

- **Edit tool is strict hashline-only by default.** Free-text relocation (`replace` by scanning for matching content) has been removed. All edits use `LINE#HASH` anchors; the legacy `oldText`/`newText` path is a hidden compatibility fallback, not a documented mode.
- **`read` output is hashline-only.** The tool no longer supports non-hashline output modes.
- **Test suite reorganized** into layered directories: `test/core/` for hashline primitives, `test/tools/` for tool behavior, `test/extension/` for registration and notifications, `test/integration/` for end-to-end flows.
- **Migrated from npm to Bun.** `package-lock.json` has been replaced with `bun.lock`; all development commands use `bun`.

### Removed

- **`grep` tool override** — removed to reduce surface area. The built-in `grep` tool is unaffected.
- **Anchor relocation** — mismatched anchors no longer search nearby lines for a match. Stale anchors always fail with a retry snippet.

## [0.3.0] - 2026-02-20

Initial tagged release.
