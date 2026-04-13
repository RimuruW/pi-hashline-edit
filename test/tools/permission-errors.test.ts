import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync } from "fs";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import register from "../../index";
import { makeFakePiRegistry } from "../support/fixtures";

/**
 * Permission-error tests rely on chmod(0o000) producing EACCES/EPERM.
 * This is POSIX-specific: on Windows chmod is a no-op (or throws ENOTSUP).
 * Skip the entire suite on Windows; root already skips via the existing check.
 */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const isWindows = process.platform === "win32";

describe.skipIf(isRoot || isWindows)("permission errors", () => {
  let tempRoot: string;
  let tempDir: string;

  beforeAll(() => {
    tempRoot = join(process.cwd(), ".tmp");
    mkdirSync(tempRoot, { recursive: true });
    tempDir = mkdtempSync(join(tempRoot, "pi-perm-test-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("read tool EACCES", () => {
    it("throws 'File is not readable' when file has no permissions", async () => {
      const filePath = join(tempDir, "unreadable.txt");
      writeFileSync(filePath, "secret content", "utf-8");
      chmodSync(filePath, 0o000);

      try {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const readTool = getTool("read");

        await expect(
          readTool.execute(
            "r1",
            { path: filePath },
            undefined,
            undefined,
            { cwd: tempDir } as any,
          ),
        ).rejects.toThrow("File is not readable");
      } finally {
        chmodSync(filePath, 0o644);
      }
    });
  });

  describe("edit tool EACCES", () => {
    it("throws 'File is not writable' when file has no permissions", async () => {
      const filePath = join(tempDir, "unwritable.txt");
      writeFileSync(filePath, "original content\n", "utf-8");
      chmodSync(filePath, 0o000);

      try {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        await expect(
          editTool.execute(
            "e1",
            {
              path: filePath,
              edits: [{ op: "replace", pos: "1#abc", lines: ["new content"] }],
            },
            undefined,
            undefined,
            { cwd: tempDir } as any,
          ),
        ).rejects.toThrow("File is not writable");
      } finally {
        chmodSync(filePath, 0o644);
      }
    });
  });
});
