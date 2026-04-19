import { describe, expect, it } from "bun:test";
import { readFile } from "fs/promises";
import register from "../../index";
import { computeEditPreview } from "../../src/edit";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("edit tool replace_text op", () => {
  it("supports first-class replace_text edits", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [{ op: "replace_text", oldText: "bbb", newText: "BBB" }],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Updated sample.txt");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
      expect(result.details?.compatibility).toBeUndefined();
    });
  });

  it("supports mixed replace_text and hashline edits in one request", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");
      const cRef = `3#${computeLineHash(3, "ccc")}`;

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [
            { op: "replace_text", oldText: "bbb", newText: "BBB" },
            { op: "append", pos: cRef, lines: ["ddd"] },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Updated sample.txt");
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\nddd\n");
    });
  });

  it("requires exact unique matching for replace_text", async () => {
    await withTempFile("sample.txt", "he said “hi”\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [{ op: "replace_text", oldText: 'he said "hi"', newText: "HELLO" }],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        ),
      ).rejects.toThrow(/no exact unique match|exact/i);
    });
  });

  it("computes a preview diff for replace_text edits", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const preview = await computeEditPreview(
        {
          path: "sample.txt",
          edits: [{ op: "replace_text", oldText: "bbb", newText: "BBB" }],
        },
        cwd,
      );

      expect("diff" in preview).toBeTrue();
      if (!("diff" in preview)) {
        return;
      }
      expect(preview.diff).toContain(":BBB");
    });
  });
});
