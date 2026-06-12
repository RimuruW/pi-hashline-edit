import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	computeLineHash,
	resolveEditAnchors,
	type Anchor,
	type HashlineEdit,
	type HashlineToolEdit,
} from "../../src/hashline";

function makeTag(lineNum: number, text: string): Anchor {
	return { line: lineNum, hash: computeLineHash(lineNum, text) };
}

describe("applyHashlineEdits — error handling", () => {
	it("throws on hash mismatch", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: { line: 2, hash: "XX" }, lines: ["BBB"] },
		];
		expect(() => applyHashlineEdits(content, edits)).toThrow(
			/1 stale anchor\./,
		);
	});

	it("throws on out-of-range line", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: { line: 99, hash: "ZZ" }, lines: ["x"] },
		];
		expect(() => applyHashlineEdits(content, edits)).toThrow(/does not exist/);
	});

	it("throws on range start > end", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(3, "ccc"),
				end: makeTag(1, "aaa"),
				lines: ["x"],
			},
		];
		expect(() => applyHashlineEdits(content, edits)).toThrow(
			/must be <= end line/,
		);
	});

	it("reports multiple mismatches at once", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: { line: 1, hash: "XX" }, lines: ["A"] },
			{ op: "replace", pos: { line: 3, hash: "YY" }, lines: ["C"] },
		];
		expect(() => applyHashlineEdits(content, edits)).toThrow(
			/2 stale anchors\./,
		);
	});

	it("lists stale anchor strings in mismatch errors", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "replace", pos: { line: 1, hash: "XX" }, lines: ["A"] },
			{ op: "replace", pos: { line: 3, hash: "YY" }, lines: ["C"] },
		];

		expect(() => applyHashlineEdits(content, edits)).toThrow(
			/Stale refs: 1#XX, 3#YY/,
		);
	});

	it("mismatch message exposes retryable >>> LINE#HASH snippets", () => {
		expect(() =>
			applyHashlineEdits("aaa", [
				{
					op: "replace",
					pos: { line: 1, hash: "ZZ" },
					lines: ["bbb"],
				},
			]),
		).toThrow(/>>> 1#[A-Z]{2}:aaa/);
	});

	it("retains still-valid range endpoints in retry snippets", () => {
		const content = "aaa\nbbb\nccc\nddd\neee";
		const validEnd = makeTag(5, "eee");

		try {
			applyHashlineEdits(content, [
				{
					op: "replace",
					pos: { line: 1, hash: "ZZ" },
					end: validEnd,
					lines: ["AAA"],
				},
			]);
			throw new Error(
				"Expected applyHashlineEdits to throw for stale range anchor.",
			);
		} catch (error: unknown) {
			if (!(error instanceof Error)) {
				throw error;
			}
			expect(error.message).toContain(
				`>>> ${validEnd.line}#${validEnd.hash}:eee`,
			);
		}
	});

	it("rejects overlapping replace ranges in one request", () => {
		const content = "aaa\nbbb\nccc\nddd";
		expect(() =>
			applyHashlineEdits(content, [
				{
					op: "replace",
					pos: makeTag(2, "bbb"),
					end: makeTag(3, "ccc"),
					lines: ["X"],
				},
				{
					op: "replace",
					pos: makeTag(3, "ccc"),
					lines: ["Y"],
				},
			]),
		).toThrow(/conflicting edits.*overlap on the same original line range/i);
	});

	it("rejects multiple inserts targeting the same boundary", () => {
		const content = "aaa\nbbb\nccc";
		expect(() =>
			applyHashlineEdits(content, [
				{ op: "append", pos: makeTag(2, "bbb"), lines: ["X"] },
				{ op: "prepend", pos: makeTag(3, "ccc"), lines: ["Y"] },
			]),
		).toThrow(/conflicting edits.*same insertion boundary/i);
	});

	it("rejects inserts inside a replaced range", () => {
		const content = "aaa\nbbb\nccc\nddd";
		expect(() =>
			applyHashlineEdits(content, [
				{
					op: "replace",
					pos: makeTag(2, "bbb"),
					end: makeTag(3, "ccc"),
					lines: ["X"],
				},
				{ op: "append", pos: makeTag(2, "bbb"), lines: ["Y"] },
			]),
		).toThrow(/conflicting edits.*inserts inside a replaced original range/i);
	});

	it("rejects EOF append and append-after-last-line on newline-terminated files", () => {
		const content = "a\nb\n";
		expect(() =>
			applyHashlineEdits(content, [
				{ op: "append", lines: ["X"] },
				{ op: "append", pos: makeTag(2, "b"), lines: ["Y"] },
			]),
		).toThrow(/conflicting edits.*same insertion boundary/i);
	});

	it("rejects EOF append and sentinel-anchored EOF append on newline-terminated files", () => {
		const content = "a\nb\n";
		expect(() =>
			applyHashlineEdits(content, [
				{ op: "append", lines: ["X"] },
				{ op: "append", pos: makeTag(3, ""), lines: ["Y"] },
			]),
		).toThrow(/conflicting edits.*same insertion boundary/i);
	});
});

describe("applyHashlineEdits — heuristics", () => {
	it("preserves trailing boundary-looking lines in replacements", () => {
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
		expect(result.content).toBe("if (ok) {\n  runSafe();\n}\n}\nafter();");
		expect(result.warnings).toBeUndefined();
	});

	it("preserves leading boundary-looking lines in replacements", () => {
		const content = "before();\nif (ok) {\n  run();\n}\nafter();";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(2, "if (ok) {"),
				end: makeTag(3, "  run();"),
				lines: ["before();", "if (ok) {", "  runSafe();"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		// The runtime does not auto-correct the duplicated boundary line; the
		// replacement is applied verbatim. It does surface a non-blocking warning
		// so the model can notice a likely Variant-A boundary duplication.
		expect(result.content).toBe(
			"before();\nbefore();\nif (ok) {\n  runSafe();\n}\nafter();",
		);
		expect(result.warnings).toEqual([
			"Potential boundary duplication before replace 2#YP-3#TP: the replacement starts with a line that matches the preceding surviving line after trim.",
		]);
	});

	it("does not auto-correct escaped tab indentation even when the env flag is set", () => {
		const previous = process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
		process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = "1";

		try {
			const content = "root\n\tchild\n\t\tvalue\nend";
			const edits: HashlineEdit[] = [
				{
					op: "replace",
					pos: makeTag(3, "\t\tvalue"),
					lines: ["\\t\\treplaced"],
				},
			];
			const result = applyHashlineEdits(content, edits);

			expect(result.content).toBe("root\n\tchild\n\\t\\treplaced\nend");
			expect(result.warnings).toBeUndefined();
			expect(edits[0]).toEqual({
				op: "replace",
				pos: makeTag(3, "\t\tvalue"),
				lines: ["\\t\\treplaced"],
			});
		} finally {
			if (previous === undefined) {
				delete process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
			} else {
				process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = previous;
			}
		}
	});

	it("warns on literal \\uDDDD without changing content", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(2, "bbb"),
				lines: ["\\uDDDD"],
			},
		];
		const result = applyHashlineEdits(content, edits);

		expect(result.content).toBe("aaa\n\\uDDDD\nccc");
		expect(result.warnings?.[0]).toContain("Detected literal \\uDDDD");
	});

	it("warns when a single-anchor replace receives multiple lines (likely missing end)", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(2, "bbb"),
				lines: ["x1", "x2", "x3"],
			},
		];
		const result = applyHashlineEdits(content, edits);

		// Only the single line at pos is replaced — no autocorrection.
		expect(result.content).toBe("aaa\nx1\nx2\nx3\nccc\nddd");
		expect(
			result.warnings?.some((w) => w.includes("Single-anchor replace")),
		).toBe(true);
	});

	it("does not warn when a single-anchor replace receives one line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(2, "bbb"),
				lines: ["BBB"],
			},
		];
		const result = applyHashlineEdits(content, edits);

		expect(result.content).toBe("aaa\nBBB\nccc");
		expect(result.warnings).toBeUndefined();
	});

	it("does not warn FM1 when end is supplied for a range replace", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{
				op: "replace",
				pos: makeTag(2, "bbb"),
				end: makeTag(3, "ccc"),
				lines: ["x1", "x2", "x3"],
			},
		];
		const result = applyHashlineEdits(content, edits);

		expect(result.content).toBe("aaa\nx1\nx2\nx3\nddd");
		expect(
			result.warnings?.some((w) => w.includes("Single-anchor replace")) ??
				false,
		).toBe(false);
	});
});

describe("integration: resolveEditAnchors → applyHashlineEdits", () => {
	it("full pipeline: tool-schema edit → resolve → apply", () => {
		const content = "aaa\nbbb\nccc";
		const tag2 = `2#${computeLineHash(2, "bbb")}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag2, lines: ["BBB"] },
		];
		const resolved = resolveEditAnchors(toolEdits);
		const result = applyHashlineEdits(content, resolved);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});

	it("full pipeline: string lines are rejected", () => {
		const tag2 = `2#${computeLineHash(2, "bbb")}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag2, lines: "BBB" } as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(
			/lines" must be a string array/i,
		);
	});

	it("full pipeline: null lines are rejected instead of deleting", () => {
		const tag2 = `2#${computeLineHash(2, "bbb")}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag2, lines: null } as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(
			/lines" must be a string array/i,
		);
	});

	it("full pipeline: prepend to BOF", () => {
		const content = "aaa\nbbb";
		const toolEdits: HashlineToolEdit[] = [
			{ op: "prepend", lines: ["header"] },
		];
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

	it("full pipeline: hashline-prefixed array lines are rejected (no autocorrection)", () => {
		const tag2 = `2#${computeLineHash(2, "bbb")}`;
		const hash = computeLineHash(2, "BBB");
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag2, lines: [`2#${hash}:BBB`] },
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("full pipeline: copied full-line anchor tolerates fuzzy same-line Unicode differences", () => {
		const content = "he said “hi”\nkeep";
		const asciiLine = 'he said "hi"';
		const staleWithHint = `1#${computeLineHash(1, asciiLine)}:${asciiLine}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: staleWithHint, lines: ["HELLO"] },
		];
		const resolved = resolveEditAnchors(toolEdits);
		const result = applyHashlineEdits(content, resolved);
		expect(result.content).toBe("HELLO\nkeep");
		expect(result.warnings?.[0]).toContain("Accepted fuzzy anchor validation");
	});

	it("full pipeline: copied full-line anchor rejects fuzzy textHint when hash is arbitrary", () => {
		const line = 'he said "hi"';
		const content = `${line}\nkeep`;
		const actualHash = computeLineHash(1, line);
		const arbitraryHash = actualHash === "ZZ" ? "PP" : "ZZ";
		const staleWithHint = `1#${arbitraryHash}:${line}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: staleWithHint, lines: ["HELLO"] },
		];
		const resolved = resolveEditAnchors(toolEdits);

		expect(() => applyHashlineEdits(content, resolved)).toThrow(/stale anchor/);
	});

	it("full pipeline: copied diff-preview hunks are rejected (no autocorrection)", () => {
		const start = `1#${computeLineHash(1, "aaa")}`;
		const end = `3#${computeLineHash(3, "ccc")}`;
		const replacement = [
			` 1#${computeLineHash(1, "aaa")}:aaa`,
			"-2    bbb",
			`+2#${computeLineHash(2, "BBB")}:BBB`,
			` 3#${computeLineHash(3, "ccc")}:ccc`,
		];
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: start, end, lines: replacement },
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});
});
