import { describe, expect, it } from "bun:test";
import register from "../../index";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("chained edit anchors", () => {
  it("returns updated anchors in edit result for a single-line replace", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const betaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes(":beta"))!
        .split(":")[0]!;

      const editResult = await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [{ op: "replace", pos: betaRef, lines: ["BETA"] }] },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("--- Anchors");
      expect(editResult.content[0].text).toContain(":BETA");

      // Extract an anchor from the returned block and use it for a second edit.
      const freshRef = editResult.content[0].text
        .split("\n")
        .find((line: string) => line.includes(":BETA"))!
        .split(":")[0]!;

      // Second edit using the returned anchor (no intermediate read).
      const editResult2 = await editTool.execute(
        "e2",
        { path: "sample.ts", edits: [{ op: "replace", pos: freshRef, lines: ["BETA-CHAINED"] }] },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult2.content[0].text).toContain("--- Anchors");
      expect(editResult2.content[0].text).toContain(":BETA-CHAINED");
    });
  });

  it("omits anchors when post-edit affected span is too large", async () => {
    // Replace 15 lines with 15 new lines: span=15, +4 context = 19 > 12 budget.
    const fifteenLines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
    await withTempFile("big.ts", fifteenLines, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute("r1", { path: "big.ts" }, undefined, undefined, ctx);
      const line1Ref = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes(":line 1"))!
        .split(":")[0]!;
      const line15Ref = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes(":line 15"))!
        .split(":")[0]!;

      // Replace lines 1-15 with 15 new lines.
      const newLines = Array.from({ length: 15 }, (_, i) => `NEW ${i + 1}`);
      const editResult = await editTool.execute(
        "e1",
        {
          path: "big.ts",
          edits: [{ op: "replace", pos: line1Ref, end: line15Ref, lines: newLines }],
        },
        undefined,
        undefined,
        ctx,
      );

      // Post-edit: 15 new lines + context > 12 budget → no anchors.
      expect(editResult.content[0].text).not.toContain("--- Anchors");
      expect(editResult.content[0].text).toContain("Anchors omitted; use read");
    });
  });

  it("returns anchors for append operation", async () => {
    await withTempFile("app.ts", "existing\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute("r1", { path: "app.ts" }, undefined, undefined, ctx);
      const existingRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes(":existing"))!
        .split(":")[0]!;

      const editResult = await editTool.execute(
        "e1",
        { path: "app.ts", edits: [{ op: "append", pos: existingRef, lines: ["appended"] }] },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("--- Anchors");
      expect(editResult.content[0].text).toContain(":appended");
    });
  });

  it("returns anchors for prepend at BOF", async () => {
    await withTempFile("pre.ts", "existing\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const editTool = getTool("edit");

      const editResult = await editTool.execute(
        "e1",
        { path: "pre.ts", edits: [{ op: "prepend", lines: ["prepended"] }] },
        undefined,
        undefined,
        ctx,
      );

      expect(editResult.content[0].text).toContain("--- Anchors");
      expect(editResult.content[0].text).toContain(":prepended");
    });
  });

  it("does not leak terminal-newline sentinel in anchors for append on newline-terminated file", async () => {
    await withTempFile("sentinel.ts", "existing\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute("r1", { path: "sentinel.ts" }, undefined, undefined, ctx);
      const existingRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes(":existing"))!
        .split(":")[0]!;

      const editResult = await editTool.execute(
        "e1",
        { path: "sentinel.ts", edits: [{ op: "append", pos: existingRef, lines: ["appended"] }] },
        undefined,
        undefined,
        ctx,
      );

      // Should have anchors, but none should be an empty sentinel like "3#XX:"
      expect(editResult.content[0].text).toContain("--- Anchors");
      const anchorLines = editResult.content[0].text
        .split("\n")
        .filter((line: string) => line.match(/^\d+#\w{2}:.*/));
      for (const line of anchorLines) {
        expect(line).not.toMatch(/^\d+#\w{2}:$/);
      }
    });
  });

  it("omits anchors when single-line replace expands beyond budget", async () => {
    // Replace 1 line with 11 new lines: span=11, +4 context = 15 > 12 budget.
    await withTempFile("expand.ts", "before\ntarget\nafter\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute("r1", { path: "expand.ts" }, undefined, undefined, ctx);
      const targetRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes(":target"))!
        .split(":")[0]!;

      const newLines = Array.from({ length: 11 }, (_, i) => `EXPANDED ${i + 1}`);
      const editResult = await editTool.execute(
        "e1",
        { path: "expand.ts", edits: [{ op: "replace", pos: targetRef, lines: newLines }] },
        undefined,
        undefined,
        ctx,
      );

      // 11 new lines span 2-12, +4 context = 15 > 12 → no anchors block.
      expect(editResult.content[0].text).not.toContain("--- Anchors");
      expect(editResult.content[0].text).toContain("Anchors omitted; use read");
    });
  });

  it("unchanged line anchors from original read remain valid after chained edits", async () => {
    await withTempFile("stale.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const ctx = { cwd, ui: { notify() {} } } as any;

      const readTool = getTool("read");
      const editTool = getTool("edit");

      const firstRead = await readTool.execute("r1", { path: "stale.ts" }, undefined, undefined, ctx);
      const betaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes(":beta"))!
        .split(":")[0]!;
      const alphaRef = firstRead.content[0].text
        .split("\n")
        .find((line: string) => line.includes(":alpha"))!
        .split(":")[0]!;

      // First edit changes beta.
      await editTool.execute(
        "e1",
        { path: "stale.ts", edits: [{ op: "replace", pos: betaRef, lines: ["BETA"] }] },
        undefined,
        undefined,
        ctx,
      );

      // The stale betaRef should now fail (line 2 hash changed).
      await expect(
        editTool.execute(
          "e2-stale",
          { path: "stale.ts", edits: [{ op: "replace", pos: betaRef, lines: ["BETA-AGAIN"] }] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/stale anchor/);

      // But alphaRef (unchanged line) should still work.
      const alphaEdit = await editTool.execute(
        "e3",
        { path: "stale.ts", edits: [{ op: "replace", pos: alphaRef, lines: ["ALPHA"] }] },
        undefined,
        undefined,
        ctx,
      );
      expect(alphaEdit.content[0].text).toContain("--- Anchors");
      expect(alphaEdit.content[0].text).toContain(":ALPHA");
    });
  });
});
