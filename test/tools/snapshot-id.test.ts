import { describe, expect, it } from "bun:test";
import { readFile, writeFile } from "fs/promises";
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

  it("rejects a stale snapshotId before applying edits", async () => {
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

      await writeFile(path, "alpha\nBETA\n", "utf-8");

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.txt",
            snapshotId,
            edits: [
              {
                op: "replace",
                pos: `2#${computeLineHash(2, "beta")}`,
                lines: ["BETA2"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        ),
      ).rejects.toThrow(/snapshotId|stale/i);
    });
  });
});
