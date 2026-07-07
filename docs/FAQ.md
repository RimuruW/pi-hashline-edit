# FAQ

### Why only 2 hash characters by default? Wouldn't longer hashes prevent collisions?

Two characters (256 buckets) paired with line numbers is reliable for single-edit workflows. Longer hashes do reduce the chance of a false match when line numbers shift, but they increase token cost on every `read` line, which compounds fast in large files. Set `hashLength` to 3 or 4 if you need extra safety for complex concurrent edits. The trade-off, and the token budget, are yours.

### Why a custom 16-character alphabet instead of Base64 or hex?

Three reasons. First, we drop visually ambiguous pairs (0/O, 1/l/I) so humans can scan logs without squinting. Second, no vowels: a hash will never accidentally spell `for`, `let`, `if`, or any other real code token. Anchors and code text always look physically different, so the model never conflates them. Third, the 16-char set keeps hashes compact: two chars give 256 buckets, three give 4096, enough range without bloat.

### What happens with repeated lines — blank lines, repeated JSON, identical braces?

The hash is stateless: it depends on the current line plus its immediate neighbors (`prev + curr + next`), never on position or occurrence count. Two identical lines in different contexts get different hashes. When the context is also identical (consecutive blank lines, repeated identical objects), the line number in the anchor (e.g. `11#KT`) breaks the tie. No hidden counter, no global state. Editing one line never invalidates anchors dozens of lines away.

### Why does editing line N invalidate anchors for N−1 and N+1?

Because each line's hash is computed from `prev + curr + next`. When line N changes, the "next" input for line N−1 and the "prev" input for line N+1 both change, so their hashes change too. This is an intended safety property: if the content around an anchor has shifted, even by a single neighbor edit, the anchor goes stale rather than silently pointing at a semantically different context. The blast radius is always exactly ±1 line — distant anchors remain stable.

### Why `E_STALE_ANCHOR` errors instead of silently fixing the offset?

Silent patching corrupts code. When an anchor goes stale, the system first tries a 3-way snapshot merge. If the merge looks clean, it applies. If there is any risk of a false clean merge (the content around the edit has diverged in a way that makes the merge ambiguous), the system fails loudly with `E_STALE_ANCHOR` and tells you to re-read; when the stale anchor included a text hint, the error may also list content-matched candidate anchors. No heuristic relocation to a "close enough" line. In production code editing, determinism beats convenience every time.

### Why is the snapshot merge recovery so strict (fuzzFactor 0)?

Any fuzz tolerance in the merge would undermine the entire point of hash-anchored editing. If the system allowed "close enough" alignment during merge, it would reintroduce the same class of silent wrong-line rewrites that hashlines exist to prevent. fuzzFactor 0 means either the merge aligns exactly and produces a clean result, or it rejects. There is no middle ground where the system guesses.

### Why not have the model pass back an explicit Snapshot_ID?

Asking the model to track state adds failure modes: it can fabricate, misuse, or forget the ID. The anchors the model returns are the snapshot fingerprint. The system matches that set of `LINE#HASH` references against its internal pool and finds the version the model saw, with zero token overhead, no model-side tracking, and no risk of hallucinated IDs.

### What is `textHint` (e.g. `11#KT: console.log(...)`) and why is it optional?

`textHint` is an optional second factor. When an anchor's hash matches but the line number shifted (the 1/256 false-accept case), the runtime cross-checks the hint text against the actual file line. A mismatch catches the false accept before any edit touches the file. It is optional so the model can decide: pure hash when token budget is tight, hash+text when safety matters more. The model's own prompt instructions determine the strategy.

### Why is `grep` off by default?

Tool surface area matters. Every registered tool competes for the model's attention and occupies prompt tokens. Not all users need in-agent search, and some may prefer the model use shell tools or external search instead. Keeping `grep` opt-in means installing pi-hashline-edit only replaces `read`/`edit` — the tool surface stays minimal until the user explicitly widens it. It also avoids silent failures on systems without ripgrep installed.

### Why does `replace_text` exist alongside hash anchors?

`replace_text` handles a different class of edits: cases where the model knows *what text* to change but doesn't have (or need) positional anchors — for example, renaming a function call that appears exactly once. It complements rather than contradicts anchor-based editing. The strict "unique match or fail" semantics ensure it is never a fuzzy fallback. Users who want anchor-only purity can disable it with `"replaceText": false` in config.

### Why does `E_NOOP_LOOP` trigger after 3 consecutive identical edits, not 1?

A single no-op edit is legitimate — the model may be confirming the file is already in the desired state or may have slightly misjudged what needs changing. Two is suspicious but still plausible in a retry flow. Three consecutive byte-identical no-op payloads on the same content is a strong signal that the model is stuck in a loop and will not self-correct. The threshold balances catching genuine loops against not being trigger-happy on normal retry behavior.

### I have more questions. Where can I discuss this?

Open an [issue](https://github.com/RimuruW/pi-hashline-edit/issues) or send a PR. Edge cases, hash engine ideas, protocol suggestions — all welcome.
