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

      expect(getText(result)).toContain("Structure outline:");
      expect(getText(result)).toContain("details.fullContent");
      expect(result.details?.fullContent?.text).toContain(`1#${computeLineHash(1, "aaa")}:aaa`);
      expect(result.details?.fullContent?.text).toContain(`2#${computeLineHash(2, "BBB")}:BBB`);
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

      expect(getText(result)).toContain("Structure outline:");
      expect(getText(result)).toContain("details.fullContent");
      expect(result.details?.fullContent?.text).toContain(`1#${computeLineHash(1, "LINE-1")}:LINE-1`);
      expect(result.details?.fullContent?.nextOffset).toBeGreaterThan(1);
    });
  });

  it("returns only the requested post-edit ranges when returnMode is ranges", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\nddd\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          returnMode: "ranges",
          returnRanges: [
            { start: 1, end: 2 },
            { start: 4 },
          ],
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

      expect(getText(result)).toContain("Structure outline:");
      expect(getText(result)).toContain("details.returnedRanges");
      expect(result.details?.returnedRanges).toHaveLength(2);
      expect(result.details?.returnedRanges?.[0]?.text).toContain(`1#${computeLineHash(1, "aaa")}:aaa`);
      expect(result.details?.returnedRanges?.[0]?.text).toContain(`2#${computeLineHash(2, "BBB")}:BBB`);
      expect(result.details?.returnedRanges?.[1]?.text).toContain(`4#${computeLineHash(4, "ddd")}:ddd`);
      expect(result.details?.returnedRanges?.[0]?.text).not.toContain(`3#${computeLineHash(3, "ccc")}:ccc`);
    });
  });

  it("clamps returnedRanges metadata to the actual last returned line", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          returnMode: "ranges",
          returnRanges: [{ start: 2, end: 5 }],
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

      expect(result.details?.returnedRanges?.[0]?.start).toBe(2);
      expect(result.details?.returnedRanges?.[0]?.end).toBe(3);
    });
  });

  it("marks returnedRanges as empty when the requested start is beyond EOF", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          returnMode: "ranges",
          returnRanges: [{ start: 10, end: 12 }],
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

      expect(result.details?.returnedRanges?.[0]?.start).toBe(10);
      expect(result.details?.returnedRanges?.[0]?.end).toBe(12);
      expect(result.details?.returnedRanges?.[0]?.empty).toBeTrue();
    });
  });
});
