import { describe, expect, it } from "bun:test";
import { readFile } from "fs/promises";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("edit tool noop + warnings", () => {
  it("returns classification noop instead of throwing on identical content", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [
            {
              op: "replace",
              pos: `2#${computeLineHash(2, "bbb")}`,
              lines: ["bbb"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Classification: noop");
      expect(result.details?.classification).toBe("noop");
      expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
    });
  });

  it("emits a boundary duplication warning without blocking the edit", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [
            {
              op: "replace",
              pos: `2#${computeLineHash(2, "bbb")}`,
              lines: ["BBB", "ccc"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Warnings:");
      expect(getText(result)).toMatch(/boundary duplication|duplicate/i);
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\nccc\n");
    });
  });
});
