import { describe, expect, it } from "vitest";
import { computeChangedLineRange } from "../../src/hashline";

describe("computeChangedLineRange", () => {
	it("returns null when content is unchanged", () => {
		expect(computeChangedLineRange("a\nb\nc", "a\nb\nc")).toBeNull();
	});

	it("tracks a single-line replace", () => {
		const result = computeChangedLineRange("a\nb\nc", "a\nB\nc");
		expect(result).toEqual({ firstChangedLine: 2, lastChangedLine: 2 });
	});

	it("tracks a multi-line replace that expands", () => {
		const result = computeChangedLineRange("a\nb\nc", "a\nB1\nB2\nc");
		expect(result).toEqual({ firstChangedLine: 2, lastChangedLine: 3 });
	});

	it("tracks a multi-line delete in the middle", () => {
		// Deleting "b\nc\n" from "a\nb\nc\nd" should report line 2 as changed
		// (where "d" moves up), not { firstChangedLine: 2, lastChangedLine: 1 }.
		const result = computeChangedLineRange("a\nb\nc\nd", "a\nd");
		expect(result).not.toBeNull();
		expect(result!.firstChangedLine).toBeLessThanOrEqual(result!.lastChangedLine);
		expect(result).toEqual({ firstChangedLine: 2, lastChangedLine: 2 });
	});

	it("tracks deleting head of file", () => {
		const result = computeChangedLineRange("a\nb\nc\nd", "c\nd");
		expect(result!.firstChangedLine).toBeLessThanOrEqual(result!.lastChangedLine);
		expect(result).toEqual({ firstChangedLine: 1, lastChangedLine: 2 });
	});

	it("tracks deleting tail of file clamped to the last surviving line", () => {
		// Lines 3-4 are deleted; the changed position is clamped into the result
		// document, so the last surviving line (2) is reported, never a line
		// number beyond the new EOF.
		const result = computeChangedLineRange("a\nb\nc\nd", "a\nb");
		expect(result).toEqual({ firstChangedLine: 2, lastChangedLine: 2 });
	});

	it("tracks prepending at BOF", () => {
		const result = computeChangedLineRange("a\nb\nc", "X\na\nb\nc");
		expect(result).toEqual({ firstChangedLine: 1, lastChangedLine: 1 });
	});

	it("tracks appending at EOF", () => {
		const result = computeChangedLineRange("a\nb\nc", "a\nb\nc\nX");
		expect(result).toEqual({ firstChangedLine: 4, lastChangedLine: 4 });
	});

	it("tracks deleting all content", () => {
		const result = computeChangedLineRange("a\nb\nc", "");
		expect(result).toEqual({ firstChangedLine: 1, lastChangedLine: 1 });
	});
});
