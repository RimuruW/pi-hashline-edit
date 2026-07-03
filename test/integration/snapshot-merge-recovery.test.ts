import { writeFile } from "fs/promises";
import { describe, expect, it, beforeEach } from "vitest";
import register from "../../index";
import { getText, makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";
import { resetReadSnapshot } from "../../src/read-snapshot";
import { threeWayMerge } from "../../src/merge";

// Reset the snapshot slot between every test so they are independent.
beforeEach(() => {
	resetReadSnapshot();
});

// ─── Unit tests for threeWayMerge ────────────────────────────────────────────

describe("threeWayMerge", () => {
	it("applies clean edit when current has a distant unrelated change", () => {
		// Use a 15-line file. Edit is at line 2. External change at line 12
		// (>3 lines away from the edit, so outside the 3-line patch context).
		const makeLines = (n: number) =>
			Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n") + "\n";

		const base = makeLines(15);
		// Model wants to change line2
		const baseLines = base.split("\n");
		baseLines[1] = "LINE2_CHANGED"; // index 1 = line2
		const baseEdited = baseLines.join("\n");

		// External change at line12 (index 11)
		const currentLines = base.split("\n");
		currentLines[11] = "LINE12_EXTERNAL";
		const current = currentLines.join("\n");

		const result = threeWayMerge(base, baseEdited, current);
		expect(result).not.toBeNull();
		const resultLines = result!.split("\n");
		expect(resultLines[1]).toBe("LINE2_CHANGED");
		expect(resultLines[11]).toBe("LINE12_EXTERNAL");
	});

	it("returns null on conflicting overlap", () => {
		const base = "line1\nline2\nline3\n";
		const baseEdited = "line1\nMODEL_EDIT\nline3\n";
		// external change modifies the same region — fuzzFactor 0 rejects this.
		const current = "line1\nEXTERNAL_EDIT\nline3\n";

		const result = threeWayMerge(base, baseEdited, current);
		expect(result).toBeNull();
	});

	it("short-circuits when base equals current", () => {
		const base = "line1\nline2\nline3\n";
		const baseEdited = "line1\nCHANGED\nline3\n";

		const result = threeWayMerge(base, baseEdited, base);
		expect(result).toBe(baseEdited);
	});

	it("returns null when merge equals current (no-op merge)", () => {
		// base and current already differ by the same change as base→baseEdited.
		const base = "a\nb\nc\n";
		const baseEdited = "a\nB\nc\n";
		// current already has that change
		const current = "a\nB\nc\n";

		const result = threeWayMerge(base, baseEdited, current);
		expect(result).toBeNull();
	});
});

// ─── Integration tests ───────────────────────────────────────────────────────
//
// To trigger [E_STALE_ANCHOR] we need an external change that shifts line
// numbers (insert/delete before the target) so the anchor's embedded line
// number no longer matches its content in the live file. To let the 3-way
// merge succeed, the insertion must be distant enough from the edit target
// that it falls outside the 3-line context window of the hunk.
//
// Pattern: 15-line file, model edits around line 8 (middle), external inserts
// a line near the BEGINNING (lines 1–2 region). This shifts line 8 to line 9,
// making the `8#XX` anchor stale. The structuredPatch context around line 8
// spans lines 5–11; the insertion is at line 1 which is outside that window,
// so applyPatch (fuzzFactor:0) succeeds via position scanning.

function make15Lines(): string {
	return Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
}

describe("snapshot-merge recovery (integration)", () => {
	it("(a) distant external line-insert — edit recovers and contains both changes", async () => {
		const initialContent = make15Lines();

		await withTempFile("recovery-a.ts", initialContent, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const ctx = makeToolContext(cwd);

			const readTool = getTool("read");
			const editTool = getTool("edit");

			// Read to seed the snapshot.
			const firstRead = await readTool.execute("r1", { path: "recovery-a.ts" }, undefined, undefined, ctx);
			// Target: line8
			const line8Ref = getText(firstRead)
				.split("\n")
				.find((l: string) => l.includes(":line8"))!
				.split(":")[0]!;

			// External: insert a line after line1 (shifts line8 → line9, staling the anchor).
			const lines = initialContent.split("\n");
			lines.splice(1, 0, "externally-inserted");
			const newContent = lines.join("\n");
			await writeFile(path, newContent, "utf-8");

			// Edit using now-stale anchor.
			const editResult = await editTool.execute(
				"e1",
				{
					path: "recovery-a.ts",
					edits: [{ op: "replace", pos: line8Ref, lines: ["LINE8-EDITED"] }],
				},
				undefined,
				undefined,
				ctx,
			);

			const text = getText(editResult);
			expect(text).toContain("Recovered stale anchors");
			expect(text).toContain("--- Anchors");

			// The final file contains both the external insertion and the model edit.
			const { readFileSync } = await import("fs");
			const finalContent = readFileSync(path, "utf-8");
			expect(finalContent).toContain("LINE8-EDITED");
			expect(finalContent).toContain("externally-inserted");
		});
	});

	it("(b) conflicting external change — edit fails with [E_STALE_ANCHOR]", async () => {
		const initialContent = make15Lines();

		await withTempFile("recovery-b.ts", initialContent, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const ctx = makeToolContext(cwd);

			const readTool = getTool("read");
			const editTool = getTool("edit");

			const firstRead = await readTool.execute("r1", { path: "recovery-b.ts" }, undefined, undefined, ctx);
			const line8Ref = getText(firstRead)
				.split("\n")
				.find((l: string) => l.includes(":line8"))!
				.split(":")[0]!;

			// External change modifies line7 (one above line8) — this shifts line8's
			// context hash AND is within the 3-line context window of the line8 hunk,
			// so the 3-way merge (fuzzFactor:0) will be rejected.
			const lines = initialContent.split("\n");
			lines[6] = "line7-EXTERNAL"; // index 6 = line7
			await writeFile(path, lines.join("\n"), "utf-8");

			// merge conflict → original error surfaces.
			await expect(
				editTool.execute(
					"e1",
					{
						path: "recovery-b.ts",
						edits: [{ op: "replace", pos: line8Ref, lines: ["LINE8-MODEL"] }],
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/\[E_STALE_ANCHOR\]/);
		});
	});

	it("(c) no snapshot after reset — stale edit fails with [E_STALE_ANCHOR]", async () => {
		const initialContent = make15Lines();

		await withTempFile("recovery-c.ts", initialContent, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const ctx = makeToolContext(cwd);

			const readTool = getTool("read");
			const editTool = getTool("edit");

			// Read to get anchor, then wipe the snapshot to simulate no read having occurred.
			const firstRead = await readTool.execute("r1", { path: "recovery-c.ts" }, undefined, undefined, ctx);
			const line8Ref = getText(firstRead)
				.split("\n")
				.find((l: string) => l.includes(":line8"))!
				.split(":")[0]!;

			// Clear snapshot — simulates the raw-read-only scenario where no snapshot
			// was ever captured (raw reads do not call rememberReadSnapshot).
			resetReadSnapshot();

			// External line insertion shifts anchor.
			const lines = initialContent.split("\n");
			lines.splice(1, 0, "externally-inserted");
			await writeFile(path, lines.join("\n"), "utf-8");

			// No snapshot → recovery unavailable → stale error.
			await expect(
				editTool.execute(
					"e1",
					{
						path: "recovery-c.ts",
						edits: [{ op: "replace", pos: line8Ref, lines: ["LINE8-EDITED"] }],
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/\[E_STALE_ANCHOR\]/);
		});
	});

	it("(c-raw) raw read does not seed snapshot: subsequent stale edit fails", async () => {
		const initialContent = make15Lines();

		await withTempFile("recovery-c-raw.ts", initialContent, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const ctx = makeToolContext(cwd);

			const readTool = getTool("read");
			const editTool = getTool("edit");

			// Raw read — should NOT capture snapshot.
			await readTool.execute("r1", { path: "recovery-c-raw.ts", raw: true }, undefined, undefined, ctx);

			// Do a hashline read to capture an anchor, then clear snapshot so only
			// the raw-read slot survives (i.e. nothing).
			const hashlineRead = await readTool.execute("r2", { path: "recovery-c-raw.ts" }, undefined, undefined, ctx);
			const line8Ref = getText(hashlineRead)
				.split("\n")
				.find((l: string) => l.includes(":line8"))!
				.split(":")[0]!;
			// Reset to simulate that only the raw read happened.
			resetReadSnapshot();

			// External insertion invalidates the anchor.
			const lines = initialContent.split("\n");
			lines.splice(1, 0, "externally-inserted");
			await writeFile(path, lines.join("\n"), "utf-8");

			await expect(
				editTool.execute(
					"e1",
					{
						path: "recovery-c-raw.ts",
						edits: [{ op: "replace", pos: line8Ref, lines: ["LINE8-EDITED"] }],
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/\[E_STALE_ANCHOR\]/);
		});
	});

	it("(d) chained: post-edit snapshot enables recovery on second edit", async () => {
		const initialContent = make15Lines();

		await withTempFile("recovery-d.ts", initialContent, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const ctx = makeToolContext(cwd);

			const readTool = getTool("read");
			const editTool = getTool("edit");

			// Initial read.
			const firstRead = await readTool.execute("r1", { path: "recovery-d.ts" }, undefined, undefined, ctx);
			const line8Ref = getText(firstRead)
				.split("\n")
				.find((l: string) => l.includes(":line8"))!
				.split(":")[0]!;

			// First edit — replaces line2, succeeds. The post-edit snapshot now
			// holds the post-first-edit content.
			await editTool.execute(
				"e1",
				{
					path: "recovery-d.ts",
					edits: [{ op: "replace", pos:
						getText(firstRead)
							.split("\n")
							.find((l: string) => l.includes(":line2"))!
							.split(":")[0]!,
						lines: ["LINE2-FIRST"] }],
				},
				undefined,
				undefined,
				ctx,
			);

			// The first-edit snapshot now holds the file with LINE2-FIRST.
			// External: insert a line near the beginning, shifting line8 anchor stale.
			const { readFileSync } = await import("fs");
			const afterEdit1 = readFileSync(path, "utf-8");
			const lines = afterEdit1.split("\n");
			lines.splice(1, 0, "externally-inserted-after-edit1");
			await writeFile(path, lines.join("\n"), "utf-8");

			// Second edit uses the original line8 anchor (valid against the post-edit1
			// snapshot, stale against the now-shifted live file). Recovery should replay
			// against the post-edit1 snapshot and merge onto the shifted live file.
			const editResult2 = await editTool.execute(
				"e2",
				{
					path: "recovery-d.ts",
					edits: [{ op: "replace", pos: line8Ref, lines: ["LINE8-SECOND"] }],
				},
				undefined,
				undefined,
				ctx,
			);

			const text2 = getText(editResult2);
			expect(text2).toContain("Recovered stale anchors");

			const finalContent = readFileSync(path, "utf-8");
			expect(finalContent).toContain("LINE8-SECOND");
			expect(finalContent).toContain("externally-inserted-after-edit1");
			expect(finalContent).toContain("LINE2-FIRST");
		});
	});

	it("(e) relative-vs-absolute path keying: recovery works when read is relative and edit is absolute", async () => {
		const initialContent = make15Lines();

		await withTempFile("recovery-e.ts", initialContent, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const ctx = makeToolContext(cwd);

			const readTool = getTool("read");
			const editTool = getTool("edit");

			// Read with relative path — snapshot is keyed to canonical path.
			const firstRead = await readTool.execute("r1", { path: "recovery-e.ts" }, undefined, undefined, ctx);
			const line8Ref = getText(firstRead)
				.split("\n")
				.find((l: string) => l.includes(":line8"))!
				.split(":")[0]!;

			// External line insertion shifts anchor.
			const lines = initialContent.split("\n");
			lines.splice(1, 0, "externally-inserted");
			await writeFile(path, lines.join("\n"), "utf-8");

			// Edit with absolute path — recovery must use same canonical key.
			const editResult = await editTool.execute(
				"e1",
				{
					path,  // absolute path
					edits: [{ op: "replace", pos: line8Ref, lines: ["LINE8-EDITED"] }],
				},
				undefined,
				undefined,
				ctx,
			);

			const text = getText(editResult);
			expect(text).toContain("Recovered stale anchors");

			const { readFileSync } = await import("fs");
			const finalContent = readFileSync(path, "utf-8");
			expect(finalContent).toContain("LINE8-EDITED");
			expect(finalContent).toContain("externally-inserted");
		});
	});
});
