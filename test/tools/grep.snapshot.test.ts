/**
 * Tests for grep → read-snapshot integration (issue-29).
 *
 * AC1: After a grep that emits matches, getReadSnapshot returns the file's
 *      normalized content at the canonical path.
 * AC2: Binary files and files with no valid match lines do not record a snapshot.
 * AC3: Integration loop — grep a file, mutate it on disk, then edit using
 *      grep-time anchors; the multi-version snapshot recovery path engages.
 */

import { writeFile } from "fs/promises";
import { spawnSync } from "child_process";
import { describe, expect, it, beforeEach } from "vitest";
import { registerGrepTool } from "../../src/grep";
import { registerEditTool } from "../../src/edit";
import { normalizeToLF, stripBom } from "../../src/edit-diff";
import { getReadSnapshot, resetReadSnapshot } from "../../src/read-snapshot";
import { resetNoopLoopGuard } from "../../src/noop-loop-guard";
import {
	makeFakePiRegistry,
	makeToolContext,
	getText,
	withTempFile,
	withTempBytes,
} from "../support/fixtures";

const rgAvailable = spawnSync("rg", ["--version"]).status === 0;

beforeEach(() => {
	resetReadSnapshot();
	resetNoopLoopGuard();
});

describe.skipIf(!rgAvailable)("grep snapshot recording", () => {
	// ─── AC1: snapshot recorded for matched file ─────────────────────────────

	it("records normalized content in getReadSnapshot after a grep with matches", async () => {
		const content = "alpha\nbeta\ngamma\n";
		await withTempFile("snap.ts", content, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerGrepTool(pi);
			const tool = getTool("grep");

			await tool.execute(
				"g1",
				{ pattern: "beta", path },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			const snapshot = getReadSnapshot(path);
			expect(snapshot).not.toBeNull();
			// Snapshot must match the same normalization grep uses internally.
			const expected = normalizeToLF(stripBom(content).text);
			expect(snapshot).toBe(expected);
		});
	});

	// ─── AC2a: no-match file does not record a snapshot ──────────────────────

	it("does not record a snapshot when the pattern has no matches", async () => {
		await withTempFile("nosnap.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerGrepTool(pi);
			const tool = getTool("grep");

			await tool.execute(
				"g1",
				{ pattern: "zzznomatch", path },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			// No matches → early return before any file is loaded.
			expect(getReadSnapshot(path)).toBeNull();
		});
	});

	// ─── AC2b: binary file is skipped (no snapshot) ──────────────────────────

	it("does not record a snapshot for a binary file that rg would match", async () => {
		// Write a binary blob that contains the search bytes but is not valid text.
		// rg may or may not match it (binary detection varies), so we just assert
		// that if no text output was emitted for this path, no snapshot was stored.
		// Constructing a binary that rg treats as binary and skips its content:
		// embed a NUL byte so rg's binary detection fires.
		const bytes = new Uint8Array([0x62, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x00, 0x68, 0x69, 0x0a]);
		await withTempBytes("binary.bin", bytes, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerGrepTool(pi);
			const tool = getTool("grep");

			// rg skips binary files by default, so either no matches or a binary notice.
			// Either way, no hashline output is emitted and no snapshot should be stored.
			await tool.execute(
				"g1",
				{ pattern: "binary", path },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			// loadFileKindAndText returns kind "binary" → grep skips it → no snapshot.
			expect(getReadSnapshot(path)).toBeNull();
		});
	});

	// ─── AC3: grep → mutate → edit uses snapshot recovery ────────────────────

	it("edit with grep-time anchors triggers multi-version snapshot recovery after mutation", async () => {
		// 15-line file so external insert shifts line numbers enough to make
		// anchors stale while still allowing a successful 3-way merge.
		const initial = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n") + "\n";

		await withTempFile("grep-recovery.ts", initial, async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerGrepTool(pi);
			registerEditTool(pi);
			const grepTool = getTool("grep");
			const editTool = getTool("edit");
			const ctx = makeToolContext(cwd);

			// Grep seeds the snapshot.
			const grepResult = await grepTool.execute(
				"g1",
				{ pattern: "line8", path },
				undefined,
				undefined,
				ctx,
			);

			const grepText = getText(grepResult);
			const anchorMatch = grepText.match(/(\d+#[A-Z]{2}):line8/);
			expect(anchorMatch).not.toBeNull();
			const line8Anchor = anchorMatch![1]!;

			// External mutation: insert a line near the top, shifting line8 → line9.
			const lines = initial.split("\n");
			lines.splice(1, 0, "external-insert");
			await writeFile(path, lines.join("\n"), "utf-8");

			// Edit using the grep-time anchor — the anchor now points to the wrong
			// line number; the stale-anchor recovery must replay against the snapshot.
			const editResult = await editTool.execute(
				"e1",
				{
					path,
					edits: [{ op: "replace", pos: line8Anchor, lines: ["LINE8-EDITED"] }],
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
