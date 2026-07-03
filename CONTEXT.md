# pi-hashline-edit Context

## Domain

`pi-hashline-edit` is a Pi extension that replaces the built-in `read` and `edit` tools with hashline-anchored text editing.

## Core terms

- Hashline: model-visible line prefix `LINE#HH:` where `HH` is a 2-character content hash.
- Anchor: `LINE#HH` token copied from `read` output and used by `edit` as stable edit position.
- Changed response: `edit` success text that returns only fresh anchors around affected lines.
- Details: host-only structured metadata. Model-facing text must not rely on `details` for next action.
- Canonical request: normalized edit request `{ path, edits }` after dialect convergence.

## Architecture invariants

- Runtime never relocates stale anchors or autocorrects malformed diffs. Stale-anchor recovery may replay an edit against the last read snapshot and 3-way-merge it (fuzzFactor 0, exact alignment or rejection); anchors are never slid to nearby lines.
- `read` (non-raw) and successful edits update the single-slot read snapshot.
- `normalizeEditRequest` is sole dialect-convergence layer for native Pi edit shapes and JSON-string edits.
- `assertEditRequest` validates only public request envelope; `resolveEditAnchors` owns per-edit validation.
- Successful edits return fresh anchors in text; broad file/range payloads require `read`.
- All writes go through `writeFileAtomically`.
