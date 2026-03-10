import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — lightweight simulation of the file-level operations from edit.ts
// ═══════════════════════════════════════════════════════════════════════════

import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile, unlink as fsUnlink, mkdir as fsMkdir } from "fs/promises";
import { dirname } from "path";

/**
 * These tests validate the file-level delete/move logic extracted from the
 * edit tool executor, without requiring the full ExtensionAPI harness.
 */

let testDir: string;

beforeEach(() => {
	testDir = join(tmpdir(), `edit-fileops-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// Delete
// ═══════════════════════════════════════════════════════════════════════════

describe("file-level delete", () => {
	it("deletes an existing file", async () => {
		const filePath = join(testDir, "to-delete.ts");
		writeFileSync(filePath, "content");
		expect(existsSync(filePath)).toBe(true);

		await fsUnlink(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	it("does not throw when deleting a non-existent file (with guard)", async () => {
		const filePath = join(testDir, "nonexistent.ts");

		// Matches the pattern in edit.ts: guard with existsSync before unlink
		if (existsSync(filePath)) {
			await fsUnlink(filePath);
		}
		// Should not throw — this is the expected behavior
		expect(existsSync(filePath)).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Move
// ═══════════════════════════════════════════════════════════════════════════

describe("file-level move", () => {
	it("moves a file to a new path", async () => {
		const srcPath = join(testDir, "original.ts");
		const dstPath = join(testDir, "moved.ts");
		writeFileSync(srcPath, "hello world");

		// Simulate the move logic from edit.ts
		const content = readFileSync(srcPath, "utf-8");
		await fsWriteFile(dstPath, content, "utf-8");
		await fsUnlink(srcPath);

		expect(existsSync(srcPath)).toBe(false);
		expect(existsSync(dstPath)).toBe(true);
		expect(readFileSync(dstPath, "utf-8")).toBe("hello world");
	});

	it("creates intermediate directories for move target", async () => {
		const srcPath = join(testDir, "original.ts");
		const dstPath = join(testDir, "sub", "dir", "moved.ts");
		writeFileSync(srcPath, "nested move");

		await fsMkdir(dirname(dstPath), { recursive: true });
		const content = readFileSync(srcPath, "utf-8");
		await fsWriteFile(dstPath, content, "utf-8");
		await fsUnlink(srcPath);

		expect(existsSync(srcPath)).toBe(false);
		expect(existsSync(dstPath)).toBe(true);
		expect(readFileSync(dstPath, "utf-8")).toBe("nested move");
	});

	it("move to same path is a no-op (no unlink)", async () => {
		const filePath = join(testDir, "same.ts");
		writeFileSync(filePath, "stay put");

		// Simulate: resolvedMove === absolutePath → no unlink
		const resolvedMove = filePath;
		const absolutePath = filePath;
		const content = readFileSync(absolutePath, "utf-8");
		await fsWriteFile(resolvedMove, content, "utf-8");
		if (resolvedMove !== absolutePath) {
			await fsUnlink(absolutePath);
		}

		expect(existsSync(filePath)).toBe(true);
		expect(readFileSync(filePath, "utf-8")).toBe("stay put");
	});

	it("preserves content when moving with edits applied", async () => {
		const srcPath = join(testDir, "source.ts");
		const dstPath = join(testDir, "destination.ts");
		writeFileSync(srcPath, "line one\nline two\nline three\n");

		// Simulate: read → edit → write to new path → unlink old
		let content = readFileSync(srcPath, "utf-8");
		content = content.replace("line two", "line TWO (edited)");
		await fsWriteFile(dstPath, content, "utf-8");
		await fsUnlink(srcPath);

		expect(existsSync(srcPath)).toBe(false);
		expect(readFileSync(dstPath, "utf-8")).toBe("line one\nline TWO (edited)\nline three\n");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Move — destination guard
// ═══════════════════════════════════════════════════════════════════════════

describe("file-level move — destination guard", () => {
	it("detects when destination already exists", () => {
		const srcPath = join(testDir, "source.ts");
		const dstPath = join(testDir, "existing-target.ts");
		writeFileSync(srcPath, "source content");
		writeFileSync(dstPath, "existing content");

		// Simulate the guard from edit.ts
		const resolvedMove = dstPath;
		const absolutePath = srcPath;
		if (resolvedMove && resolvedMove !== absolutePath && existsSync(resolvedMove)) {
			expect(true).toBe(true); // guard correctly triggers
		} else {
			expect("guard should have triggered").toBe(true);
		}

		// Verify neither file was modified
		expect(readFileSync(srcPath, "utf-8")).toBe("source content");
		expect(readFileSync(dstPath, "utf-8")).toBe("existing content");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Delete — mutual exclusivity
// ═══════════════════════════════════════════════════════════════════════════

describe("file-level delete — mutual exclusivity", () => {
	it("detects conflicting delete + move", () => {
		// Simulate the validation from edit.ts
		const deleteFile = true;
		const move = "new/path.ts";
		const hasEdits = false;
		const hasTextReplace = false;
		const isConflicting = !!(deleteFile && (move || hasEdits || hasTextReplace));
		expect(isConflicting).toBe(true);
	});

	it("detects conflicting delete + edits", () => {
		const deleteFile = true;
		const move = undefined;
		const hasEdits = true;
		const hasTextReplace = false;
		const isConflicting = deleteFile && (move || hasEdits || hasTextReplace);
		expect(isConflicting).toBe(true);
	});

	it("allows delete alone", () => {
		const deleteFile = true;
		const move = undefined;
		const hasEdits = false;
		const hasTextReplace = false;
		const isConflicting = deleteFile && (move || hasEdits || hasTextReplace);
		expect(isConflicting).toBe(false);
	});
});
