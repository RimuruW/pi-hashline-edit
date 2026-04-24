# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [0.6.0] - 2026-04-24

### Added

- Add first-class `replace_text` edits.
- Add full and ranges return modes for edit previews.
- Add protocol metadata for snapshot validation, outlines, stale refresh anchors, and edit metrics.

### Fixed

- Preserve hard links during atomic writes.
- Canonicalize mutation targets across aliases.
- Render applied edit diffs in the UI only while keeping model-visible responses compact.
- Preserve legacy payload compatibility and fenced result sections.
- Tighten range and snapshot metadata handling.

### Changed

- Slim read/edit prompt guidance and edit response text for token efficiency.
- Drop snapshot ID rejection and silent autocorrection behavior from the protocol.
- Improve text-like MIME handling, including XML candidates.

### Tests

- Expand file-kind coverage for XML read guard paths and harden related test coverage.

## [0.5.4] - 2026-04-19

### Fixed

- Preserve rendered diff previews when the edit tool returns results.
- Preserve `@` signs and Unicode spaces when normalizing relative paths.
- Remove edit-application autocorrection heuristics to keep strict hashline semantics.
- Tighten UTF-8 classification for full-window reads while tolerating incomplete truncated input.
- Prevent unbounded `_hasherCache` memory growth.

### Changed

- Share file reads between file-kind detection and the `read`/`edit` tools to reduce duplicate I/O.

### Performance

- Cache the XXH32 hasher instance in hashline processing.

### Documentation

- Sync `README.md`, `AGENTS.md`, and prompts with current tool behavior.
- Fix broken links in `README.md`.

### Tests

- Add coverage for stale-position compound edits, EACCES/EPERM paths, line-ending/BOM helpers, and Windows-specific permission guards.

## [0.5.3] - 2026-04-06

### Documentation

- Clarify that `edits` must be a real JSON array, not a JSON-encoded string.

## [0.5.2] - 2026-04-06

### Documentation

- Document `read` tool `offset`/`limit` parameters, chained edits, and diff preview.
- Replace pseudo-code `edit` payload examples with full JSON examples.

## [0.5.0] - 2026-04-06

### Added

- **Updated anchors in edit results.** Each successful edit now returns a `--- Updated anchors ---` block with `LINE#HASH` anchors for the changed region, enabling chained edits without a full re-read.
- **Prepend into empty file handled correctly.** `prepend` with no `pos` now correctly replaces the empty sentinel line instead of inserting after it.
- **Empty range deletes and empty edit results.** Deleting an entire range and producing an empty file now reports the correct changed span without emitting sentinel anchors.
- **Regression test coverage for anchor tracking.** Added tests for append/prepend tracking, autocorrect delta recomputation, updated anchor regions, and empty-file ranges.

### Fixed

- **Legacy edit line-range and multi-line delete tracking.** `computeLegacyEditLineRange` now correctly reports changed spans for pure deletions, head/tail deletions, and full-content deletions.
- **Chained anchors for legacy top-level replace.** Legacy `oldText`/`newText` payloads now compute and return updated anchors in the edit result.
- **Final-document offsets for append tracking.** Append edits now use original coordinates plus computed offsets so `firstChangedLine`/`lastChangedLine` remain accurate after prepends and autocorrections shift content.
- **Replace delta recomputation after autocorrection.** When range-replace autocorrection strips leading or trailing duplicate lines, the delta map is updated so subsequent `computeOffset` calls for edits above use correct values.
- **Sentinel anchor emission.** The terminal newline sentinel is no longer included in `Updated anchors` blocks for EOF appends on newline-terminated files.
- **Non-string legacy key values preserved.** `prepareEditArguments` now stores non-string legacy values as non-enumerable properties instead of silently dropping them, enabling clear type errors at assertion.
- **Noisy warning heuristic removed.** The "line-shift noise" warning was removed as it produced false positives on legitimate edits.
- **Fuzzy regexes tidied and error handling unified.** Exported fuzzy unicode regexes are now shared from `hashline.ts`; unused references removed.
- **Read advisory for empty files.** `read` on an empty file returns a clear advisory suggesting `prepend`/`append` instead of a synthetic empty-line anchor.
- **Fuzzy anchor validation tightened.** Fuzzy `textHint` validation now rejects cases where the hash was computed against an arbitrary (non-canonical) string.

### Changed

- **Refactored edit tool to use shared `withFileMutationQueue`.** Removed the local queue implementation in favor of the upstream Pi utility.
- **Schema tightened for strict hashline payloads.** `prepareEditArguments` normalizes legacy fields before schema validation, improving compatibility with resumed sessions.
- **Edit guidelines merged into edit.md prompt.** The separate `edit-guidelines.md` prompt file has been merged into `edit.md`.
- **Dependency updates.** Bumped to pi 0.64.0, tightened peer dependency minimums, added `pi-tui` peer dep.

## [0.4.1] - 2026-03-27

### Fixed

- **GitHub issue #7: `0.4.0 is broken`.** The published `edit` tool schema is now a top-level JSON object instead of a union, so Pi accepts tool registration again and legacy `oldText`/`newText` payloads still validate.
- **EOF append semantics with terminal newlines.** `append` now inserts before the trailing newline sentinel, so appending to files ending in `\n` no longer creates an unintended blank line.
- **Pi 0.63 per-file mutation queue synced.** Hashline `edit` now runs inside Pi's `withFileMutationQueue()`, preventing lost updates when multiple tools mutate the same file concurrently in one turn.
- **Pi 0.63 edit preview synced.** The tool now renders an execution-time diff preview in the interactive UI before the edit runs, using the current file contents and the pending hashline or legacy payload.
- **Pi 0.63 fuzzy matching partially synced.** Legacy `oldText`/`newText` compatibility mode now falls back to unique fuzzy matching for Unicode quote/dash/space and trailing-whitespace differences. Hashline mode stays line-anchored, but copied full-line anchors like `LINE#HASH:content` can now survive those same-line Unicode/whitespace differences without enabling free-text relocation.

### Verification

- Added regression tests for top-level schema publication and EOF append behavior.
- `bun test` passes (181 tests).


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
