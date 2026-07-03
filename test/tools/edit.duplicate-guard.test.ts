import { describe, expect, it, beforeEach } from "vitest";
import { writeFile } from "fs/promises";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { resetNoopLoopGuard } from "../../src/noop-loop-guard";
import { resetReadSnapshot } from "../../src/read-snapshot";
import { getText, makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

// Initial file: "aaa\nbbb\n"
const FILE_LINES = ["aaa", "bbb"];

describe("edit tool — duplicate-edit guard", () => {
	beforeEach(() => {
		resetNoopLoopGuard();
		resetReadSnapshot();
	});

	// AC1: same append payload sent twice without external modification →
	// first succeeds, second throws E_DUPLICATE_EDIT, file only has one insertion.
	it("throws E_DUPLICATE_EDIT on the second identical append (no external change)", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const ctx = makeToolContext(cwd);

			const appendEdits = [
				{
					op: "append" as const,
					pos: `2#${computeLineHash(FILE_LINES, 1)}`,
					lines: ["inserted"],
				},
			];

			// First call: should succeed and apply the edit
			const firstResult = await editTool.execute(
				"e1",
				{ path: "sample.txt", edits: appendEdits },
				undefined,
				undefined,
				ctx,
			);
			expect(getText(firstResult)).not.toContain("E_DUPLICATE_EDIT");

			// Second call with byte-identical payload, no external change
			await expect(
				editTool.execute("e2", { path: "sample.txt", edits: appendEdits }, undefined, undefined, ctx),
			).rejects.toThrow(/E_DUPLICATE_EDIT/);

			// File must only contain one insertion
			const { readFileSync } = await import("fs");
			const content = readFileSync(path, "utf-8");
			const insertedCount = content.split("inserted").length - 1;
			expect(insertedCount).toBe(1);
		});
	});

	// AC2: first edit applied, then file externally modified, same payload resent →
	// must NOT throw E_DUPLICATE_EDIT.
	it("does not throw E_DUPLICATE_EDIT when the file was externally modified after the edit", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const ctx = makeToolContext(cwd);

			const appendEdits = [
				{
					op: "append" as const,
					pos: `2#${computeLineHash(FILE_LINES, 1)}`,
					lines: ["inserted"],
				},
			];

			// First edit succeeds
			await editTool.execute("e1", { path: "sample.txt", edits: appendEdits }, undefined, undefined, ctx);

			// Externally modify the file — simulate another agent or the user touching it
			await writeFile(path, "aaa\nbbb\nexternally-changed\n", "utf-8");

			// Re-send the same payload — must not throw E_DUPLICATE_EDIT
			// (stale anchor may cause a different error, but not duplicate-edit)
			try {
				await editTool.execute("e2", { path: "sample.txt", edits: appendEdits }, undefined, undefined, ctx);
			} catch (err) {
				expect((err as Error).message).not.toMatch(/E_DUPLICATE_EDIT/);
			}
		});
	});

	// AC3: first edit applied, then model re-reads via read tool, then same payload
	// resent → clearAppliedPayload fires on read, so no E_DUPLICATE_EDIT (edit applies again).
	it("allows the same payload after a re-read (clearAppliedPayload clears the guard)", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const readTool = getTool("read");
			const ctx = makeToolContext(cwd);

			const appendEdits = [
				{
					op: "append" as const,
					pos: `2#${computeLineHash(FILE_LINES, 1)}`,
					lines: ["inserted"],
				},
			];

			// First edit: append "inserted" after line 2
			await editTool.execute("e1", { path: "sample.txt", edits: appendEdits }, undefined, undefined, ctx);

			// Model re-reads the file — this should clear the duplicate guard
			await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);

			// Now the file contains "aaa\nbbb\ninserted\n".
			// Re-sending the same append payload should be allowed through (no E_DUPLICATE_EDIT).
			// The anchor may be stale now, so we just verify no E_DUPLICATE_EDIT is thrown.
			// (The edit itself may fail with a stale-anchor error, which is acceptable.)
			try {
				await editTool.execute("e2", { path: "sample.txt", edits: appendEdits }, undefined, undefined, ctx);
				// If it succeeds, "inserted" appears twice — that's expected (model explicitly re-read)
				const { readFileSync } = await import("fs");
				const content = readFileSync(path, "utf-8");
				expect(content.split("inserted").length - 1).toBe(2);
			} catch (err) {
				// Stale anchor or similar is fine; duplicate-edit must NOT be thrown
				expect((err as Error).message).not.toMatch(/E_DUPLICATE_EDIT/);
			}
		});
	});

	// AC4: different payloads — second payload must not be blocked.
	it("does not throw E_DUPLICATE_EDIT when the payload is different", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const ctx = makeToolContext(cwd);

			const firstEdits = [
				{
					op: "append" as const,
					pos: `2#${computeLineHash(FILE_LINES, 1)}`,
					lines: ["line-one"],
				},
			];

			// After first edit the file is "aaa\nbbb\nline-one\n"
			// The second append targets the new tail line.
			await editTool.execute("e1", { path: "sample.txt", edits: firstEdits }, undefined, undefined, ctx);

			// Re-read to get fresh anchors and clear the guard
			const readTool = getTool("read");
			await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);

			// Compute hash for the new last line
			const newFileLines = ["aaa", "bbb", "line-one"];
			const differentEdits = [
				{
					op: "append" as const,
					pos: `3#${computeLineHash(newFileLines, 2)}`,
					lines: ["line-two"],
				},
			];

			// Different payload — must not throw E_DUPLICATE_EDIT
			const result = await editTool.execute(
				"e2",
				{ path: "sample.txt", edits: differentEdits },
				undefined,
				undefined,
				ctx,
			);
			expect(getText(result)).not.toContain("E_DUPLICATE_EDIT");
		});
	});

	// AC5: replace with same payload twice → second is a noop (content unchanged),
	// so it walks the noop path, not the E_DUPLICATE_EDIT path.
	it("does not throw E_DUPLICATE_EDIT for replace-with-same-content (handled by noop path)", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const ctx = makeToolContext(cwd);

			// First replace: change "aaa" to "AAA" — actually applied
			const changeEdits = [
				{
					op: "replace" as const,
					pos: `1#${computeLineHash(FILE_LINES, 0)}`,
					lines: ["AAA"],
				},
			];
			await editTool.execute("e1", { path: "sample.txt", edits: changeEdits }, undefined, undefined, ctx);

			// Re-read to get fresh anchors for the updated file
			const readTool = getTool("read");
			await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);

			// Build a replace that restores "AAA" → "AAA" (noop after anchors updated)
			const newLines = ["AAA", "bbb"];
			const noopReplaceEdits = [
				{
					op: "replace" as const,
					pos: `1#${computeLineHash(newLines, 0)}`,
					lines: ["AAA"],
				},
			];

			// First noop: soft noop response, no error
			const noop1 = await editTool.execute(
				"e2",
				{ path: "sample.txt", edits: noopReplaceEdits },
				undefined,
				undefined,
				ctx,
			);
			expect(getText(noop1)).toContain("Classification: noop");

			// Second noop: still soft noop (count=2 < NOOP_HARD_LIMIT=3)
			const noop2 = await editTool.execute(
				"e3",
				{ path: "sample.txt", edits: noopReplaceEdits },
				undefined,
				undefined,
				ctx,
			);
			expect(getText(noop2)).toContain("Classification: noop");

			// No E_DUPLICATE_EDIT at any point (noop path is separate)
		});
	});
});
