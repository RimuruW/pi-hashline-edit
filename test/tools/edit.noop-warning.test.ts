import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { getText, makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

describe("edit tool noop + warnings", () => {
	it("returns classification noop instead of throwing on identical content", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
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
							pos: `2#${computeLineHash(2, "bbb")}`,
							lines: ["bbb"],
						},
					],
				},
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).toContain("Classification: noop");
			expect(result.details?.classification).toBe("noop");
			expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
		});
	});

	it("keeps validation warnings visible when the edit is a noop", async () => {
		await withTempFile("sample.txt", "he said “hi”\nkeep\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const asciiLine = 'he said "hi"';

			const result = await editTool.execute(
				"e1",
				{
					path: "sample.txt",
					edits: [
						{
							op: "replace",
							pos: `1#${computeLineHash(1, asciiLine)}:${asciiLine}`,
							lines: ["he said “hi”"],
						},
					],
				},
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).toContain("Classification: noop");
			expect(getText(result)).toContain("Warnings:");
			expect(getText(result)).toContain("Accepted fuzzy anchor validation");
			expect(result.details?.metrics?.warnings).toBe(1);
			expect(await readFile(path, "utf-8")).toBe("he said “hi”\nkeep\n");
		});
	});

	it("emits a boundary duplication warning without blocking the edit", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
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
							pos: `2#${computeLineHash(2, "bbb")}`,
							lines: ["BBB", "ccc"],
						},
					],
				},
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).toContain("Warnings:");
			expect(getText(result)).toMatch(/boundary duplication|duplicate/i);
			expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\nccc\n");
		});
	});
});
