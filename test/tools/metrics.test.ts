import { describe, expect, it } from "bun:test";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("details.metrics surface (Phase 2 C — host-only observability)", () => {
  it("read exposes truncation + next_offset metrics, never in text", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n");
    await withTempFile("big.txt", `${lines}\n`, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "big.txt", limit: 50 },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.details?.metrics).toEqual({
        truncated: expect.any(Boolean),
        ...(result.details?.nextOffset !== undefined
          ? { next_offset: result.details.nextOffset }
          : {}),
      });
      expect(getText(result)).not.toContain("metrics");
    });
  });

  it("changed-mode edit reports applied classification + edits_attempted", async () => {
    await withTempFile("a.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "a.txt",
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

      expect(result.details?.metrics).toMatchObject({
        edits_attempted: 1,
        edits_noop: 0,
        warnings: 0,
        return_mode: "changed",
        classification: "applied",
        changed_lines: { first: 2, last: 2 },
      });
      expect(getText(result)).not.toContain("metrics");
    });
  });

  it("noop edit reports classification noop and edits_noop count", async () => {
    await withTempFile("b.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "b.txt",
          edits: [
            {
              op: "replace",
              pos: `2#${computeLineHash(2, "beta")}`,
              lines: ["beta"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(result.details?.metrics).toMatchObject({
        edits_attempted: 1,
        edits_noop: 1,
        return_mode: "changed",
        classification: "noop",
      });
      expect(result.details?.metrics?.changed_lines).toBeUndefined();
    });
  });

  it("legacy top-level oldText path flags legacy_replace=true", async () => {
    await withTempFile("c.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        { path: "c.txt", oldText: "two", newText: "TWO" },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(result.details?.metrics).toMatchObject({
        edits_attempted: 1,
        return_mode: "changed",
        classification: "applied",
        legacy_replace: true,
      });
    });
  });

  it("full-mode edit carries return_mode=full in metrics", async () => {
    await withTempFile("d.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "d.txt",
          returnMode: "full",
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

      expect(result.details?.metrics?.return_mode).toBe("full");
      expect(result.details?.metrics?.classification).toBe("applied");
    });
  });

  it("metrics field never appears in user-visible text for any returnMode", async () => {
    await withTempFile("e.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      for (const returnMode of ["changed", "full", "ranges"] as const) {
        const result = await editTool.execute(
          "e1",
          {
            path: "e.txt",
            returnMode,
            ...(returnMode === "ranges" ? { returnRanges: [{ start: 1, end: 2 }] } : {}),
            edits: [
              {
                op: "replace",
                pos: `2#${computeLineHash(2, "beta")}`,
                lines: ["beta"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        expect(getText(result)).not.toMatch(/metrics|edits_attempted|edits_noop/);
      }
    });
  });
});
