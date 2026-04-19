import { describe, expect, it } from "bun:test";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("edit tool returnMode", () => {
  it("returns the post-edit file content when returnMode is full", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          returnMode: "full",
          edits: [
            {
              op: "replace",
              pos: `2#${computeLineHash(2, "bbb")}`,
              lines: ["BBB"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Full content:");
      expect(getText(result)).toContain(`1#${computeLineHash(1, "aaa")}:aaa`);
      expect(getText(result)).toContain(`2#${computeLineHash(2, "BBB")}:BBB`);
      expect(result.details?.nextOffset).toBeUndefined();
    });
  });

  it("returns nextOffset when full content exceeds the preview budget", async () => {
    const lines = Array.from({ length: 2505 }, (_, index) => `line-${index + 1}`).join("\n") + "\n";
    await withTempFile("big.txt", lines, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "big.txt",
          returnMode: "full",
          edits: [
            {
              op: "replace",
              pos: `1#${computeLineHash(1, "line-1")}`,
              lines: ["LINE-1"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Full content:");
      expect(getText(result)).toContain("Use offset=");
      expect(result.details?.nextOffset).toBeGreaterThan(1);
    });
  });
});
