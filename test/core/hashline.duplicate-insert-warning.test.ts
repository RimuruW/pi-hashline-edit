import { describe, expect, it } from "vitest";
import { applyHashlineEdits, computeLineHash, type HashlineEdit } from "../../src/hashline";

function makeTag(fileContent: string, lineNum: number) {
	const fileLines = fileContent.split("\n");
	return { line: lineNum, hash: computeLineHash(fileLines, lineNum - 1) };
}

describe("duplicate insert warnings — append", () => {
	it("AC4: append after pos when inserted lines match adjacent existing lines → warns", () => {
		// File: line1, line2, line3, line4
		// Suppose a previous call appended ["line3", "line4"] after line2 and now they are already there.
		// A duplicate append would insert ["line3", "line4"] after line2 again.
		const content = "line1\nline2\nline3\nline4";
		const edits: HashlineEdit[] = [
			{
				op: "append",
				pos: makeTag(content, 2),
				lines: ["line3", "line4"],
			},
		];

		const result = applyHashlineEdits(content, edits);
		// Edit should still apply (non-fatal).
		expect(result.content).toBe("line1\nline2\nline3\nline4\nline3\nline4");
		expect(result.warnings).toBeDefined();
		expect(result.warnings!.some((w) => w.includes("Potential duplicate insert"))).toBe(true);
		expect(result.warnings!.some((w) => w.includes("append after 2#"))).toBe(true);
	});

	it("AC4: append EOF (no pos) when inserted lines match file tail → warns", () => {
		// "footer" is already the last line; a redundant EOF append of ["footer"].
		const content = "line1\nfooter";
		const edits: HashlineEdit[] = [
			{ op: "append", lines: ["footer"] },
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("line1\nfooter\nfooter");
		expect(result.warnings!.some((w) => w.includes("Potential duplicate insert"))).toBe(true);
		expect(result.warnings!.some((w) => w.includes("append at EOF"))).toBe(true);
	});

	it("AC5: prepend before pos when inserted lines match existing lines before pos → warns", () => {
		// "header" is already at line 1; a duplicate prepend before line 2 of ["header"].
		const content = "header\ncontent";
		const edits: HashlineEdit[] = [
			{
				op: "prepend",
				pos: makeTag(content, 2),
				lines: ["header"],
			},
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("header\nheader\ncontent");
		expect(result.warnings!.some((w) => w.includes("Potential duplicate insert"))).toBe(true);
		expect(result.warnings!.some((w) => w.includes("prepend before 2#"))).toBe(true);
	});

	it("AC5: prepend BOF (no pos) when inserted lines match file start → warns", () => {
		const content = "header\nline2";
		const edits: HashlineEdit[] = [
			{ op: "prepend", lines: ["header"] },
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("header\nheader\nline2");
		expect(result.warnings!.some((w) => w.includes("Potential duplicate insert"))).toBe(true);
		expect(result.warnings!.some((w) => w.includes("prepend at BOF"))).toBe(true);
	});

	it("AC5: content differs from adjacent lines → no duplicate insert warning", () => {
		const content = "line1\nline2\nline3";
		const edits: HashlineEdit[] = [
			{
				op: "append",
				pos: makeTag(content, 2),
				lines: ["NEW_LINE"],
			},
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("line1\nline2\nNEW_LINE\nline3");
		expect(
			result.warnings?.some((w) => w.includes("Potential duplicate insert")) ?? false,
		).toBe(false);
	});

	it("AC5: insert is purely empty lines → no duplicate insert warning", () => {
		const content = "\nline1\n";
		const edits: HashlineEdit[] = [
			{ op: "append", lines: [""] },
		];

		const result = applyHashlineEdits(content, edits);
		// No significant content → no warning.
		expect(
			result.warnings?.some((w) => w.includes("Potential duplicate insert")) ?? false,
		).toBe(false);
	});

	it("AC5: insert is only closing brace (non-significant) → no warning", () => {
		// RE_SIGNIFICANT matches alphanumeric only; "}" is not significant.
		const content = "fn() {\n}\n}\nend";
		const edits: HashlineEdit[] = [
			{
				op: "append",
				pos: makeTag(content, 1),
				lines: ["}"],
			},
		];

		const result = applyHashlineEdits(content, edits);
		expect(
			result.warnings?.some((w) => w.includes("Potential duplicate insert")) ?? false,
		).toBe(false);
	});

	it("AC5: EOF append without terminal newline — compare against last real line", () => {
		// File without terminal newline; redundant EOF append of ["last"].
		// "first\nlast" → fileLines = ["first", "last"]; EOF compare: fileLines[1] = "last".
		const content = "first\nlast";
		const edits: HashlineEdit[] = [
			{ op: "append", lines: ["last"] },
		];

		const result = applyHashlineEdits(content, edits);
		// Warn because "last" already appears as the last line.
		expect(result.warnings).toBeDefined();
		expect(result.warnings!.some((w) => w.includes("Potential duplicate insert"))).toBe(true);
	});

	it("AC5: append does not warn when comparison range exceeds file length (OOB guard)", () => {
		// Appending 5 lines but file has only 2 lines after pos → range OOB → no warning.
		const content = "line1\nline2";
		const edits: HashlineEdit[] = [
			{
				op: "append",
				pos: makeTag(content, 2),
				lines: ["a", "b", "c", "d", "e"],
			},
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("line1\nline2\na\nb\nc\nd\ne");
		expect(
			result.warnings?.some((w) => w.includes("Potential duplicate insert")) ?? false,
		).toBe(false);
	});

	it("AC5: prepend does not warn when comparison range before pos is OOB", () => {
		// Prepending 3 lines before line 1 (BOF-equivalent with pos) → range would be negative → no warning.
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{
				op: "prepend",
				pos: makeTag(content, 1),
				lines: ["x", "y", "z"],
			},
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("x\ny\nz\naaa\nbbb\nccc");
		expect(
			result.warnings?.some((w) => w.includes("Potential duplicate insert")) ?? false,
		).toBe(false);
	});

	it("sentinel-fix: EOF append with terminal newline warns when last visible line matches", () => {
		// "line1\nfooter\n" → fileLines = ["line1","footer",""] (sentinel at index 2).
		// A duplicate EOF append of ["footer"] must compare against "footer" (index 1),
		// not the sentinel "". Bug: before fix compareStart = 3 - 1 = 2 → compares [""].
		const content = "line1\nfooter\n";
		const edits: HashlineEdit[] = [
			{ op: "append", lines: ["footer"] },
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.warnings).toBeDefined();
		expect(result.warnings!.some((w) => w.includes("Potential duplicate insert"))).toBe(true);
	});

	it("sentinel-fix: pos append with terminal newline warns when window touches visible tail", () => {
		// "aaa\nbbb\nccc\n" — fileLines = ["aaa","bbb","ccc",""].
		// append after line 2 (bbb) of ["ccc"]: the next visible line is "ccc" (index 2).
		// Must not compare against sentinel (index 3); visibleLineCount ceiling keeps window within ["ccc"].
		const content = "aaa\nbbb\nccc\n";
		const edits: HashlineEdit[] = [
			{
				op: "append",
				pos: makeTag(content, 2),
				lines: ["ccc"],
			},
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.warnings).toBeDefined();
		expect(result.warnings!.some((w) => w.includes("Potential duplicate insert"))).toBe(true);
	});
});
