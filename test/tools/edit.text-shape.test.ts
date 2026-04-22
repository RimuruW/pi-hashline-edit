import { describe, expect, it } from "bun:test";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("edit tool text shape (token budget)", () => {
  it("changed mode keeps diff in details but not in the LLM-visible text", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
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
        { cwd } as any,
      );

      const text = getText(result);
      expect(text).toContain("Updated sample.ts");
      expect(text).toContain("Changes: +1 -1");
      expect(text).toContain("--- Anchors ");
      expect(text).not.toContain("Diff preview");
      expect(text).not.toContain("Updated anchors");
      expect(result.details?.diff).toContain("+2");
      expect(result.details?.diff).toContain(":BBB");
    });
  });

  it("changed mode uses short anchor header without instructional clause", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
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
        { cwd } as any,
      );

      const text = getText(result);
      expect(text).toMatch(/^--- Anchors \d+-\d+ ---$/m);
      expect(text).not.toMatch(/use these for subsequent edits/);
    });
  });

  it("full mode omits Structure outline when no structural markers are found", async () => {
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
        { cwd } as any,
      );

      const text = getText(result);
      expect(text).not.toContain("Structure outline:");
      expect(text).toContain("details.fullContent");
      expect(result.details?.structureOutline).toEqual([]);
    });
  });

  it("full mode includes Structure outline when structural markers are found", async () => {
    const source = [
      "// header",
      "export function alpha() {",
      "  return 1;",
      "}",
      "export class Beta {}",
      "",
    ].join("\n");
    await withTempFile("sample.ts", source, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          returnMode: "full",
          edits: [
            {
              op: "replace",
              pos: `3#${computeLineHash(3, "  return 1;")}`,
              lines: ["  return 2;"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      const text = getText(result);
      expect(text).toContain("Structure outline:");
      expect(text).toMatch(/function alpha/);
      expect(text).toMatch(/class Beta/);
    });
  });

  it("noop in full mode omits outline when nothing structural shows up", async () => {
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
              lines: ["bbb"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      const text = getText(result);
      expect(text).toContain("Classification: noop");
      expect(text).not.toContain("Structure outline:");
      expect(text).toContain("details.fullContent");
    });
  });
});
