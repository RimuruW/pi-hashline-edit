import { afterEach, describe, expect, it } from "vitest";
import { generateDiffString } from "../../src/edit-diff";
import { __resetConfigForTests, __setHashLengthForTests } from "../../src/config";

describe("generateDiffString", () => {
	afterEach(() => {
		__resetConfigForTests();
	});

	it("adds hash hints for context and addition lines but not deletions", () => {
		const diff = generateDiffString("alpha\nbeta\ngamma", "alpha\nBETA\ngamma").diff;

		expect(diff).toContain(" 1#");
		expect(diff).toContain(":alpha");
		expect(diff).toContain("+2#");
		expect(diff).toContain(":BETA");
		expect(diff).toContain("-2    beta");
		expect(diff).toContain(" 3#");
		expect(diff).toContain(":gamma");
	});

	// Regression test for #32: deletion lines have no hash, so their padding
	// must match the `#<hash>:` prefix width, which varies with hashLength.
	it.each([2, 3, 4] as const)(
		"aligns deletion line content with hashed lines at hashLength=%i",
		(hashLength) => {
			__setHashLengthForTests(hashLength);
			const diff = generateDiffString("alpha\nbeta\ngamma", "alpha\nBETA\ngamma").diff;
			const lines = diff.split("\n");

			const contentColumn = (line: string, text: string) => line.indexOf(text);
			const contextCol = contentColumn(
				lines.find((l) => l.startsWith(" 1#"))!,
				"alpha",
			);
			const addedCol = contentColumn(lines.find((l) => l.startsWith("+2#"))!, "BETA");
			const removedCol = contentColumn(lines.find((l) => l.startsWith("-2"))!, "beta");

			expect(addedCol).toBe(contextCol);
			expect(removedCol).toBe(contextCol);
		},
	);
});
