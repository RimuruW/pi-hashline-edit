# Repository Guidelines

## Project Structure & Module Organization
- `index.ts` is the extension entrypoint; it registers the custom `read`/`edit` tools.
- `src/` contains the implementation, split by responsibility: `read.ts`, `edit.ts`, `edit-normalize.ts`, `hashline.ts`, `edit-diff.ts`, `file-kind.ts`, `fs-write.ts`, and small runtime/path helpers.
- `prompts/` holds the Markdown prompt text loaded by the tools at runtime.
- `test/` mirrors the code layout: `core/` for hashline primitives, `tools/` for tool behavior, `extension/` for registration, `integration/` for end-to-end flows, and `support/fixtures.ts` for temp-file helpers.
- `assets/` is documentation media only.

## Build, Test, and Development Commands
- `npm install` — install dependencies.
- `npm test` — run the full test suite with `vitest`.
- `npm test -- test/tools` — run tool-facing tests while iterating on `read`/`edit` behavior.
- `npm test -- test/integration/strict-hashline-loop.test.ts` — run the strict hashline integration scenario.
- There is no separate build step today; Pi loads the TypeScript entrypoints directly from `index.ts`.

## Coding Style & Naming Conventions
- Use TypeScript with ESM imports, two-space indentation, double quotes, and semicolons to match the existing codebase.
- Keep modules narrow and named by responsibility (`fs-write.ts`, `edit-normalize.ts`).
- Export typed functions and use specific error paths; avoid broad refactors or speculative abstractions.
- No ESLint or Prettier config is checked in, so preserve local style and keep diffs tight.

## Testing Guidelines
- Write tests with `vitest` and place them under the matching `test/` subfolder.
- Name files `<feature>.test.ts`; group assertions around one behavior per `describe` block.
- Any change to anchor parsing, diff preview, request normalization, or atomic writes should include or update tests in the affected layer.
- New integration scenarios (e.g. compound edits, stale-position edge cases) go under `test/integration/` as standalone `<scenario>.test.ts` files.

## Commit & Pull Request Guidelines
- Follow the existing Conventional Commit pattern: `fix(hashline): ...`, `refactor(read, edit): ...`, `docs: ...`.
- Keep commits focused and imperative; separate behavior changes from documentation-only updates.
- PRs should summarize the user-visible effect, list the tests run, and include before/after snippets when tool output or prompts change.

## Architecture Guardrails
- Keep `read`, `edit`, prompt text, and tests in sync whenever the hashline format changes.
- Do not bypass `src/fs-write.ts`; atomic writes are part of the extension’s safety guarantees.
- Preserve stale-anchor rejection semantics unless the change explicitly redesigns the protocol.
- Pi's built-in `edit` tool uses `{ path, edits: [{ oldText, newText }] }` text matching; this extension overrides it with hashline anchors. Model dialects that follow the native contract — top-level `oldText`/`newText` (or `old_text`/`new_text`), edit items with `oldText`/`newText` and no `op`, `edits` serialized as a JSON string, `file_path` alias — are converged onto the canonical `{ path, edits: [{ op, ... }] }` shape in one place: `normalizeEditRequest` (`src/edit-normalize.ts`), wired as the tool's `prepareArguments` hook and re-applied at the top of `execute()` / `computeEditPreview()` so the normalization does not depend on the hook having run. Keep all dialect handling there; `assertEditRequest` validates the canonical shape only. The published schema therefore does not declare the native top-level fields — they no longer exist by validation time. Normalization rewrites field shape only; it never touches hashline diff semantics (anchors, ranges, boundaries, `lines`). Top-level native replaces normalize to `op: "replace_text"`, which is strict unique-match (no fuzzy fallback); there is no separate legacy text-replace path.
- Do not introduce autocorrection heuristics (e.g. stripping duplicate boundary lines, converting `\t` escape sequences) into `applyHashlineEdits`. The policy is strict semantics: the model must produce correct diffs; the runtime must not silently patch them.
- Keep tool output token-efficient. `LINE#HASH:` already costs ~2 tokens per line, and `content[0].text` is repaid on every edit.
  - `text` carries only what the model needs for its next step: updated anchors, `Changes: +N -M`, noop classification, stale-anchor retry hints, error codes.
  - Full diffs, structural outlines, range payloads, snapshot fingerprints, metrics — host UI only, route to `details`.
  - Never duplicate in `text` what anchors already express. No fallback outlines, no usage boilerplate, no verbose headers.
  - New output fields default to `details`; moving one into `text` needs a justification beyond "the LLM might want it".
