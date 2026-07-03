/**
 * Hashline engine — hash-anchored line editing.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 *
 * Module layout:
 *   hashline/hash.ts   — hash alphabet, xxh32, per-line hash, fuzzy normalization
 *   hashline/parse.ts  — types, prefix regexes, anchor parsing, resolveEditAnchors
 *   hashline/apply.ts  — edit engine: anchor validation, span resolution, assembly
 *   hashline/format.ts — formatHashlineRegion, computeAffectedLineRange, computeChangedLineRange
 */

export type { Anchor, HashlineEdit, HashlineToolEdit } from "./hashline/parse";
export { computeLineHash, computeHashFromContext } from "./hashline/hash";
export { resolveEditAnchors } from "./hashline/parse";
export { applyHashlineEdits } from "./hashline/apply";
export {
	computeAffectedLineRange,
	formatHashlineRegion,
	computeChangedLineRange,
} from "./hashline/format";
