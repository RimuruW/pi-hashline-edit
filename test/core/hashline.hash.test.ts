import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	computeHashFromContext,
	computeLineHash,
	formatHashlineRegion,
	resolveEditAnchors,
	type HashlineEdit,
} from "../../src/hashline";

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

describe("computeLineHash — context hashing", () => {
	it("returns a 2-char string from NIBBLE_STR alphabet", () => {
		const lines = ["prev", "hello", "next"];
		const hash = computeLineHash(lines, 1);
		expect(hash).toHaveLength(2);
		expect(hash).toMatch(new RegExp(`^[${NIBBLE_STR}]{2}$`));
	});

	it("editing line N changes hashes of exactly N-1, N, N+1 and leaves distant lines unchanged", () => {
		const original = ["a", "b", "c", "d", "e", "f", "g"];
		const modified = ["a", "b", "CHANGED", "d", "e", "f", "g"];

		// Lines 1,2,3,4,5 in original (1-based) = indices 0,1,2,3,4
		// Editing index 2 (line 3 = "c") should affect indices 1,2,3 (lines 2,3,4)
		// Line 1 ("a") and lines 5-7 ("e","f","g") should remain unchanged
		const before = original.map((_, i) => computeLineHash(original, i));
		const after = modified.map((_, i) => computeLineHash(modified, i));

		// Changed: indices 1, 2, 3 (neighbors + self)
		expect(after[1]).not.toBe(before[1]); // prev neighbor changed
		expect(after[2]).not.toBe(before[2]); // self changed
		expect(after[3]).not.toBe(before[3]); // next neighbor changed

		// Unchanged: distant lines
		expect(after[0]).toBe(before[0]); // first line, not adjacent
		expect(after[4]).toBe(before[4]); // 2 away
		expect(after[5]).toBe(before[5]);
		expect(after[6]).toBe(before[6]);
	});

	it("two identical '}' lines with different neighbors get different hashes", () => {
		const lines = ["if (a) {", "}", "if (b) {", "}"];
		const hash1 = computeLineHash(lines, 1); // "}" at index 1
		const hash2 = computeLineHash(lines, 3); // "}" at index 3
		expect(hash1).not.toBe(hash2);
	});

	it("boundary lines hash stably with empty string neighbors", () => {
		const lines = ["first", "second", "third"];
		// First line: prev = ""
		const firstHash = computeLineHash(lines, 0);
		expect(firstHash).toBe(computeHashFromContext("", "first", "second"));
		// Last line: next = ""
		const lastHash = computeLineHash(lines, 2);
		expect(lastHash).toBe(computeHashFromContext("second", "third", ""));
	});

	it("trailing whitespace / \\r still ignored per normalizeHashInput", () => {
		const lines1 = ["prev", "hello   ", "next"];
		const lines2 = ["prev", "hello", "next"];
		expect(computeLineHash(lines1, 1)).toBe(computeLineHash(lines2, 1));

		const lines3 = ["prev", "hello\r", "next"];
		expect(computeLineHash(lines3, 1)).toBe(computeLineHash(lines2, 1));
	});

	it("distant edit leaves far anchor's hash unchanged", () => {
		// 10 lines, edit line 8 → lines 0-6 (7 and prior) should be unaffected
		const original = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
		const modified = [...original];
		modified[7] = "CHANGED_LINE8";

		const beforeHash = computeLineHash(original, 0); // line 1
		const afterHash = computeLineHash(modified, 0);
		expect(afterHash).toBe(beforeHash);

		// lines 0-5 all unchanged (not adjacent to index 7)
		for (let i = 0; i <= 5; i++) {
			expect(computeLineHash(modified, i)).toBe(computeLineHash(original, i));
		}
	});
});

describe("computeHashFromContext", () => {
	it("produces the same result as computeLineHash for internal lines", () => {
		const lines = ["prev", "curr", "next"];
		expect(computeHashFromContext("prev", "curr", "next")).toBe(computeLineHash(lines, 1));
	});
});

describe("strict hashline contract", () => {
	it("preserves internal spaces when hashing", () => {
		const lines1 = ["", "a b", ""];
		const lines2 = ["", "ab", ""];
		expect(computeLineHash(lines1, 1)).not.toBe(computeLineHash(lines2, 1));
	});

	it("preserves explicit blank trailing line in array input", () => {
		const [resolved] = resolveEditAnchors([{ op: "append", lines: ["alpha", ""] }]);
		expect(resolved).toMatchObject({ op: "append", lines: ["alpha", ""] });
	});

	it("rejects stale anchors instead of relocating by hash", () => {
		const fileLines = ["a", "INSERTED", "b", "target", "c"];
		const content = fileLines.join("\n");
		// Anchor for line 3 with hash of "b" (was at line 3 before insert)
		// Now line 3 is "b" but the anchor uses old hash from old context
		const stale: HashlineEdit = {
			op: "replace",
			pos: { line: 3, hash: computeLineHash(["a", "b", "target"], 1) }, // old context hash
			lines: ["updated"],
		};
		expect(() => applyHashlineEdits(content, [stale])).toThrow(/1 stale anchor:/);
	});
});

describe("textHint dual role", () => {
	it("accepts anchor when hash matches and no textHint", () => {
		const fileLines = ["alpha", "beta", "gamma"];
		const content = fileLines.join("\n");
		const hash = computeLineHash(fileLines, 1); // index 1 = "beta"
		const edit: HashlineEdit = {
			op: "replace",
			pos: { line: 2, hash },
			lines: ["REPLACED"],
		};
		expect(() => applyHashlineEdits(content, [edit])).not.toThrow();
	});

	it("accepts anchor when hash matches and textHint fuzzy-matches actual line", () => {
		const fileLines = ["alpha", "beta", "gamma"];
		const content = fileLines.join("\n");
		const hash = computeLineHash(fileLines, 1);
		const edit: HashlineEdit = {
			op: "replace",
			pos: { line: 2, hash, textHint: "beta" }, // exact match
			lines: ["REPLACED"],
		};
		expect(() => applyHashlineEdits(content, [edit])).not.toThrow();
	});

	it("QUESTIONING: rejects anchor when hash matches but textHint clearly differs from actual line", () => {
		// Construct: get real hash of line 2, attach mismatched textHint
		const fileLines = ["alpha", "beta", "gamma"];
		const content = fileLines.join("\n");
		const hash = computeLineHash(fileLines, 1); // real hash of "beta"
		const edit: HashlineEdit = {
			op: "replace",
			pos: { line: 2, hash, textHint: "completely_different_content" },
			lines: ["REPLACED"],
		};
		// Hash matches but textHint doesn't → stale anchor (anti-collision)
		expect(() => applyHashlineEdits(content, [edit])).toThrow(/stale anchor/);
	});

	it("QUESTIONING path fails if hash match wins unconditionally (guard test)", () => {
		// This test validates the questioning behavior: even if the hash matches,
		// a clearly wrong textHint means stale
		const fileLines = ["x", "y", "z"];
		const content = fileLines.join("\n");
		const actualHash = computeLineHash(fileLines, 1); // hash for "y" with context
		const edit: HashlineEdit = {
			op: "replace",
			pos: { line: 2, hash: actualHash, textHint: "NOT_Y_AT_ALL" },
			lines: ["NEW"],
		};
		// Must throw stale anchor — if someone reverts questioning logic, this breaks
		expect(() => applyHashlineEdits(content, [edit])).toThrow(/stale anchor/);
	});

	it("accepts anchor when hash matches and textHint is ellipsis-truncated but the prefix matches", () => {
		// Models abbreviate copied content: "console.log('hello world')" becomes
		// "console.log(...)". Only the prefix before the first ellipsis must match.
		const fileLines = ["alpha", "console.log('hello world')", "gamma"];
		const content = fileLines.join("\n");
		const hash = computeLineHash(fileLines, 1);
		const edit: HashlineEdit = {
			op: "replace",
			pos: { line: 2, hash, textHint: "console.log(...)" },
			lines: ["NEW"],
		};
		expect(() => applyHashlineEdits(content, [edit])).not.toThrow();
	});

	it("accepts anchor with Unicode-ellipsis-truncated textHint", () => {
		const fileLines = ["alpha", "console.log('hello world')", "gamma"];
		const content = fileLines.join("\n");
		const hash = computeLineHash(fileLines, 1);
		const edit: HashlineEdit = {
			op: "replace",
			pos: { line: 2, hash, textHint: "console.log(…" },
			lines: ["NEW"],
		};
		expect(() => applyHashlineEdits(content, [edit])).not.toThrow();
	});

	it("QUESTIONING: still rejects when the ellipsis-truncated prefix disagrees with the actual line", () => {
		const fileLines = ["alpha", "console.log('hello world')", "gamma"];
		const content = fileLines.join("\n");
		const hash = computeLineHash(fileLines, 1);
		const edit: HashlineEdit = {
			op: "replace",
			pos: { line: 2, hash, textHint: "fetchData(...)" },
			lines: ["NEW"],
		};
		expect(() => applyHashlineEdits(content, [edit])).toThrow(/stale anchor/);
	});

	it("treats an ellipsis-leading textHint as carrying no signal (never vetoes)", () => {
		const fileLines = ["alpha", "beta", "gamma"];
		const content = fileLines.join("\n");
		const hash = computeLineHash(fileLines, 1);
		const edit: HashlineEdit = {
			op: "replace",
			pos: { line: 2, hash, textHint: "...('hello world')" },
			lines: ["NEW"],
		};
		expect(() => applyHashlineEdits(content, [edit])).not.toThrow();
	});
});

describe("read with offset/limit produces same hashes as full read", () => {
	it("hashes for lines in a slice match hashes computed from the full file", () => {
		// Simulate: full file of 10 lines, reading lines 4-7 (offset=4, limit=4)
		const fullFile = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
		// Hashes computed from full file for lines 4-7 (1-based) = indices 3-6
		const fullHashes = [3, 4, 5, 6].map((i) => computeLineHash(fullFile, i));
		// These must equal hashes from formatHashlineRegion which receives the full file
		// (formatHashlineRegion(fullFile, 4, 7) should use fullFile not a slice)
		const regionOutput = formatHashlineRegion(fullFile, 4, 7);
		// Extract hashes from the formatted output
		const outputHashes = regionOutput.split("\n").map((line) => {
			const m = line.match(/^[0-9 ]+#([A-Z]{2}):/);
			return m?.[1];
		});
		expect(outputHashes).toEqual(fullHashes);
	});
});
