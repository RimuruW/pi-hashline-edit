import { describe, expect, it } from "vitest";
import register from "../../index";
import { getText, makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

describe("strict hashline tool loop", () => {
	it("supports read -> fresh edit -> stale rejection -> retry with fresh anchor", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const ctx = makeToolContext(cwd);

			const readTool = getTool("read");
			const editTool = getTool("edit");

			const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
			const firstText = getText(firstRead);
			const betaRef = firstText
				.split("\n")
				.find((line: string) => line.includes(":beta"))!
				.split(":")[0]!;

			await editTool.execute(
				"e1",
				{
					path: "sample.ts",
					edits: [{ op: "replace", pos: betaRef, lines: ["BETA"] }],
				},
				undefined,
				undefined,
				ctx,
			);

			await expect(
				editTool.execute(
					"e2",
					{
						path: "sample.ts",
						edits: [{ op: "replace", pos: betaRef, lines: ["BETA-AGAIN"] }],
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/1 stale anchor\./);

			const secondRead = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
			const secondText = getText(secondRead);
			const freshRef = secondText
				.split("\n")
				.find((line: string) => line.includes(":BETA"))!
				.split(":")[0]!;

			await editTool.execute(
				"e3",
				{
					path: "sample.ts",
					edits: [{ op: "replace", pos: freshRef, lines: ["BETA-AGAIN"] }],
				},
				undefined,
				undefined,
				ctx,
			);
		});
	});
});
