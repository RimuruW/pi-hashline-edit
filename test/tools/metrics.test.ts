import { describe, expect, it } from "vitest";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { getText, makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

describe("details.metrics surface (Phase 2 C — host-only observability)", () => {
	it("read exposes truncation + next_offset metrics, never in text", async () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n");
		await withTempFile("big.txt", `${lines}\n`, async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const readTool = getTool("read");

			const result = await readTool.execute(
				"r1",
				{ path: "big.txt", limit: 50 },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(result.details?.metrics).toEqual({
				truncated: expect.any(Boolean),
				...(result.details?.nextOffset !== undefined
					? { next_offset: result.details.nextOffset }
					: {}),
			});
			expect(getText(result)).not.toContain("metrics");
		});
	});

	it("changed-mode edit reports applied classification + edits_attempted", async () => {
		await withTempFile("a.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{
					path: "a.txt",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(2, "beta")}`,
							lines: ["BETA"],
						},
					],
				},
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(result.details?.metrics).toMatchObject({
				edits_attempted: 1,
				edits_noop: 0,
				warnings: 0,
				classification: "applied",
				changed_lines: { first: 2, last: 2 },
			});
			expect(getText(result)).not.toContain("metrics");
		});
	});

	it("noop edit reports classification noop and edits_noop count", async () => {
		await withTempFile("b.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{
					path: "b.txt",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(2, "beta")}`,
							lines: ["beta"],
						},
					],
				},
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(result.details?.metrics).toMatchObject({
				edits_attempted: 1,
				edits_noop: 1,
				classification: "noop",
			});
			expect(result.details?.metrics?.changed_lines).toBeUndefined();
		});
	});

	it("top-level oldText path normalizes to a single replace_text edit in metrics", async () => {
		await withTempFile("c.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{ path: "c.txt", oldText: "two", newText: "TWO" },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(result.details?.metrics).toMatchObject({
				edits_attempted: 1,
				classification: "applied",
			});
			expect(result.details?.metrics?.legacy_replace).toBeUndefined();
		});
	});

	it("metrics field never appears in user-visible text", async () => {
		await withTempFile("e.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{
					path: "e.txt",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(2, "beta")}`,
							lines: ["beta"],
						},
					],
				},
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).not.toMatch(/metrics|edits_attempted|edits_noop/);
		});
	});

});
