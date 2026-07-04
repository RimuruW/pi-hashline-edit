# pi-hashline-edit Context

## Domain

`pi-hashline-edit` is a Pi extension that replaces the built-in `read` and `edit` tools with hashline-anchored text editing.

## Core terms

- Hashline: model-visible line prefix `LINE#HH:` where `HH` is a content hash — 2 characters by default, 2–4 per user config (ADR 0006).
- Anchor: `LINE#HH` token copied from `read` output and used by `edit` as stable edit position.
- Changed response: `edit` success text that returns only fresh anchors around affected lines.
- Details: host-only structured metadata. Model-facing text must not rely on `details` for next action.
- Canonical request: normalized edit request `{ path, edits }` after dialect convergence.
- grep: ripgrep-backed search tool emitting read-equivalent LINE#HASH anchors; opt-in via config, off by default.
- Read snapshot: multi-version per-path LRU store (8 paths × 4 versions, ADR 0005) of non-raw read content used by stale-anchor merge recovery.

## Architecture invariants

- Runtime never relocates stale anchors or autocorrects malformed diffs. Stale-anchor recovery may replay an edit against the last read snapshot and 3-way-merge it (fuzzFactor 0, exact alignment or rejection); anchors are never slid to nearby lines.
- `read` (non-raw) and successful edits update the multi-version read-snapshot store.
- User config (`~/.pi/agent/hashline.json`) is loaded once at extension load; validation precedes any regex/encoder construction, invalid values fall back per-field to defaults, and config errors never throw or disable the extension.
- Prompt `.md` files are authored with 2-character example anchors and stay literal; anchor-shaped tokens (`\d+#[alphabet]{2}`) are rewritten at load to the session hash length — an identity transform at the default length. Error-message examples come from the single `exampleAnchor()` source.
- `normalizeEditRequest` is sole dialect-convergence layer for native Pi edit shapes and JSON-string edits.
- `assertEditRequest` validates only public request envelope; `resolveEditAnchors` owns per-edit validation.
- Successful edits return fresh anchors in text; broad file/range payloads require `read`.
- All writes go through `writeFileAtomically`.
