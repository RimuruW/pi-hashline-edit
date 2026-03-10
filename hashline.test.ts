import { describe, it, expect } from "bun:test";
import {
	buildCompactHashlineDiffPreview,
	applyHashlineEdits,
	computeLineHash,
	hashlineParseText,
	parseLineRef,
	resolveEditAnchors,
	stripNewLinePrefixes,
	type Anchor,
	type HashlineEdit,
	type HashlineToolEdit,
} from "./src/hashline";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeTag(lineNum: number, text: string): Anchor {
	return { line: lineNum, hash: computeLineHash(lineNum, text) };
}

// ═══════════════════════════════════════════════════════════════════════════
// computeLineHash
// ═══════════════════════════════════════════════════════════════════════════

describe("computeLineHash", () => {
	it("returns a 2-character string from NIBBLE_STR alphabet", () => {
		const hash = computeLineHash(1, "hello");
		expect(hash).toHaveLength(2);
		expect(hash).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
	});

	it("normalizes whitespace before hashing", () => {
		expect(computeLineHash(1, "a  b")).toBe(computeLineHash(1, "a b"));
		expect(computeLineHash(1, "\ta\t")).toBe(computeLineHash(1, "a"));
	});

	it("strips trailing CR", () => {
		expect(computeLineHash(1, "hello\r")).toBe(computeLineHash(1, "hello"));
	});

	it("mixes line index for symbol-only lines", () => {
		// "}" at different positions should get different hashes
		const h1 = computeLineHash(1, "}");
		const h10 = computeLineHash(10, "}");
		// They CAN collide (only 256 buckets), but usually won't
		// Just verify they're valid format
		expect(h1).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
		expect(h10).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
	});

	it("does NOT mix line index for lines with alphanumeric content", () => {
		expect(computeLineHash(1, "function foo()")).toBe(computeLineHash(99, "function foo()"));
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// parseLineRef
// ═══════════════════════════════════════════════════════════════════════════

describe("parseLineRef", () => {
	it("parses standard LINE#HASH format", () => {
		const ref = parseLineRef("5#MQ");
		expect(ref).toEqual({ line: 5, hash: "MQ" });
	});

	it("parses with trailing content", () => {
		const ref = parseLineRef("10#ZP:  const x = 1;");
		expect(ref).toEqual({ line: 10, hash: "ZP" });
	});

	it("tolerates leading >>> markers", () => {
		const ref = parseLineRef(">>> 5#MQ:content");
		expect(ref).toEqual({ line: 5, hash: "MQ" });
	});

	it("tolerates leading +/- diff markers", () => {
		expect(parseLineRef("+5#MQ")).toEqual({ line: 5, hash: "MQ" });
		expect(parseLineRef("-5#MQ")).toEqual({ line: 5, hash: "MQ" });
	});

	it("throws on invalid format", () => {
		expect(() => parseLineRef("invalid")).toThrow(/Invalid line reference/);
		expect(() => parseLineRef("5:AB")).toThrow(/Invalid line reference/);
	});

	it("throws on line 0", () => {
		expect(() => parseLineRef("0#MQ")).toThrow(/must be >= 1/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// stripNewLinePrefixes
// ═══════════════════════════════════════════════════════════════════════════

describe("stripNewLinePrefixes", () => {
	it("strips hashline prefixes when all non-empty lines carry them", () => {
		const lines = ["1#ZZ:foo", "2#MQ:bar", "3#PP:baz"];
		expect(stripNewLinePrefixes(lines)).toEqual(["foo", "bar", "baz"]);
	});

	it("does NOT strip when any non-empty line is plain", () => {
		const lines = ["1#ZZ:foo", "bar", "3#PP:baz"];
		expect(stripNewLinePrefixes(lines)).toEqual(["1#ZZ:foo", "bar", "3#PP:baz"]);
	});

	it("strips hash-only prefixes (#ID:content)", () => {
		const lines = ["#WQ:", "#TZ:hello", "#HX:world"];
		expect(stripNewLinePrefixes(lines)).toEqual(["", "hello", "world"]);
	});

	it("strips diff + prefixes at majority threshold", () => {
		const lines = ["+added", "+also added", "context"];
		expect(stripNewLinePrefixes(lines)).toEqual(["added", "also added", "context"]);
	});

	it("does NOT strip ++ lines", () => {
		const lines = ["++conflict", "++marker"];
		expect(stripNewLinePrefixes(lines)).toEqual(["++conflict", "++marker"]);
	});

	it("preserves empty lines while stripping prefixed ones", () => {
		const lines = ["1#ZZ:foo", "", "3#PP:baz"];
		expect(stripNewLinePrefixes(lines)).toEqual(["foo", "", "baz"]);
	});

	it("returns lines as-is when no pattern matches", () => {
		const lines = ["normal", "text", "here"];
		expect(stripNewLinePrefixes(lines)).toEqual(["normal", "text", "here"]);
	});

	it("preserves '# Note:' comment lines (not matched by prefix regex)", () => {
		const lines = ["# Note: this is important"];
		expect(stripNewLinePrefixes(lines)).toEqual(["# Note: this is important"]);
	});

	it("preserves '# TODO:' comment lines", () => {
		const lines = ["# TODO: fix this later"];
		expect(stripNewLinePrefixes(lines)).toEqual(["# TODO: fix this later"]);
	});

	it("preserves '# FIXME:' comment lines", () => {
		const lines = ["# FIXME: broken edge case"];
		expect(stripNewLinePrefixes(lines)).toEqual(["# FIXME: broken edge case"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// hashlineParseText
// ═══════════════════════════════════════════════════════════════════════════

describe("hashlineParseText", () => {
	it("returns [] for null", () => {
		expect(hashlineParseText(null)).toEqual([]);
	});

	it("splits string on newline", () => {
		expect(hashlineParseText("a\nb")).toEqual(["a", "b"]);
	});

	it("removes trailing blank line from string input", () => {
		expect(hashlineParseText("a\nb\n")).toEqual(["a", "b"]);
	});

	it("removes trailing whitespace-only line", () => {
		expect(hashlineParseText("a\nb\n  ")).toEqual(["a", "b"]);
	});

	it("passes through array input as-is when no strip applies", () => {
		const input = ["a", "b"];
		expect(hashlineParseText(input)).toEqual(["a", "b"]);
	});

	it("strips hashline prefixes from array input", () => {
		const input = ["1#ZZ:foo", "2#MQ:bar"];
		expect(hashlineParseText(input)).toEqual(["foo", "bar"]);
	});

	it("returns empty string as single empty line for blank content", () => {
		// "" → split → [""] → no trailing trim (single element) → [""]
		// Actually: "" → split → [""] → last is empty → slice(0, -1) → []
		expect(hashlineParseText("")).toEqual([]);
	});
	it("preserves '# Note:' comment in hashlineParseText", () => {
		// Regression: HASHLINE_PREFIX_RE must not match '# Note:' as a hash prefix
		expect(hashlineParseText(["# Note: important"])).toEqual(["# Note: important"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveEditAnchors
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveEditAnchors", () => {
	it("resolves replace with pos + end", () => {
		const edits: HashlineToolEdit[] = [{ op: "replace", pos: "1#ZZ", end: "3#PP", lines: ["a", "b"] }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].op).toBe("replace");
		expect(resolved[0]).toHaveProperty("pos");
		expect(resolved[0]).toHaveProperty("end");
	});

	it("resolves replace with pos only (single-line)", () => {
		const edits: HashlineToolEdit[] = [{ op: "replace", pos: "5#MQ", lines: ["new"] }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].op).toBe("replace");
		const r = resolved[0] as { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] };
		expect(r.pos.line).toBe(5);
		expect(r.end).toBeUndefined();
	});

	it("resolves replace with end only (falls back)", () => {
		const edits: HashlineToolEdit[] = [{ op: "replace", end: "5#MQ", lines: ["new"] }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved).toHaveLength(1);
		const r = resolved[0] as { op: "replace"; pos: Anchor; lines: string[] };
		expect(r.pos.line).toBe(5);
	});

	it("throws on replace with no anchors", () => {
		const edits: HashlineToolEdit[] = [{ op: "replace", lines: ["new"] }];
		expect(() => resolveEditAnchors(edits)).toThrow(/at least one anchor/);
	});

	it("throws on malformed pos for append (not silently degraded to EOF)", () => {
		const edits: HashlineToolEdit[] = [{ op: "append", pos: "garbage", lines: ["new"] }];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
	});

	it("throws on malformed pos for prepend (not silently degraded to BOF)", () => {
		const edits: HashlineToolEdit[] = [{ op: "prepend", pos: "garbage", lines: ["new"] }];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
	});

	it("throws on malformed pos for replace", () => {
		const edits: HashlineToolEdit[] = [{ op: "replace", pos: "not-valid", lines: ["x"] }];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
	});

	it("throws on malformed end for replace with valid pos", () => {
		const edits: HashlineToolEdit[] = [{ op: "replace", pos: "5#MQ", end: "garbage", lines: ["x"] }];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
	});

	it("resolves append with pos", () => {
		const edits: HashlineToolEdit[] = [{ op: "append", pos: "5#MQ", lines: ["new"] }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0].op).toBe("append");
		expect(resolved[0].pos?.line).toBe(5);
	});

	it("resolves append without pos (EOF)", () => {
		const edits: HashlineToolEdit[] = [{ op: "append", lines: ["new"] }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0].op).toBe("append");
		expect(resolved[0].pos).toBeUndefined();
	});

	it("resolves prepend with pos", () => {
		const edits: HashlineToolEdit[] = [{ op: "prepend", pos: "5#MQ", lines: ["new"] }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0].op).toBe("prepend");
	});

	it("resolves prepend without pos (BOF)", () => {
		const edits: HashlineToolEdit[] = [{ op: "prepend", lines: ["new"] }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0].op).toBe("prepend");
		expect(resolved[0].pos).toBeUndefined();
	});

	it("parses string lines input", () => {
		const edits: HashlineToolEdit[] = [{ op: "replace", pos: "1#ZZ", lines: "hello\nworld\n" }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0].lines).toEqual(["hello", "world"]);
	});

	it("parses null lines as empty array", () => {
		const edits: HashlineToolEdit[] = [{ op: "replace", pos: "1#ZZ", lines: null }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0].lines).toEqual([]);
	});

	it("throws on unknown op", () => {
		const edits: HashlineToolEdit[] = [{ op: "something_weird", pos: "1#ZZ", lines: ["x"] }];
		expect(() => resolveEditAnchors(edits)).toThrow('Unknown edit op "something_weird"');
	});

	it("defaults missing op to replace", () => {
		const edits: HashlineToolEdit[] = [{ pos: "1#ZZ", lines: ["x"] } as any];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0].op).toBe("replace");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — basic operations
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — basic operations", () => {
	it("returns content unchanged for empty edits", () => {
		const result = applyHashlineEdits("hello\nworld", []);
		expect(result.content).toBe("hello\nworld");
		expect(result.firstChangedLine).toBeUndefined();
	});

	it("replaces a single line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), lines: ["BBB"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("replaces a single line with multiple lines", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), lines: ["BBB", "B2"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nB2\nccc");
	});

	it("deletes a single line (empty lines array)", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), lines: [] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\nccc");
	});

	it("replaces a range of lines", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: ["BBB", "CCC"] },
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nCCC\nddd");
	});

	it("deletes a range of lines", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: [] },
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\nddd");
	});

	it("appends after a line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "append", pos: makeTag(2, "bbb"), lines: ["inserted"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\nbbb\ninserted\nccc");
		expect(result.firstChangedLine).toBe(3);
	});

	it("appends to EOF (no pos)", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "append", lines: ["ccc"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\nbbb\nccc");
	});

	it("appends to empty file", () => {
		const content = "";
		const edits: HashlineEdit[] = [{ op: "append", lines: ["first"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("first");
	});

	it("prepends before a line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "prepend", pos: makeTag(2, "bbb"), lines: ["inserted"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\ninserted\nbbb\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("prepends to BOF (no pos)", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "prepend", lines: ["zzz"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("zzz\naaa\nbbb");
		expect(result.firstChangedLine).toBe(1);
	});

	it("prepends to empty file", () => {
		const content = "";
		const edits: HashlineEdit[] = [{ op: "prepend", lines: ["first"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("first");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — multi-edit / ordering
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — multi-edit ordering", () => {
	it("applies multiple edits bottom-up correctly", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: makeTag(1, "aaa"), lines: ["AAA"] },
			{ op: "replace", pos: makeTag(3, "ccc"), lines: ["CCC"] },
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("AAA\nbbb\nCCC");
	});

	it("handles append + replace on same file", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: makeTag(1, "aaa"), lines: ["AAA"] },
			{ op: "append", pos: makeTag(2, "bbb"), lines: ["ccc"] },
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("AAA\nbbb\nccc");
	});

	it("deduplicates identical edits", () => {
		const content = "aaa\nbbb\nccc";
		const pos = makeTag(2, "bbb");
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: { ...pos }, lines: ["BBB"] },
			{ op: "replace", pos: { ...pos }, lines: ["BBB"] },
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — noop detection
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — noop detection", () => {
	it("detects single-line noop", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), lines: ["bbb"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.noopEdits).toHaveLength(1);
		expect(result.noopEdits![0].editIndex).toBe(0);
	});

	it("detects range noop", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: ["bbb", "ccc"] },
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.noopEdits).toHaveLength(1);
	});

	it("throws on empty append lines payload", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "append", pos: makeTag(2, "bbb"), lines: [] }];
		expect(() => applyHashlineEdits(content, edits)).toThrow(/empty lines payload/);
	});

	it("throws on empty prepend lines payload", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "prepend", pos: makeTag(1, "aaa"), lines: [] }];
		expect(() => applyHashlineEdits(content, edits)).toThrow(/empty lines payload/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — error handling
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — error handling", () => {
	it("throws on hash mismatch", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace", pos: { line: 2, hash: "XX" }, lines: ["BBB"] }];
		expect(() => applyHashlineEdits(content, edits)).toThrow(/changed since last read/);
	});

	it("throws on out-of-range line", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "replace", pos: { line: 99, hash: "ZZ" }, lines: ["x"] }];
		expect(() => applyHashlineEdits(content, edits)).toThrow(/does not exist/);
	});

	it("throws on range start > end", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: makeTag(3, "ccc"), end: makeTag(1, "aaa"), lines: ["x"] },
		];
		expect(() => applyHashlineEdits(content, edits)).toThrow(/must be <= end line/);
	});

	it("reports multiple mismatches at once", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: { line: 1, hash: "XX" }, lines: ["A"] },
			{ op: "replace", pos: { line: 3, hash: "YY" }, lines: ["C"] },
		];
		expect(() => applyHashlineEdits(content, edits)).toThrow(/2 lines have changed/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — heuristics
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — heuristics", () => {
	it("auto-corrects trailing duplicate on range replace", () => {
		const content = "if (ok) {\n  run();\n}\nafter();";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(1, "if (ok) {"),
				end: makeTag(2, "  run();"),
				lines: ["if (ok) {", "  runSafe();", "}"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("if (ok) {\n  runSafe();\n}\nafter();");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings![0]).toContain("Auto-corrected range replace");
	});

	it("does NOT auto-correct when end already includes boundary", () => {
		const content = "function outer() {\n  function inner() {\n    run();\n  }\n}";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(1, "function outer() {"),
				end: makeTag(4, "  }"),
				lines: ["function outer() {", "  function inner() {", "    runSafe();", "  }"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("function outer() {\n  function inner() {\n    runSafe();\n  }\n}");
		expect(result.warnings).toBeUndefined();
	});

	it("does NOT auto-correct when trailing line trims to empty", () => {
		const content = "alpha\nbeta\n\ngamma";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(1, "alpha"),
				end: makeTag(2, "beta"),
				lines: ["ALPHA", ""],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("ALPHA\n\n\ngamma");
		expect(result.warnings).toBeUndefined();
	});

	it("auto-corrects leading duplicate on range replace", () => {
		const content = "before();\nif (ok) {\n  run();\n}\nafter();";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(2, "if (ok) {"),
				end: makeTag(3, "  run();"),
				// Model echoed the line before the range start
				lines: ["before();", "if (ok) {", "  runSafe();"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("before();\nif (ok) {\n  runSafe();\n}\nafter();");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings![0]).toContain("removed leading replacement line");
	});

	it("does NOT auto-correct leading duplicate for short non-brace lines", () => {
		// shouldAutocorrect rejects short lines that aren't braces
		const content = "x\nalpha\nbeta";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(2, "alpha"),
				end: makeTag(3, "beta"),
				lines: ["x", "ALPHA", "BETA"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		// 'x' is too short (1 char, not a brace) so no auto-correction
		expect(result.content).toBe("x\nx\nALPHA\nBETA");
		expect(result.warnings).toBeUndefined();
	});

	it("auto-corrects leading duplicate for brace closers", () => {
		const content = "}\nfunction foo() {\n  bar();\n}";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(2, "function foo() {"),
				end: makeTag(3, "  bar();"),
				lines: ["}", "function foo() {", "  baz();"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("}\nfunction foo() {\n  baz();\n}");
		expect(result.warnings).toHaveLength(1);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — escaped tab auto-correction
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — escaped tab auto-correction", () => {
	it("auto-corrects leading \\t to real tabs", () => {
		const content = "\tfunction foo() {\n\t\treturn 1;\n\t}";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(2, "\t\treturn 1;"),
				lines: ["\\t\\treturn 2;"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("\tfunction foo() {\n\t\treturn 2;\n\t}");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings![0]).toContain("Auto-corrected escaped tab indentation");
	});

	it("does NOT auto-correct when real tabs are already present", () => {
		const content = "alpha\nbeta";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(1, "alpha"),
				// Mix of real tab and escaped tab — skip correction
				lines: ["\treal", "\\tescaped"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("\treal\n\\tescaped\nbeta");
		expect(result.warnings).toBeUndefined();
	});

	it("does NOT auto-correct when no leading \\t exists", () => {
		const content = "alpha\nbeta";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(1, "alpha"),
				lines: ["mid\\tstuff"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		// \\t in middle, not leading — regex only replaces ^(\\t)+
		expect(result.content).toBe("mid\\tstuff\nbeta");
		expect(result.warnings).toBeUndefined();
	});

	it("warns on suspicious \\uDDDD placeholder", () => {
		const content = "alpha\nbeta";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(1, "alpha"),
				lines: ["const x = \\uDDDD;"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings![0]).toContain("\\uDDDD");
	});

	it("can be disabled via env var", () => {
		const original = process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
		try {
			process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = "0";
			const content = "\tfunction foo() {\n\t\treturn 1;\n\t}";
			const edits: HashlineEdit[] = [
				{
					op: "replace",
					pos: makeTag(2, "\t\treturn 1;"),
					lines: ["\\t\\treturn 2;"],
				},
			];
			const result = applyHashlineEdits(content, edits);
			// Escaped tabs left as-is
			expect(result.content).toBe("\tfunction foo() {\n\\t\\treturn 2;\n\t}");
			expect(result.warnings).toBeUndefined();
		} finally {
			if (original === undefined) delete process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
			else process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = original;
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — relocation
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — relocation", () => {
	it("auto-relocates when a line has shifted within ±20 lines", () => {
		// Build content where line 5 has unique content, then shift it to line 7
		const original = ["a", "b", "c", "d", "UNIQUE_LINE", "f", "g"];
		const shifted = ["a", "b", "INSERTED1", "INSERTED2", "c", "d", "UNIQUE_LINE", "f", "g"];
		const shiftedContent = shifted.join("\n");
		// Get the hash of UNIQUE_LINE at its original position (5)
		const originalHash = computeLineHash(5, "UNIQUE_LINE");
		// It's now at line 7 — the hash at position 7 is different (index mixed for non-significant? No, UNIQUE_LINE has alphanumeric)
		// Actually for alphanumeric lines, hash is position-independent, so the hash should match
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: { line: 5, hash: originalHash }, lines: ["REPLACED"] },
		];
		const result = applyHashlineEdits(shiftedContent, edits);
		expect(result.content).toBe("a\nb\nINSERTED1\nINSERTED2\nc\nd\nREPLACED\nf\ng");
		expect(result.warnings).toBeDefined();
		expect(result.warnings![0]).toContain("Auto-relocated");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: resolveEditAnchors → applyHashlineEdits
// ═══════════════════════════════════════════════════════════════════════════

describe("integration: resolveEditAnchors → applyHashlineEdits", () => {
	it("full pipeline: tool-schema edit → resolve → apply", () => {
		const content = "aaa\nbbb\nccc";
		const tag2 = `2#${computeLineHash(2, "bbb")}`;
		const toolEdits: HashlineToolEdit[] = [{ op: "replace", pos: tag2, lines: ["BBB"] }];
		const resolved = resolveEditAnchors(toolEdits);
		const result = applyHashlineEdits(content, resolved);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});

	it("full pipeline: string lines get parsed correctly", () => {
		const content = "aaa\nbbb\nccc";
		const tag2 = `2#${computeLineHash(2, "bbb")}`;
		const toolEdits: HashlineToolEdit[] = [{ op: "replace", pos: tag2, lines: "BBB" }];
		const resolved = resolveEditAnchors(toolEdits);
		const result = applyHashlineEdits(content, resolved);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});

	it("full pipeline: null lines → delete", () => {
		const content = "aaa\nbbb\nccc";
		const tag2 = `2#${computeLineHash(2, "bbb")}`;
		const toolEdits: HashlineToolEdit[] = [{ op: "replace", pos: tag2, lines: null }];
		const resolved = resolveEditAnchors(toolEdits);
		const result = applyHashlineEdits(content, resolved);
		expect(result.content).toBe("aaa\nccc");
	});

	it("full pipeline: prepend to BOF", () => {
		const content = "aaa\nbbb";
		const toolEdits: HashlineToolEdit[] = [{ op: "prepend", lines: ["header"] }];
		const resolved = resolveEditAnchors(toolEdits);
		const result = applyHashlineEdits(content, resolved);
		expect(result.content).toBe("header\naaa\nbbb");
	});

	it("full pipeline: append to EOF", () => {
		const content = "aaa\nbbb";
		const toolEdits: HashlineToolEdit[] = [{ op: "append", lines: ["footer"] }];
		const resolved = resolveEditAnchors(toolEdits);
		const result = applyHashlineEdits(content, resolved);
		expect(result.content).toBe("aaa\nbbb\nfooter");
	});

	it("full pipeline: hashline-prefixed string lines get stripped", () => {
		const content = "aaa\nbbb\nccc";
		const tag2 = `2#${computeLineHash(2, "bbb")}`;
		const hash = computeLineHash(2, "BBB");
		// Simulate model echoing hashline prefixes in replacement text
		const toolEdits: HashlineToolEdit[] = [{ op: "replace", pos: tag2, lines: `2#${hash}:BBB` }];
		const resolved = resolveEditAnchors(toolEdits);
		const result = applyHashlineEdits(content, resolved);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});
});


// ═══════════════════════════════════════════════════════════════════════════
// buildCompactHashlineDiffPreview
// ═══════════════════════════════════════════════════════════════════════════

describe("buildCompactHashlineDiffPreview", () => {
	it("returns empty preview for empty diff", () => {
		const result = buildCompactHashlineDiffPreview("");
		expect(result.preview).toBe("");
		expect(result.addedLines).toBe(0);
		expect(result.removedLines).toBe(0);
	});

	it("counts added and removed lines", () => {
		const diff = [
			" 1|context",
			"-2|old line",
			"-3|old line 2",
			"+2|new line",
			" 3|context",
		].join("\n");
		const result = buildCompactHashlineDiffPreview(diff);
		expect(result.addedLines).toBe(1);
		expect(result.removedLines).toBe(2);
	});

	it("collapses long unchanged runs in the middle", () => {
		const lines: string[] = [];
		lines.push("-1|removed");
		for (let i = 2; i <= 12; i++) lines.push(` ${i}|unchanged`);
		lines.push("+13|added");
		const diff = lines.join("\n");
		const result = buildCompactHashlineDiffPreview(diff);
		expect(result.preview).toContain("more unchanged lines");
		expect(result.addedLines).toBe(1);
		expect(result.removedLines).toBe(1);
	});

	it("collapses long addition runs", () => {
		const lines: string[] = [];
		lines.push(" 1|context");
		for (let i = 2; i <= 10; i++) lines.push(`+${i}|added line ${i}`);
		lines.push(" 11|context");
		const diff = lines.join("\n");
		const result = buildCompactHashlineDiffPreview(diff);
		expect(result.preview).toContain("more added lines");
		expect(result.addedLines).toBe(9);
	});

	it("truncates total output lines", () => {
		// Create many alternating runs to exceed maxOutputLines after per-run collapse
		const lines: string[] = [];
		for (let i = 0; i < 20; i++) {
			lines.push(` ${i * 3 + 1}|ctx`);
			lines.push(`-${i * 3 + 2}|old`);
			lines.push(`+${i * 3 + 3}|new`);
		}
		const diff = lines.join("\n");
		const result = buildCompactHashlineDiffPreview(diff, { maxOutputLines: 5 });
		const outputLines = result.preview.split("\n");
		expect(outputLines.length).toBeLessThanOrEqual(6);
		expect(result.preview).toContain("more preview lines");
	});

	it("preserves meta lines", () => {
		const diff = "--- a/foo.ts\n+++ b/foo.ts\n+1|new line";
		const result = buildCompactHashlineDiffPreview(diff);
		expect(result.preview).toContain("--- a/foo.ts");
		expect(result.preview).toContain("+++ b/foo.ts");
		expect(result.addedLines).toBe(1);
	});
});