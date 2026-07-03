import { describe, expect, it } from "vitest";
import { detectLineEnding, hasMixedLineEndings, normalizeToLF, stripBom } from "../../src/edit-diff";

// ─── hasMixedLineEndings ────────────────────────────────────────────────

describe("hasMixedLineEndings", () => {
	it("returns false for pure LF content", () => {
		expect(hasMixedLineEndings("alpha\nbeta\ngamma\n")).toBe(false);
	});

	it("returns false for pure CRLF content", () => {
		expect(hasMixedLineEndings("alpha\r\nbeta\r\ngamma\r\n")).toBe(false);
	});

	it("returns true for CRLF + bare LF mix", () => {
		expect(hasMixedLineEndings("alpha\r\nbeta\ngamma\r\n")).toBe(true);
	});

	it("does not double-count the \\n inside \\r\\n as a bare LF", () => {
		// A file with only CRLF endings has no bare LF — the \n after \r is not bare.
		expect(hasMixedLineEndings("a\r\nb\r\nc\r\n")).toBe(false);
	});

	it("returns true for lone \\r combined with LF", () => {
		// Old Mac \r + bare LF = mixed
		expect(hasMixedLineEndings("alpha\rbeta\ngamma")).toBe(true);
	});

	it("returns true for lone \\r combined with CRLF", () => {
		expect(hasMixedLineEndings("alpha\r\nbeta\rgamma")).toBe(true);
	});

	it("returns false for content without any line endings", () => {
		expect(hasMixedLineEndings("no line endings here")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasMixedLineEndings("")).toBe(false);
	});
});

// ─── detectLineEnding ───────────────────────────────────────────────────

describe("detectLineEnding", () => {
	it("detects CRLF when \\r\\n appears first", () => {
		expect(detectLineEnding("hello\r\nworld")).toBe("\r\n");
	});

	it("defaults to LF when only \\n is present", () => {
		expect(detectLineEnding("hello\nworld")).toBe("\n");
	});

	it("detects CRLF when both exist but CRLF comes first", () => {
		expect(detectLineEnding("line1\r\nline2\nline3")).toBe("\r\n");
	});

	it("defaults to LF when no line endings exist", () => {
		expect(detectLineEnding("hello world")).toBe("\n");
	});

	it("defaults to LF for empty string", () => {
		expect(detectLineEnding("")).toBe("\n");
	});
});

// ─── normalizeToLF ──────────────────────────────────────────────────────

describe("normalizeToLF", () => {
	it("converts \\r\\n to \\n", () => {
		expect(normalizeToLF("hello\r\nworld")).toBe("hello\nworld");
	});

	it("converts bare \\r to \\n", () => {
		expect(normalizeToLF("hello\rworld")).toBe("hello\nworld");
	});

	it("leaves already-LF text unchanged", () => {
		expect(normalizeToLF("hello\nworld")).toBe("hello\nworld");
	});

	it("handles mixed line endings", () => {
		expect(normalizeToLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
	});

	it("returns empty string for empty input", () => {
		expect(normalizeToLF("")).toBe("");
	});
});

// ─── stripBom ───────────────────────────────────────────────────────────

describe("stripBom", () => {
	it("strips \\uFEFF prefix", () => {
		const result = stripBom("\uFEFFhello");
		expect(result).toEqual({ bom: "\uFEFF", text: "hello" });
	});

	it("returns empty bom when no BOM present", () => {
		const result = stripBom("hello");
		expect(result).toEqual({ bom: "", text: "hello" });
	});

	it("handles empty string with BOM only", () => {
		const result = stripBom("\uFEFF");
		expect(result).toEqual({ bom: "\uFEFF", text: "" });
	});

	it("handles plain empty string", () => {
		const result = stripBom("");
		expect(result).toEqual({ bom: "", text: "" });
	});
});
