import { describe, expect, it, beforeEach } from "vitest";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { resetNoopLoopGuard } from "../../src/noop-loop-guard";
import { getText, makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

describe("edit tool — noop loop guard", () => {
	beforeEach(() => {
		resetNoopLoopGuard();
	});

	it("returns soft noop response on the 1st identical noop", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const edits = [
				{
					op: "replace" as const,
					pos: `1#${computeLineHash(1, "aaa")}`,
					lines: ["aaa"],
				},
			];

			const result = await editTool.execute(
				"e1",
				{ path: "sample.txt", edits },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).toContain("Classification: noop");
		});
	});

	it("returns soft noop response on the 2nd identical noop", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const edits = [
				{
					op: "replace" as const,
					pos: `1#${computeLineHash(1, "aaa")}`,
					lines: ["aaa"],
				},
			];
			const ctx = makeToolContext(cwd);

			await editTool.execute("e1", { path: "sample.txt", edits }, undefined, undefined, ctx);
			const result = await editTool.execute(
				"e2",
				{ path: "sample.txt", edits },
				undefined,
				undefined,
				ctx,
			);

			expect(getText(result)).toContain("Classification: noop");
		});
	});

	it("throws E_NOOP_LOOP on the 3rd consecutive identical noop", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const edits = [
				{
					op: "replace" as const,
					pos: `1#${computeLineHash(1, "aaa")}`,
					lines: ["aaa"],
				},
			];
			const ctx = makeToolContext(cwd);

			await editTool.execute("e1", { path: "sample.txt", edits }, undefined, undefined, ctx);
			await editTool.execute("e2", { path: "sample.txt", edits }, undefined, undefined, ctx);

			await expect(
				editTool.execute("e3", { path: "sample.txt", edits }, undefined, undefined, ctx),
			).rejects.toThrow(/E_NOOP_LOOP/);
		});
	});

	it("resets the counter after a successful applied edit", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const noopEdits = [
				{
					op: "replace" as const,
					pos: `1#${computeLineHash(1, "aaa")}`,
					lines: ["aaa"],
				},
			];
			const realEdit = [
				{
					op: "replace" as const,
					pos: `2#${computeLineHash(2, "bbb")}`,
					lines: ["BBB"],
				},
			];
			const ctx = makeToolContext(cwd);

			// Two noops, then a real edit, then two more noops — counter resets.
			await editTool.execute("e1", { path: "sample.txt", edits: noopEdits }, undefined, undefined, ctx);
			await editTool.execute("e2", { path: "sample.txt", edits: noopEdits }, undefined, undefined, ctx);
			await editTool.execute("e3", { path: "sample.txt", edits: realEdit }, undefined, undefined, ctx);
			await editTool.execute("e4", { path: "sample.txt", edits: noopEdits }, undefined, undefined, ctx);

			// 4th call: counter is back at 2 (noops since last real edit), not 4
			const result = await editTool.execute(
				"e5",
				{ path: "sample.txt", edits: noopEdits },
				undefined,
				undefined,
				ctx,
			);
			expect(getText(result)).toContain("Classification: noop");
		});
	});

	it("resets count to 1 when the payload changes for the same path", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const noopEditsA = [
				{
					op: "replace" as const,
					pos: `1#${computeLineHash(1, "aaa")}`,
					lines: ["aaa"],
				},
			];
			// Different payload — same path, different op target
			const noopEditsB = [
				{
					op: "replace" as const,
					pos: `2#${computeLineHash(2, "bbb")}`,
					lines: ["bbb"],
				},
			];
			const ctx = makeToolContext(cwd);

			// Two noops with payload A
			await editTool.execute("e1", { path: "sample.txt", edits: noopEditsA }, undefined, undefined, ctx);
			await editTool.execute("e2", { path: "sample.txt", edits: noopEditsA }, undefined, undefined, ctx);

			// Switching to payload B resets counter — this is count=1, not 3
			const result = await editTool.execute(
				"e3",
				{ path: "sample.txt", edits: noopEditsB },
				undefined,
				undefined,
				ctx,
			);
			expect(getText(result)).toContain("Classification: noop");
		});
	});
});
