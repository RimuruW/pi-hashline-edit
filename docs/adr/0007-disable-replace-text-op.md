# ADR 0007: User configuration — opt-out of the replace_text op

## Status

Accepted

## Context

The `replace_text` op locates an exact, unique substring and replaces it without requiring LINE#HASH anchors. It was introduced for convenience, but it undermines the core guarantee of the hashline edit protocol: that every edit is anchored to a specific, hash-verified location rather than a floating text search.

In practice, models with prior edit-tool training often send `oldText`/`newText` payloads even when the hashline prompt does not mention `replace_text`, because those forms appear in their training distribution. This produces a two-mode extension: users who rely on anchors for precision find that model behaviour silently diverges into text-match mode on ambiguous instructions, while users who explicitly opt out have no mechanism to enforce anchor-only edits.

A session-level block is not feasible at the tool layer because the model sees the op in the published schema and in the prompt, which is sufficient to generate it regardless of runtime guards. The block must act at schema-publication time (removing the op from the visible schema) and at the prompt-rewrite layer (removing the op description) to converge model behaviour.

## Decision

Add `"replaceText": boolean` (default `true`) to `~/.pi/agent/hashline.json`.

When `replaceText` is `false`:

1. **Schema.** The `replace_text` variant is omitted from the edit tool's published parameters schema so the model never sees it as a valid option. The remaining variants (`replace`, `append`, `prepend`) are unaffected.

2. **Prompt.** The `replace_text` op bullet is stripped from the loaded edit prompt at extension load time, using the same load-time rewrite pattern as the anchor-example rewriting in ADR 0006. The prompt source files are not changed; the rewrite is applied in memory.

3. **Runtime guard.** Any edit that arrives as `op: "replace_text"` — including legacy top-level `oldText`/`newText` and `old_text`/`new_text` payloads, which `edit-normalize.ts` folds into `op: "replace_text"` before validation — is rejected after normalization with a teaching error whose message starts with `[E_REPLACE_TEXT_DISABLED]`. The error explicitly instructs the model to re-read the file and use LINE#HASH anchor edits instead.

   The runtime guard fires after normalization so that legacy dialect payloads hit the same path as explicit `replace_text` edits; they cannot slip through as a schema error or succeed silently.

Supporting decisions:

- **Default is `true` (no behaviour change without opt-in).** Existing users and the existing test suite are byte-identical when no config file or a config file without `replaceText` is present.
- **Fail-safe parse.** An invalid `replaceText` value falls back to `true` with a session warning. A bad config field must never disable the extension.
- **No silent drop.** Disabled edits throw loudly. The error message includes both "re-read" and "anchor" guidance so the model can self-correct without a second round-trip.

## Consequences

- **Default users see no change.** Prompts, schema, and runtime behaviour are byte-identical when `replaceText` is absent or `true`.
- **Opt-out users get anchor-only enforcement.** The combination of schema omission, prompt stripping, and runtime rejection converges model output toward anchor edits, even for models carrying prior training priors for `oldText`/`newText`.
- **No new schema complexity at the model surface.** The schema the model sees shrinks from four variants to three; it is never shown a path it cannot take.
