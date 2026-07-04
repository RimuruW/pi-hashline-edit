# ADR 0006: User configuration — hash length (2–4) and opt-in grep

## Status

Accepted (amends ADR 0001)

## Context

ADR 0001 fixed hashes at 2 characters for token economy and stated the length question should not be reopened without new collision evidence or changed token economics. User feedback raised collision concerns, and a per-user opt-in changes the economics clause for exactly the users who accept the cost: the default — and therefore ADR 0001's decision — stays untouched, while users who want more hash bits pay the extra tokens themselves.

Separately, the `grep` tool shipped in the unreleased 0.8 line registers unconditionally. Pi's default active toolset does not include its built-in grep, so installing this extension silently widens the model-visible tool surface, and multiple extensions overriding `grep` can conflict through registration order.

## Decision

Add a user configuration file, `~/.pi/agent/hashline.json`, read once at extension load (no hot reload):

```json
{
  "hashLength": 2,
  "grep": false
}
```

- **`hashLength`** — integer 2–4, default 2. Controls the per-line hash length in `read`/`grep` output and `edit` anchor validation.
- **`grep`** — boolean, default `false`. The grep tool is registered only when this is `true` *and* ripgrep is on `PATH`.
- **Fail-safe validation.** Validation runs before any regex or encoder is built from the value. A missing file is the normal path (defaults, silently). A malformed file or an out-of-range/mistyped field falls back to that field's default and surfaces one session warning. Configuration errors never throw: a bad config file must not cost the user the read/edit tools.

Supporting decisions:

- **Range capped at 4, not 8.** Every extra character costs tokens on every read line and every copied anchor; longer runs of rare characters also raise the chance a model mis-transcribes an anchor. 16 bits already cuts the silent false-accept probability by a factor of 256 relative to the default; beyond that the marginal safety does not justify the cost.
- **Length-mismatch diagnostic.** An anchor whose hash uses only alphabet characters but has a different valid length than the session's produces a dedicated error naming the session's hash length and directing the model to re-read, instead of a generic format error. Anchors persist in session transcripts, so a config change between sessions would otherwise strand models in retry loops on old anchors.
- **Display-prefix rejection is length-agnostic.** The `[E_INVALID_PATCH]` check that rejects rendered `LINE#HASH:` prefixes inside `lines` matches all supported lengths (2–4), not just the session's: its semantics are "this is rendered read/diff output, not literal file content", and rendered output can be copied from a stale transcript or a different-length configuration. The bare `HH:` heuristic stays at the session length — it disambiguates against the file's actual hash set, which only contains hashes of the session length, so cross-length candidates would be unverifiable noise.
- **Prompt examples stay authored at 2 characters.** Prompt files remain literal markdown; anchor-shaped example tokens are rewritten at load time to the session's hash length (an identity transform at the default). Error-message examples are generated from the same single example-anchor source, so examples can never drift from the configured length.

## Consequences

- **Default users are byte-identical.** With no config file, hashes, prompts, and the tool surface match the previous behavior exactly, except that grep now requires opt-in.
- **What longer hashes buy — and don't.** Length reduces only the *silent false-accept* rate, which is already triple-guarded (3-line-window hashing per ADR 0003, line number as primary key, textHint stale guard). It does not reduce `[E_STALE_ANCHOR]` frequency, and it can surface *more* errors, because mis-copied or fabricated anchors that would have passed at 8 bits get rejected instead.
- **Alphabet uniqueness weakens with length.** At 3–4 characters some real uppercase tokens (e.g. `HTTP`, `MQTT`) fall entirely inside the hash alphabet. Shape-based detectors retain the existing rule of never rejecting bare `HASH:`-shaped content on shape alone.
- **Installing the extension no longer changes the active tool surface** beyond replacing `read`/`edit`; grep becomes a deliberate user choice, which also removes registration-order conflicts with other extensions overriding `grep`.
- ADR 0001's guidance stands for the default; future reviews of the *default* length still require new collision evidence.
