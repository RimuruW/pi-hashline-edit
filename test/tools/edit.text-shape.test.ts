import { describe, expect, it } from "vitest";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { getText, makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

describe("edit tool text shape (token budget)", () => {
	it("changed mode keeps only anchors in LLM-visible text and line counts in details", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{
					path: "sample.ts",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(2, "bbb")}`,
							lines: ["BBB"],
						},
					],
				},
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			const text = getText(result);
			expect(text).toContain("--- Anchors ");
			expect(text).not.toContain("Updated sample.ts");
			expect(text).not.toContain("Changes: +1 -1");
			expect(text).not.toContain("Diff preview");
			expect(text).not.toContain("Updated anchors");
			expect(result.details?.diff).toContain("+2");
			expect(result.details?.diff).toContain(":BBB");
			expect(result.details?.metrics).toMatchObject({
				added_lines: 1,
				removed_lines: 1,
			});
		});
	});

	it("changed mode uses short anchor header without instructional clause", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{
					path: "sample.ts",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(2, "bbb")}`,
							lines: ["BBB"],
						},
					],
				},
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			const text = getText(result);
			expect(text).toMatch(/^--- Anchors \d+-\d+ ---$/m);
			expect(text).not.toMatch(/use these for subsequent edits/);
		});
	});


	it("changed mode rejects deleting all content from a non-empty file", async () => {
		await withTempFile("sample.txt", "only\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						edits: [
							{
								op: "replace",
								pos: `1#${computeLineHash(1, "only")}`,
								lines: [],
							},
						],
					},
					undefined,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(/^\[E_WOULD_EMPTY\]/);
		});
	});
	it("changed mode omits oversized anchor payloads even when the changed span fits by line count", async () => {
		const longLine = "a".repeat(60_000);
		await withTempFile("sample.txt", `before\n${longLine}\nafter\n`, async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{
					path: "sample.txt",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(2, longLine)}`,
							lines: [`b${longLine.slice(1)}`],
						},
					],
				},
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			const text = getText(result);
			expect(text).toContain("Anchors omitted; use read");
			expect(text).not.toContain("--- Anchors");
		});
	});
});
