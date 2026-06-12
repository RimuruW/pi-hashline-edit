import { describe, expect, it } from "vitest";
import { resolveEditAnchors } from "../../src/hashline";

// Anchor parsing is exercised through resolveEditAnchors — the same seam the
// edit tool crosses — instead of a test-only parsing export.
function parseRef(ref: string): { line: number; hash: string } {
	const [resolved] = resolveEditAnchors([{ op: "append", pos: ref, lines: [] }]);
	if (resolved?.op !== "append" || !resolved.pos) {
		throw new Error("expected resolved append edit with a pos anchor");
	}
	return { line: resolved.pos.line, hash: resolved.pos.hash };
}

describe("anchor reference parsing", () => {
	it("parses standard LINE#HASH format", () => {
		expect(parseRef("5#MQ")).toEqual({ line: 5, hash: "MQ" });
	});

	it("parses with trailing content", () => {
		expect(parseRef("10#ZP:  const x = 1;")).toEqual({ line: 10, hash: "ZP" });
	});

	it("tolerates leading >>> markers", () => {
		expect(parseRef(">>> 5#MQ:content")).toEqual({ line: 5, hash: "MQ" });
	});

	it("tolerates leading +/- diff markers", () => {
		expect(parseRef("+5#MQ")).toEqual({ line: 5, hash: "MQ" });
		expect(parseRef("-5#MQ")).toEqual({ line: 5, hash: "MQ" });
	});

	it("throws on invalid format", () => {
		expect(() => parseRef("invalid")).toThrow(/Invalid line reference/);
	});

	it("diagnoses missing hash", () => {
		expect(() => parseRef("12")).toThrow(/missing hash/i);
	});

	it("diagnoses wrong separator", () => {
		expect(() => parseRef("5:AB")).toThrow(/wrong separator/i);
	});

	it("diagnoses invalid hash alphabet", () => {
		expect(() => parseRef("12#ab")).toThrow(/alphabet ZPMQVRWSNKTXJBYH only/i);
	});

	it("diagnoses invalid hash length", () => {
		expect(() => parseRef("12#ABC")).toThrow(/hash must be exactly 2 characters/i);
	});

	it("throws on line 0", () => {
		expect(() => parseRef("0#MQ")).toThrow(/must be >= 1/);
	});

	it("prefixes structured errors with [E_BAD_REF]", () => {
		expect(() => parseRef("invalid")).toThrow(/^\[E_BAD_REF\]/);
	});
});

describe("replacement lines validation", () => {
	function parseLines(lines: string[]): string[] {
		const [resolved] = resolveEditAnchors([{ op: "append", lines }]);
		if (resolved?.op !== "append") {
			throw new Error("expected resolved append edit");
		}
		return resolved.lines;
	}

	it("passes through array input verbatim", () => {
		expect(parseLines(["a", "b"])).toEqual(["a", "b"]);
	});

	it("preserves '# Note:' comment lines (no autocorrection)", () => {
		expect(parseLines(["# Note: important"])).toEqual(["# Note: important"]);
	});

	it("preserves literal '+' prefixed content (no autocorrection)", () => {
		expect(parseLines(["+added"])).toEqual(["+added"]);
	});

	it("rejects array input that contains LINE#HASH: prefixes", () => {
		expect(() => parseLines(["1#ZZ:foo", "2#MQ:bar"])).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("rejects diff-preview hunks with + and context hash prefixes", () => {
		expect(() =>
			parseLines([" 9#MQ:keep", "+10#VR:new", " 11#WS:after"]),
		).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("rejects diff-preview deletion rows", () => {
		expect(() =>
			parseLines([" 9#MQ:keep", "-10    old", " 11#WS:after"]),
		).toThrow(/^\[E_INVALID_PATCH\]/);
	});
});
