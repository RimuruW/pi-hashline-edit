# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.2] - 2026-07-09

### Added

- **`replaceText` config to gate the `replace_text` operation.** A new `replaceText` flag in `~/.pi/agent/hashline.json` lets users disable the `replace_text` edit operation, and `edit` now records a grep snapshot so anchor recovery has more context to work with (#30).

### Changed

- **Stale-anchor errors no longer render a display window.** The `[E_STALE_ANCHOR]` diagnostic previously included a rendered window of surrounding lines; this is dropped in favor of directing the model to re-read, reducing noise and token cost.

### Documentation

- README reorganized, with the FAQ extracted into a dedicated file and a Q&A section added.

## [0.8.1] - 2026-07-04

### Fixed

- **OOB error line count now matches read output (sentinel excluded).** The `[E_RANGE_OOB]` error message previously reported the internal `split("\n")` line count, which includes a trailing empty sentinel for newline-terminated files, making it 1 higher than what the model sees in `read` output and what `wc -l` shows. The fix introduces `visibleLineCount` as a first-class `LineIndex` field, computed once in `buildLineIndex`, and uses it in the OOB error message. The internal sentinel is still addressable for EOF-append boundary computation.

## [0.8.0] - 2026-07-04

### Added

- **grep tool (hashline-anchored ripgrep search, opt-in).** A new `grep` tool backed by ripgrep emits `LINE#HASH:content` anchors in the same format as `read` output. Anchors from `grep` results can be passed directly into `edit` without a prior `read`, closing the grep→edit flow without a separate round-trip. The tool is off by default: it is registered only when enabled via `~/.pi/agent/hashline.json` (`"grep": true`) and `rg` (ripgrep) is present on `PATH`, so installing the extension does not widen pi's active tool surface beyond `read`/`edit`. Results respect `.gitignore` by default and support context lines, glob scoping, and a configurable match limit.
- **User configuration file (ADR 0006).** `~/.pi/agent/hashline.json` is read once at session start with schema `{"hashLength": 2, "grep": false}`. `hashLength` (integer 2–4, default 2) sets the per-line hash length in `read`/`grep` output and `edit` anchor validation; longer hashes reduce the silent false-accept rate at the user's own token cost, and do not reduce `[E_STALE_ANCHOR]` frequency. Anchors with a valid-alphabet hash of a *different* valid length get a dedicated diagnostic naming the session's hash length and directing a re-read, so a config change between sessions cannot strand models in retry loops. Invalid or malformed config falls back per-field to defaults with a one-time session warning — a broken config never disables the extension. Prompt files stay authored with 2-character examples; anchor-shaped example tokens are rewritten at load to the session length (byte-identical at the default). The `[E_INVALID_PATCH]` display-prefix rejection in `lines` matches all supported lengths (2–4) regardless of the session's setting, so rendered output copied from a stale transcript or a different-length configuration is still caught.
- **Snapshot-merge stale-anchor recovery (ADR 0004).** `edit` now has a two-tier stale-anchor flow: (1) exact match against the live file (existing behavior); (2) if anchors are stale against the live file but valid against the model's last read snapshot, the edit is replayed against that snapshot and 3-way-merged onto the live file using `fuzzFactor: 0`. Recovery emits a mandatory warning in the tool response. If the snapshot is absent or the merge produces a conflict, the original `[E_STALE_ANCHOR]` error surfaces unchanged — no silent data loss.
- **`read` raw mode.** `read` accepts `raw: true` to return plain file content without `LINE#HASH:` prefixes. Raw reads do not update the read snapshot and do not participate in stale-anchor recovery.
- **`[E_NOOP_LOOP]` guard.** Three consecutive byte-identical no-op edits with the same payload on the same file throw `[E_NOOP_LOOP]`, preventing the model from silently looping on an edit that produces no change.
- **Mixed line-ending warning.** `edit` emits a warning when the file being written contains a mix of `\r\n` and `\n` line endings.
- **File-not-found error points to `write` tool.** When `edit` targets a path that does not exist, the error message now explicitly suggests using the `write` (or equivalent create) tool instead.

### Changed

- **Breaking (protocol): context-based line hashing (ADR 0003).** Every line hash is now computed from the line's content together with its immediate neighbors: `xxHash32(prev + "\0" + curr + "\0" + next)`, seed 0. The line-number seed for symbol-only lines is removed. **All anchors from earlier context-free hashline sessions are stale by definition.** Side effects: editing line N now invalidates anchors for N−1, N, and N+1; two identical lines with different neighbors receive different hashes; distant edits no longer perturb unrelated anchors.
- **`textHint` dual role.** On hash mismatch with a `textHint` present, forgiveness recomputes the hint's hash using the current file's neighbor context (consistent with ADR 0003). On hash match with a `textHint` that does not fuzzy-match the actual line, the anchor is treated as stale — closing the silent 1/256 collision path.
- **Read snapshot updated on edit.** The single-slot read snapshot (keyed by canonical path) is updated after every successfully applied `edit` in addition to non-raw `read`, so chained edits work without an intervening re-read.
- **Hashline engine split.** `src/hashline.ts` is refactored into `src/hashline/{hash,parse,apply,format}.ts` for maintainability. The public API surface is unchanged.

### Infrastructure

- GitHub Actions CI, Biome linter, `noUnusedLocals` TypeScript flag added.

## [0.7.0] - 2026-06-12

### Added

- Single request-normalization layer (`src/edit-normalize.ts`, wired as the tool's `prepareArguments` hook) that converges model dialects onto the canonical `{ path, edits: [{ op, ... }] }` shape before validation: top-level `oldText`/`newText` (and `old_text`/`new_text`), edit items with `oldText`/`newText` and no `op`, `edits` serialized as a JSON string, and the `file_path` alias.
- Non-blocking edit warnings for two silent failure modes (issue #22): a single-anchor `replace` that receives multiple `lines` (likely a missing `end`), and boundary-line duplication on both sides of a replaced range (the previously undetected leading-line variant is now caught alongside the trailing-line one).

### Changed

- **Breaking (runtime behavior):** top-level native text replaces now normalize to a strict, unique-match `op: "replace_text"`. The previous fuzzy legacy fallback (Unicode-quote/dash/space and trailing-whitespace tolerance) is removed; an inexact or non-unique match is rejected with guidance to re-read and use hashline anchors.
- The published edit schema no longer declares the legacy top-level fields; normalization folds them into `edits` before validation, so the model is never shown a non-hashline path. The `lines` field is published as a string array only (the unused string/null union variants are gone).

### Fixed

- Preserve existing file modes under restrictive process `umask` values while keeping atomic-write temp files owner-only before content is written.
- Reject ambiguous or malformed top-level native replace aliases during normalization instead of silently picking one dialect or dropping bad fields.
- Surface an edit-time warning when a file decoded with U+FFFD replacement characters is rewritten as UTF-8, matching Pi's built-in edit behavior while avoiding a silent lossy rewrite.

### Removed

- The parallel fuzzy legacy text-replace path (`src/edit-compat.ts`) and the "edit compatibility mode" UI notifier (`src/compatibility-notify.ts`), both superseded by the normalization layer.
- **Breaking:** the `returnMode`/`returnRanges` request fields and the `details.fullContent`/`details.returnedRanges`/`details.structureOutline` payloads. `edit` now has one success shape: changed-region anchors in model-visible text plus host-only diff/metrics details; call `read` for broader context (ADR 0002).
- The constant `return_mode` field from host-only `details.metrics`; it always read `"changed"` after the payload-mode deletion and carried no information.

### Tests

- Added `normalizeEditRequest` unit coverage and rewrote the compatibility suite around the normalized contract; renamed `computeLegacyEditLineRange` to `computeChangedLineRange`.

## [0.6.1] - 2026-05-10

### Fixed

- Align rendered line numbers in hashline output.
- Restore schema-level legacy edit fields without non-enumerable payload hacks.

### Changed

- Migrate npm package scope to `@earendil-works`.
- Switch development tooling back to npm and Vitest, removing the stale Bun lockfile.

### Documentation

- Update README and changelog notes for the npm and Vitest migration.

### Tests

- Add edit preview coverage for the fuzzy quote compatibility path.

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
- `npm test` passes (181 tests).


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
- **Migrated from npm to Bun.** `package-lock.json` was replaced with `bun.lock`; all development commands used `bun`. (Reverted in 0.7.0: migrated back to npm + vitest.)

### Removed

- **`grep` tool override** — removed to reduce surface area. The built-in `grep` tool is unaffected.
- **Anchor relocation** — mismatched anchors no longer search nearby lines for a match. Stale anchors always fail with a retry snippet.

## [0.3.0] - 2026-02-20

Initial tagged release.
