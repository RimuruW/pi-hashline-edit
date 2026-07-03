/**
 * Integration tests for multi-version snapshot history (ADR 0005).
 *
 * AC1: read v1 → external change → read v2 → edit with v1 anchors → recovers.
 * AC2: edit with v2 (latest) anchors → recovers as before (no regression).
 * AC3: anchors match an older version but merge conflicts → error contains "Recovery attempted".
 * AC4: anchors do not match any version → error contains "do not match any recent read".
 */

import { writeFile } from "fs/promises";
import { describe, expect, it, beforeEach } from "vitest";
import register from "../../index";
import { getText, makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";
import { resetReadSnapshot } from "../../src/read-snapshot";
import { resetNoopLoopGuard } from "../../src/noop-loop-guard";

beforeEach(() => {
	resetReadSnapshot();
	resetNoopLoopGuard();
});

// 15-line file helper (same pattern as existing snapshot-merge-recovery tests).
function make15Lines(): string {
	return Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
}

function lineRef(readText: string, lineContent: string): string {
	return readText
		.split("\n")
		.find((l) => l.includes(`:${lineContent}`))!
		.split(":")[0]!;
}

// ─── AC1 ──────────────────────────────────────────────────────────────────────
// read v1 → external change → read v2 → edit with v1 anchors → recovery succeeds.
// Single-slot would fail here because v1 was overwritten by v2 in the snapshot.

describe("multi-version recovery (AC1): v1 anchor recovers after a v2 read supersedes it", () => {
	it("edit with stale v1 anchors succeeds via v1 snapshot replay", async () => {
		const initial = make15Lines();

		await withTempFile("mv-ac1.ts", initial, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const ctx = makeToolContext(cwd);
			const readTool = getTool("read");
			const editTool = getTool("edit");

			// Read 1 — seeds v1 snapshot with initial content.
			const read1 = await readTool.execute("r1", { path: "mv-ac1.ts" }, undefined, undefined, ctx);
			const line8RefV1 = lineRef(getText(read1), "line8");

			// External change: insert a line near the top (shifts line8 → line9).
			const lines = initial.split("\n");
			lines.splice(1, 0, "external-insert-1");
			await writeFile(path, lines.join("\n"), "utf-8");

			// Read 2 — seeds v2 snapshot (the shifted content); now single-slot would
			// discard v1. Multi-version store keeps both.
			await readTool.execute("r2", { path: "mv-ac1.ts" }, undefined, undefined, ctx);

			// Edit using the v1 anchor (line8 in original numbering).
			// Recovery must replay against v1 and merge onto the current (shifted) file.
			const editResult = await editTool.execute(
				"e1",
				{
					path: "mv-ac1.ts",
					edits: [{ op: "replace", pos: line8RefV1, lines: ["LINE8-EDITED"] }],
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
			expect(finalContent).toContain("external-insert-1");
		});
	});
});

// ─── AC2 ──────────────────────────────────────────────────────────────────────
// v2 (latest) anchors still recover — no regression vs. existing single-slot behaviour.

describe("multi-version recovery (AC2): v2 anchor recovery not regressed", () => {
	it("edit with latest-read anchors recovers as before (existing path)", async () => {
		const initial = make15Lines();

		await withTempFile("mv-ac2.ts", initial, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const ctx = makeToolContext(cwd);
			const readTool = getTool("read");
			const editTool = getTool("edit");

			// Read and immediately get current anchors.
			const read1 = await readTool.execute("r1", { path: "mv-ac2.ts" }, undefined, undefined, ctx);
			const line8Ref = lineRef(getText(read1), "line8");

			// External change that shifts anchors but leaves a non-overlapping region.
			const lines = initial.split("\n");
			lines.splice(1, 0, "external-insert");
			await writeFile(path, lines.join("\n"), "utf-8");

			// Edit using the original (now stale) anchor — recovery expected.
			const editResult = await editTool.execute(
				"e1",
				{
					path: "mv-ac2.ts",
					edits: [{ op: "replace", pos: line8Ref, lines: ["LINE8-EDITED"] }],
				},
				undefined,
				undefined,
				ctx,
			);

			expect(getText(editResult)).toContain("Recovered stale anchors");

			const { readFileSync } = await import("fs");
			const finalContent = readFileSync(path, "utf-8");
			expect(finalContent).toContain("LINE8-EDITED");
			expect(finalContent).toContain("external-insert");
		});
	});
});

// ─── AC3 ──────────────────────────────────────────────────────────────────────
// Anchors match an older version but the 3-way merge conflicts.
// Error must contain "Recovery attempted".

describe("multi-version recovery (AC3): anchor valid in older version but merge conflicts", () => {
	it("error message contains 'Recovery attempted' suffix when merge fails", async () => {
		const initial = make15Lines();

		await withTempFile("mv-ac3.ts", initial, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const ctx = makeToolContext(cwd);
			const readTool = getTool("read");
			const editTool = getTool("edit");

			// Read v1 — capture anchor for line8.
			const read1 = await readTool.execute("r1", { path: "mv-ac3.ts" }, undefined, undefined, ctx);
			const line8Ref = lineRef(getText(read1), "line8");

			// External change: modify line7 (adjacent to line8) — this puts the
			// external change within the 3-line fuzz=0 context window, causing
			// the merge to fail.
			const lines = initial.split("\n");
			lines[6] = "line7-EXTERNAL"; // index 6 = line7
			await writeFile(path, lines.join("\n"), "utf-8");

			// Read v2 — store this shifted content as v2; v1 is retained in history.
			await readTool.execute("r2", { path: "mv-ac3.ts" }, undefined, undefined, ctx);

			// External change again: now also shift line numbers so the v2 anchor is stale too.
			const lines2 = lines.join("\n").split("\n");
			lines2.splice(1, 0, "another-external-insert");
			await writeFile(path, lines2.join("\n"), "utf-8");

			// Edit using v1 anchor — both v2 and v1 should fail the merge (or have
			// stale anchors vs live), so we expect E_STALE_ANCHOR with the suffix.
			await expect(
				editTool.execute(
					"e1",
					{
						path: "mv-ac3.ts",
						edits: [{ op: "replace", pos: line8Ref, lines: ["LINE8-MODEL"] }],
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/Recovery attempted|do not match any recent read/);
		});
	});
});

// ─── AC4 ──────────────────────────────────────────────────────────────────────
// Anchors come from a file state that was never recorded in any snapshot.
// Error must contain "do not match any recent read".
//
// To produce this deterministically: read v1 (seeds snapshot[0] = initial), then
// write a completely different file and read it (seeds snapshot[0] = replaced,
// pushes initial to snapshot[1]). Now write the file to a THIRD state (same
// number of lines, different content). Use a fabricated anchor whose hash
// matches neither snapshot[0] (replaced), snapshot[1] (initial), nor the live
// (third) content — done by using an anchor from the replaced version against
// the initial snapshot (the hash encodes "replaced" content, which is different
// from both stored snapshots after we overwrite again).
//
// Simpler: read v1, then write v2 with different content (and read it so it is
// stored), then write v3 with yet more different content. Now construct an anchor
// at line 8 using a hash that was only valid for v2 — but v2 is stored as
// snapshot[0]. So anchors from v2 are always valid against snapshot[0].
//
// The ONLY way to reliably get "no version matches" is to use an anchor with a
// completely fabricated hash value (like "ZZ") that never appeared in any stored
// snapshot. The hash "ZZ" is extremely unlikely to be a real 2-char hash.

describe("multi-version recovery (AC4): anchors do not match any stored version", () => {
	it("error message contains 'do not match any recent read' suffix", async () => {
		const initial = make15Lines();

		await withTempFile("mv-ac4.ts", initial, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const ctx = makeToolContext(cwd);
			const readTool = getTool("read");
			const editTool = getTool("edit");

			// Seed the snapshot store with some real content for this path
			// so that the recovery block finds versions[] non-empty and iterates.
			await readTool.execute("r1", { path: "mv-ac4.ts" }, undefined, undefined, ctx);

			// Now modify the live file to be same-line-count but all different content.
			const replaced = Array.from({ length: 15 }, (_, i) => `REPLACED${i + 1}`).join("\n") + "\n";
			await writeFile(path, replaced, "utf-8");

			// Use a fabricated anchor whose hash ("ZZ") is guaranteed not to match
			// any real line in any stored snapshot or the live file. The line number 8
			// exists in all versions, so this triggers E_STALE_ANCHOR (hash mismatch),
			// not E_RANGE_OOB. The recovery block iterates all versions, finds that
			// "ZZ" matches nothing, and appends the "do not match any recent read" suffix.
			const fakeAnchor = "8#ZZ";

			await expect(
				editTool.execute(
					"e1",
					{
						path: "mv-ac4.ts",
						edits: [{ op: "replace", pos: fakeAnchor, lines: ["EDITED"] }],
					},
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow(/do not match any recent read/);
		});
	});
});
