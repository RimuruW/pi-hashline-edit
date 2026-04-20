import { describe, expect, it } from "bun:test";
import { readFile, symlink, writeFile } from "fs/promises";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("snapshotId protocol", () => {
  it("read returns snapshotId in both text and details", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(getText(result)).toContain("snapshotId:");
      expect(result.details?.snapshotId).toEqual(expect.any(String));
    });
  });

  it("edit accepts a matching snapshotId", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");
      const editTool = getTool("edit");

      const readResult = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );
      const snapshotId = readResult.details?.snapshotId;

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          snapshotId,
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
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Updated sample.txt");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\n");
    });
  });

  it("rejects a stale snapshotId before applying edits and returns refresh anchors", async () => {
    await withTempFile("sample.txt", "one\ntwo\nthree\nfour\nfive\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");
      const editTool = getTool("edit");

      const readResult = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );
      const snapshotId = readResult.details?.snapshotId;

      await writeFile(path, "one\nTWO!\nthree\nfour\nfive\n", "utf-8");

      let errorMessage = "";
      try {
        await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            snapshotId,
            edits: [
              {
                op: "replace",
                pos: `4#${computeLineHash(4, "four")}`,
                lines: ["FOUR"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );
      } catch (error: unknown) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toMatch(/snapshotId|stale/i);
      expect(errorMessage).toContain("Refresh anchors:");
      expect(errorMessage).toContain(`>>> 4#${computeLineHash(4, "four")}:four`);
      expect(errorMessage).toContain(`2#${computeLineHash(2, "TWO!")}:TWO!`);
    });
  });

  it("returns a fresh snapshotId for noop edits even when no snapshotId was provided", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");
      const editTool = getTool("edit");

      const readResult = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );
      const oldSnapshotId = readResult.details?.snapshotId;

      await writeFile(path, "alpha\nBETA\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [
            {
              op: "replace",
              pos: `2#${computeLineHash(2, "BETA")}`,
              lines: ["BETA"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(result.details?.classification).toBe("noop");
      expect(result.details?.snapshotId).toEqual(expect.any(String));
      expect(result.details?.snapshotId).not.toBe(oldSnapshotId);
    });
  });

  it("accepts a snapshotId across symlink aliases to the same file", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      await symlink("sample.txt", `${cwd}/linked-sample.txt`);

      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");
      const editTool = getTool("edit");

      const readResult = await readTool.execute(
        "r1",
        { path: "linked-sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );
      const snapshotId = readResult.details?.snapshotId;

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          snapshotId,
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
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Updated sample.txt");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\n");
    });
  });

  it("clamps refresh anchors toward EOF when the requested line no longer exists", async () => {
    const original = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n") + "\n";
    const shrunk = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n") + "\n";
    await withTempFile("sample.txt", original, async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");
      const editTool = getTool("edit");

      const readResult = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );
      const snapshotId = readResult.details?.snapshotId;

      await writeFile(path, shrunk, "utf-8");

      let errorMessage = "";
      try {
        await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            snapshotId,
            edits: [
              {
                op: "replace",
                pos: `18#${computeLineHash(18, "line-18")}`,
                lines: ["LINE-18"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );
      } catch (error: unknown) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("Refresh anchors:");
      expect(errorMessage).toContain(`>>> 10#${computeLineHash(10, "line-10")}:line-10`);
      expect(errorMessage).not.toContain(`1#${computeLineHash(1, "line-1")}:line-1`);
    });
  });
});
