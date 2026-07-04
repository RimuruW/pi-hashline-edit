import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
	__resetConfigForTests,
	__setHashLengthForTests,
} from "../../src/config";
import {
	computeHashFromContext,
	computeLineHash,
	NIBBLE_STR,
	xxh32,
} from "../../src/hashline/hash";
import {
	applyHashlineEdits,
	formatHashlineRegion,
	resolveEditAnchors,
} from "../../src/hashline";

afterEach(() => {
	__resetConfigForTests();
});

// ─── Hash output shape at different lengths ─────────────────────────────

describe("computeHashFromContext — output length matches config", () => {
	it("produces 2-char hash at default length 2", () => {
		const h = computeHashFromContext("prev", "curr", "next");
		expect(h).toHaveLength(2);
		expect(h).toMatch(new RegExp(`^[${NIBBLE_STR}]{2}$`));
	});

	it("produces 3-char hash at length 3", () => {
		__setHashLengthForTests(3);
		const h = computeHashFromContext("prev", "curr", "next");
		expect(h).toHaveLength(3);
		expect(h).toMatch(new RegExp(`^[${NIBBLE_STR}]{3}$`));
	});

	it("produces 4-char hash at length 4", () => {
		__setHashLengthForTests(4);
		const h = computeHashFromContext("prev", "curr", "next");
		expect(h).toHaveLength(4);
		expect(h).toMatch(new RegExp(`^[${NIBBLE_STR}]{4}$`));
	});

	it("computeLineHash returns correct length at len 4", () => {
		__setHashLengthForTests(4);
		const lines = ["a", "b", "c"];
		expect(computeLineHash(lines, 1)).toHaveLength(4);
	});
});

// ─── len=2 backward compatibility: nibble encoding equivalence ──────────

describe("computeHashFromContext — len=2 backward compatibility", () => {
	it("matches nibble-by-nibble encoding for known inputs", () => {
		// At len=2, the new code extracts nibble[1] then nibble[0] of (h & 0xff).
		// This is identical to the old DICT path: NIBBLE_STR[h>>4] + NIBBLE_STR[h&0xf].
		const cases = [
			["", "hello", "world"],
			["prev", "const x = 1;", "next"],
			["", "", ""],
			["alpha", "beta", "gamma"],
		] as const;

		for (const [prev, curr, next] of cases) {
			const h = xxh32(prev + "\0" + curr + "\0" + next);
			const byte = h & 0xff;
			const expected = NIBBLE_STR[byte >>> 4]! + NIBBLE_STR[byte & 0x0f]!;
			const actual = computeHashFromContext(prev, curr, next);
			expect(actual).toBe(expected);
		}
	});
});

// ─── len=4 full roundtrip ─────────────────────────────────────────────────

describe("len=4 full roundtrip: format → apply", () => {
	it("anchors produced by formatHashlineRegion are valid for applyHashlineEdits", () => {
		__setHashLengthForTests(4);

		const fileContent = "line one\nline two\nline three\n";
		const fileLines = fileContent.split("\n").slice(0, 3); // ["line one", "line two", "line three"]

		const formatted = formatHashlineRegion(fileLines, 1, 3);
		// formatted looks like: "1#XXXX:line one\n2#XXXX:line two\n3#XXXX:line three"
		const hashMatch = formatted.split("\n")[1]!.match(/^\d+#([A-Z]{4}):/);
		expect(hashMatch).not.toBeNull();
		const hash = hashMatch![1]!;
		expect(hash).toHaveLength(4);

		const edits = resolveEditAnchors([
			{ op: "replace", pos: `2#${hash}`, lines: ["REPLACED LINE"] },
		]);

		const result = applyHashlineEdits(fileContent, edits);
		expect(result.content).toContain("REPLACED LINE");
		expect(result.content).not.toContain("line two");
	});
});

// ─── Length mismatch error messages ──────────────────────────────────────

describe("len=4 session: 2-char anchor triggers stale-context error", () => {
	beforeEach(() => {
		__setHashLengthForTests(4);
	});

	it("throws specific stale-context error when 2-char hash is valid alphabet but wrong length", () => {
		expect(() =>
			resolveEditAnchors([{ op: "replace", pos: "5#MQ", lines: ["x"] }]),
		).toThrow(/stale context or a different configuration/);
	});

	it("stale-context error includes current session length and anchor length", () => {
		let errorMsg = "";
		try {
			resolveEditAnchors([{ op: "replace", pos: "5#MQ", lines: ["x"] }]);
		} catch (err: unknown) {
			errorMsg = (err as Error).message;
		}
		expect(errorMsg).toMatch(/hash length is 4 in this session/);
		expect(errorMsg).toMatch(/this anchor has 2 characters/);
		expect(errorMsg).toMatch(/Re-read the file/);
	});
});

describe("len=2 session: 4-char anchor triggers stale-context error", () => {
	it("throws stale-context error for 4-char hash when config is len=2", () => {
		// Default is 2
		expect(() =>
			resolveEditAnchors([{ op: "replace", pos: "5#MQQV", lines: ["x"] }]),
		).toThrow(/stale context or a different configuration/);
	});

	it("error includes session length 2 and anchor length 4", () => {
		let errorMsg = "";
		try {
			resolveEditAnchors([{ op: "replace", pos: "5#MQQV", lines: ["x"] }]);
		} catch (err: unknown) {
			errorMsg = (err as Error).message;
		}
		expect(errorMsg).toMatch(/hash length is 2 in this session/);
		expect(errorMsg).toMatch(/this anchor has 4 characters/);
		expect(errorMsg).toMatch(/Re-read the file/);
	});
});

// ─── Error messages use exampleAnchor from config ────────────────────────

describe("error messages reference configured length example", () => {
	it("invalid ref at len=3 uses 3-char example anchor", () => {
		__setHashLengthForTests(3);
		let errorMsg = "";
		try {
			resolveEditAnchors([{ op: "replace", pos: "invalid", lines: ["x"] }]);
		} catch (err: unknown) {
			errorMsg = (err as Error).message;
		}
		// Should mention a 3-char example like "5#MQQ"
		expect(errorMsg).toMatch(/5#MQQ/);
	});
});
