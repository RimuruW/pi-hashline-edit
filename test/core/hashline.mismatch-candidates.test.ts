import { describe, expect, it } from "vitest";
import { applyHashlineEdits, computeLineHash } from "../../src/hashline";

/**
 * Build a stale anchor: the hash is from the file's old state (before a line
 * moved), but the anchor carries a textHint matching the original content.
 * This simulates a model that had a fresh anchor at `originalLine` in the
 * original file, then the file was edited so that content drifted to `newLine`.
 */
function makeStaleAnchorWithHint(
	originalContent: string,
	originalLine: number,
	textHint: string,
): { line: number; hash: string; textHint: string } {
	const fileLines = originalContent.split("\n");
	return {
		line: originalLine,
		hash: computeLineHash(fileLines, originalLine - 1),
		textHint,
	};
}

describe("formatMismatchError — Did you mean candidates", () => {
	it("AC1: stale anchor with textHint, target drifted beyond ±2 window, shows Did you mean", () => {
		// 10-line file; original anchor was at line 2 ("target line"), target drifted to line 9.
		const originalContent = [
			"line1",
			"target line",
			"line3",
			"line4",
			"line5",
		].join("\n");

		// Now the file has changed — "target line" moved to line 9 (far from original line 2).
		const currentContent = [
			"line1",
			"something else",
			"line3",
			"line4",
			"line5",
			"line6",
			"line7",
			"line8",
			"target line",
			"line10",
		].join("\n");

		// Anchor is stale: refers to line 2 with the OLD hash, textHint = "target line".
		const staleAnchor = makeStaleAnchorWithHint(originalContent, 2, "target line");

		const edits = [{ op: "replace" as const, pos: staleAnchor, lines: ["replaced"] }];

		let errorMessage: string | undefined;
		try {
			applyHashlineEdits(currentContent, edits);
		} catch (e) {
			errorMessage = (e as Error).message;
		}

		expect(errorMessage).toBeDefined();
		expect(errorMessage).toContain("Did you mean");

		// The candidate should be line 9 with a fresh hash.
		const currentLines = currentContent.split("\n");
		const freshHash = computeLineHash(currentLines, 8); // line 9 is index 8
		expect(errorMessage).toContain(`9#${freshHash}:target line`);
	});

	it("AC1: candidate hash value is correct (matches computeLineHash for that line)", () => {
		const originalContent = ["anchor", "keep"].join("\n");
		const currentContent = ["keep", "anchor"].join("\n");

		const staleAnchor = makeStaleAnchorWithHint(originalContent, 1, "anchor");
		const edits = [{ op: "replace" as const, pos: staleAnchor, lines: ["X"] }];

		let errorMessage: string | undefined;
		try {
			applyHashlineEdits(currentContent, edits);
		} catch (e) {
			errorMessage = (e as Error).message;
		}

		expect(errorMessage).toBeDefined();

		const currentLines = currentContent.split("\n");
		const freshHash = computeLineHash(currentLines, 1); // "anchor" is at line 2 (index 1)
		// Candidate should carry the fresh hash so the model can directly retry.
		expect(errorMessage).toContain(`2#${freshHash}:anchor`);
	});

	it("AC2: same textHint matches > 3 lines — overflow shows 'N similar lines found' instead of listing", () => {
		// "dup line" appears 4 times outside the ±2 display window; exceeds per-anchor limit of 3.
		const originalContent = ["dup line", "x"].join("\n");
		const currentContent = [
			"something",     // line 1 (stale pos)
			"dup line",      // line 2 — inside ±2 window of pos=1, excluded from candidates
			"middle",
			"dup line",      // line 4
			"middle",
			"dup line",      // line 6
			"middle",
			"dup line",      // line 8
			"middle",
			"dup line",      // line 10
		].join("\n");

		const staleAnchor = makeStaleAnchorWithHint(originalContent, 1, "dup line");
		const edits = [{ op: "replace" as const, pos: staleAnchor, lines: ["X"] }];

		let errorMessage: string | undefined;
		try {
			applyHashlineEdits(currentContent, edits);
		} catch (e) {
			errorMessage = (e as Error).message;
		}

		expect(errorMessage).toBeDefined();
		// Per-anchor limit is 3; lines 4,6,8,10 are 4 matches outside the window → overflow.
		// The "Did you mean" header still appears, but the overflow message replaces per-candidate lines.
		expect(errorMessage).toContain("Did you mean");
		expect(errorMessage).toContain("similar lines found");
		// Individual LINE#HASH:content candidates should NOT be listed.
		expect(errorMessage).not.toMatch(/\d+#[A-Z]{2}:dup line\s+← for stale/);
	});

	it("AC2: fewer than 3 candidates listed individually", () => {
		// "unique target" appears exactly 2 times in the file, both outside the ±2 display window.
		const originalContent = ["unique target", "x"].join("\n");
		const currentContent = [
			"line1",
			"other",
			"line3",
			"line4",
			"unique target",  // line 5
			"line6",
			"line7",
			"line8",
			"unique target",  // line 9
			"line10",
		].join("\n");

		const staleAnchor = makeStaleAnchorWithHint(originalContent, 1, "unique target");
		const edits = [{ op: "replace" as const, pos: staleAnchor, lines: ["X"] }];

		let errorMessage: string | undefined;
		try {
			applyHashlineEdits(currentContent, edits);
		} catch (e) {
			errorMessage = (e as Error).message;
		}

		expect(errorMessage).toBeDefined();
		expect(errorMessage).toContain("Did you mean");

		const currentLines = currentContent.split("\n");
		const hash5 = computeLineHash(currentLines, 4);
		const hash9 = computeLineHash(currentLines, 8);
		expect(errorMessage).toContain(`5#${hash5}:unique target`);
		expect(errorMessage).toContain(`9#${hash9}:unique target`);
	});

	it("AC2: total candidates > 8 across anchors → overflow message for affected anchor", () => {
		// Two stale anchors; first anchor has 5 matches, second has 4 — total 9 > 8.
		const originalContent = ["dup line", "other dup", "x"].join("\n");
		const currentContent = [
			"something",    // line 1 (stale pos for anchor1)
			"dup line",     // line 2
			"dup line",     // line 3
			"dup line",     // line 4
			"dup line",     // line 5
			"dup line",     // line 6
			"other dup",    // line 7
			"other dup",    // line 8
			"other dup",    // line 9
			"other dup",    // line 10
			"end",
		].join("\n");

		const staleAnchor1 = makeStaleAnchorWithHint(originalContent, 1, "dup line");
		const staleAnchor2 = makeStaleAnchorWithHint(originalContent, 2, "other dup");

		const edits = [
			{ op: "replace" as const, pos: staleAnchor1, lines: ["X"] },
			{ op: "replace" as const, pos: staleAnchor2, lines: ["Y"] },
		];

		let errorMessage: string | undefined;
		try {
			applyHashlineEdits(currentContent, edits);
		} catch (e) {
			errorMessage = (e as Error).message;
		}

		expect(errorMessage).toBeDefined();
		// At least one anchor should hit the overflow/similar-lines path.
		expect(errorMessage).toContain("similar lines found");
	});

	it("AC3: no textHint → no Did you mean section, existing format unchanged", () => {
		const content = "aaa\nbbb\nccc";
		const edits = [{ op: "replace" as const, pos: { line: 2, hash: "XX" }, lines: ["B"] }];

		let errorMessage: string | undefined;
		try {
			applyHashlineEdits(content, edits);
		} catch (e) {
			errorMessage = (e as Error).message;
		}

		expect(errorMessage).toBeDefined();
		expect(errorMessage).toContain("[E_STALE_ANCHOR]");
		expect(errorMessage).toContain("Stale refs: 2#XX");
		expect(errorMessage).not.toContain("Did you mean");
	});

	it("AC3: existing mismatch/recovery tests — stale anchor without hint still shows >>>", () => {
		expect(() =>
			applyHashlineEdits("aaa", [{ op: "replace", pos: { line: 1, hash: "ZZ" }, lines: ["bbb"] }]),
		).toThrow(/>>> 1#[A-Z]{2}:aaa/);
	});

	it("AC3: multiple mismatches without hints still list Stale refs correctly", () => {
		const content = "aaa\nbbb\nccc";
		const edits = [
			{ op: "replace" as const, pos: { line: 1, hash: "XX" }, lines: ["A"] },
			{ op: "replace" as const, pos: { line: 3, hash: "YY" }, lines: ["C"] },
		];

		expect(() => applyHashlineEdits(content, edits)).toThrow(/2 stale anchors\./);
		expect(() => applyHashlineEdits(content, edits)).toThrow(/Stale refs: 1#XX, 3#YY/);
		// Neither has a textHint so no candidates section.
		try {
			applyHashlineEdits(content, edits);
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).not.toContain("Did you mean");
		}
	});

	it("candidate lines inside the ±2 display window are excluded from Did you mean", () => {
		// "target" appears at line 2 (inside the ±2 display window of stale anchor pos=2) and line 10 (outside).
		const currentContent = [
			"line1",
			"target",    // line 2 — inside the ±2 window of stale anchor at line 2
			"line3",
			"line4",
			"line5",
			"line6",
			"line7",
			"line8",
			"line9",
			"target",    // line 10 — outside window
		].join("\n");

		// Stale anchor refers to line 2 but with the wrong hash (so it mismatches).
		const staleAnchor = { line: 2, hash: "ZZ", textHint: "target" };

		const edits = [{ op: "replace" as const, pos: staleAnchor, lines: ["X"] }];

		let errorMessage: string | undefined;
		try {
			applyHashlineEdits(currentContent, edits);
		} catch (e) {
			errorMessage = (e as Error).message;
		}

		expect(errorMessage).toBeDefined();
		// Line 2 is inside the display window → should NOT appear in candidates.
		// Line 10 is outside → should appear as candidate.
		const currentLines = currentContent.split("\n");
		const hash10 = computeLineHash(currentLines, 9);
		expect(errorMessage).toContain(`10#${hash10}:target`);
		// Line 2 should only appear in the standard display block (>>> or    ), not in candidates.
		const candidateSection = errorMessage!.split("Did you mean")[1] ?? "";
		expect(candidateSection).not.toContain("  2#");
	});
});
