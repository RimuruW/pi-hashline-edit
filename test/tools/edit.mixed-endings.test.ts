import { describe, expect, it } from "vitest";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { getText, makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

describe("edit tool — mixed line-ending warning", () => {
	it("includes a warning when the file has mixed CRLF and LF line endings", async () => {
		// File has CRLF on line 1 and bare LF on line 2 — clearly mixed.
		// After LF normalization the file reads as ["alpha", "beta", "gamma"].
		const mixedContent = "alpha\r\nbeta\ngamma\r\n";
		const normalizedLines = ["alpha", "beta", "gamma"];
		await withTempFile("mixed.txt", mixedContent, async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{
					path: "mixed.txt",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(normalizedLines, 1)}`,
							lines: ["BETA"],
						},
					],
				},
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).toContain("mixed line endings");
			expect(getText(result)).toContain("rewrote it uniformly");
		});
	});

	it("does not include a mixed-endings warning for a pure-CRLF file", async () => {
		const crlfContent = "alpha\r\nbeta\r\ngamma\r\n";
		const normalizedLines = ["alpha", "beta", "gamma"];
		await withTempFile("crlf.txt", crlfContent, async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{
					path: "crlf.txt",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(normalizedLines, 1)}`,
							lines: ["BETA"],
						},
					],
				},
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).not.toContain("mixed line endings");
		});
	});
});
