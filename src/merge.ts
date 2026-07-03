/**
 * Three-way merge helper for stale-anchor recovery.
 *
 * fuzzFactor 0 — misaligned hunks are rejected, never slid; rationale is the
 * strict no-relocation principle. If the patch cannot apply exactly, returns
 * null and the caller surfaces the original stale-anchor error.
 */

import { structuredPatch, applyPatch } from "diff";

/**
 * Replay the changes made from `base` → `baseEdited` onto `current`.
 *
 * Returns the merged text, or null when:
 * - the patch cannot apply to `current` with fuzzFactor 0, or
 * - the merged result is identical to `current` (nothing new to write).
 *
 * Short-circuit: if `base === current`, return `baseEdited` directly.
 */
export function threeWayMerge(
	base: string,
	baseEdited: string,
	current: string,
): string | null {
	if (base === current) {
		return baseEdited;
	}

	const patch = structuredPatch("a", "b", base, baseEdited, "", "", { context: 3 });
	const merged = applyPatch(current, patch, { fuzzFactor: 0 });

	if (merged === false || typeof merged !== "string") {
		return null;
	}

	if (merged === current) {
		return null;
	}

	return merged;
}
