import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  deleteFileIfExists,
  ensureMoveDestinationAvailable,
  validateFileOperationRequest,
  writeEditResult,
} from "./src/edit-fileops";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `edit-fileops-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("validateFileOperationRequest", () => {
  it("rejects delete combined with move", () => {
    expect(() =>
      validateFileOperationRequest({
        deleteFile: true,
        move: "new/path.ts",
        hasEdits: false,
        hasTextReplace: false,
      }),
    ).toThrow(/Conflicting file-level operations/);
  });

  it("rejects delete combined with edits", () => {
    expect(() =>
      validateFileOperationRequest({
        deleteFile: true,
        move: undefined,
        hasEdits: true,
        hasTextReplace: false,
      }),
    ).toThrow(/Conflicting file-level operations/);
  });

  it("allows delete alone", () => {
    expect(() =>
      validateFileOperationRequest({
        deleteFile: true,
        move: undefined,
        hasEdits: false,
        hasTextReplace: false,
      }),
    ).not.toThrow();
  });
});

describe("ensureMoveDestinationAvailable", () => {
  it("rejects move when destination already exists", () => {
    const srcPath = join(testDir, "source.ts");
    const dstPath = join(testDir, "existing-target.ts");
    writeFileSync(srcPath, "source content");
    writeFileSync(dstPath, "existing content");

    expect(() =>
      ensureMoveDestinationAvailable({
        absolutePath: srcPath,
        resolvedMove: dstPath,
        move: "existing-target.ts",
      }),
    ).toThrow(/Move destination already exists/);
  });

  it("allows move to same path", () => {
    const filePath = join(testDir, "same.ts");
    writeFileSync(filePath, "stay put");

    expect(() =>
      ensureMoveDestinationAvailable({
        absolutePath: filePath,
        resolvedMove: filePath,
        move: "same.ts",
      }),
    ).not.toThrow();
  });
});

describe("deleteFileIfExists", () => {
  it("deletes an existing file", async () => {
    const filePath = join(testDir, "to-delete.ts");
    writeFileSync(filePath, "content");

    await expect(deleteFileIfExists(filePath)).resolves.toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it("does not throw for a missing file", async () => {
    const filePath = join(testDir, "missing.ts");

    await expect(deleteFileIfExists(filePath)).resolves.toBe(false);
    expect(existsSync(filePath)).toBe(false);
  });
});

describe("writeEditResult", () => {
  it("moves a file to a new path and preserves edited content", async () => {
    const srcPath = join(testDir, "source.ts");
    const dstPath = join(testDir, "nested", "destination.ts");
    writeFileSync(srcPath, "line one\nline two\nline three\n");

    await writeEditResult({
      absolutePath: srcPath,
      resolvedMove: dstPath,
      content: "line one\nline TWO (edited)\nline three\n",
      encoding: "utf-8",
    });

    expect(existsSync(srcPath)).toBe(false);
    expect(existsSync(dstPath)).toBe(true);
    expect(readFileSync(dstPath, "utf-8")).toBe(
      "line one\nline TWO (edited)\nline three\n",
    );
  });

  it("writes in place when move target matches source path", async () => {
    const filePath = join(testDir, "same.ts");
    writeFileSync(filePath, "before\n");

    await writeEditResult({
      absolutePath: filePath,
      resolvedMove: filePath,
      content: "after\n",
      encoding: "utf-8",
    });

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("after\n");
  });
});
