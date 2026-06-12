import { describe, expect, it } from "vitest";
import { generateDiffString } from "../../src/edit-diff";

describe("generateDiffString", () => {
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
});
