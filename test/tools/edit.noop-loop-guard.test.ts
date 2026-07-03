import { describe, expect, it, beforeEach } from "vitest";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { resetNoopLoopGuard } from "../../src/noop-loop-guard";
import { getText, makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

// File content used by all tests below: "aaa\nbbb\n" → lines ["aaa", "bbb"]
const FILE_LINES = ["aaa", "bbb"];

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
					pos: `1#${computeLineHash(FILE_LINES, 0)}`,
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
					pos: `1#${computeLineHash(FILE_LINES, 0)}`,
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
					pos: `1#${computeLineHash(FILE_LINES, 0)}`,
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
		// Use replace_text for the real edit so no anchor recomputation is needed
		// after the edit. The noop uses a replace_text that replaces identical content.
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			// Noop: replace_text "bbb" with "bbb" (identical, always noop regardless of line context)
			const noopEdits = [{ op: "replace_text" as const, oldText: "bbb", newText: "bbb" }];
			// Real edit: replace_text that changes content
			const realEdit = [{ op: "replace_text" as const, oldText: "bbb", newText: "BBB" }];
			// After realEdit the file is "aaa\nBBB\n", so subsequent noops must match:
			const noopEditsAfterReal = [{ op: "replace_text" as const, oldText: "BBB", newText: "BBB" }];
			const ctx = makeToolContext(cwd);

			// Two noops, then a real edit, then two more noops — counter resets after real edit.
			await editTool.execute("e1", { path: "sample.txt", edits: noopEdits }, undefined, undefined, ctx);
			await editTool.execute("e2", { path: "sample.txt", edits: noopEdits }, undefined, undefined, ctx);
			await editTool.execute("e3", { path: "sample.txt", edits: realEdit }, undefined, undefined, ctx);
			await editTool.execute("e4", { path: "sample.txt", edits: noopEditsAfterReal }, undefined, undefined, ctx);

			// 4th call: counter is back at 2 (noops since last real edit), not 4
			const result = await editTool.execute(
				"e5",
				{ path: "sample.txt", edits: noopEditsAfterReal },
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
					pos: `1#${computeLineHash(FILE_LINES, 0)}`,
					lines: ["aaa"],
				},
			];
			// Different payload — same path, different op target
			const noopEditsB = [
				{
					op: "replace" as const,
					pos: `2#${computeLineHash(FILE_LINES, 1)}`,
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
