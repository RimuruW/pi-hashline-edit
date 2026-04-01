import { describe, expect, it } from "bun:test";
import { readFile } from "fs/promises";
import register from "../../index";
import {
  applyExactUniqueLegacyReplace,
  extractLegacyTopLevelReplace,
} from "../../src/edit-compat";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("extractLegacyTopLevelReplace", () => {
  it("accepts camelCase top-level legacy payload", () => {
    expect(
      extractLegacyTopLevelReplace({
        path: "a.ts",
        oldText: "before",
        newText: "after",
      }),
    ).toEqual({
      oldText: "before",
      newText: "after",
      strategy: "legacy-top-level-replace",
    });
  });

  it("accepts snake_case top-level legacy payload", () => {
    expect(
      extractLegacyTopLevelReplace({
        path: "a.ts",
        old_text: "before",
        new_text: "after",
      }),
    ).toEqual({
      oldText: "before",
      newText: "after",
      strategy: "legacy-top-level-replace",
    });
  });

  it("accepts legacy payload when edits[] is present but empty", () => {
    expect(
      extractLegacyTopLevelReplace({
        path: "a.ts",
        edits: [],
        oldText: "before",
        newText: "after",
      }),
    ).toEqual({
      oldText: "before",
      newText: "after",
      strategy: "legacy-top-level-replace",
    });
  });

  it("returns null when edits[] contains hashline edits", () => {
    expect(
      extractLegacyTopLevelReplace({
        path: "a.ts",
        edits: [{ op: "replace", pos: "1#abc", lines: ["after"] }],
        oldText: "before",
        newText: "after",
      }),
    ).toBeNull();
  });

  it("rejects mixed-case legacy payloads", () => {
    expect(
      extractLegacyTopLevelReplace({
        path: "a.ts",
        oldText: "before",
        new_text: "after",
      }),
    ).toBeNull();
  });
});

describe("applyExactUniqueLegacyReplace", () => {
  it("replaces one exact unique occurrence", () => {
    expect(applyExactUniqueLegacyReplace("a\nb\nc", "b", "B")).toEqual({
      content: "a\nB\nc",
      matchCount: 1,
      usedFuzzyMatch: false,
    });
  });

  it("throws when the old text is missing", () => {
    expect(() => applyExactUniqueLegacyReplace("a\nb\nc", "z", "Z")).toThrow(
      /exact or fuzzy match/i,
    );
  });

  it("throws when the old text matches multiple times", () => {
    expect(() =>
      applyExactUniqueLegacyReplace("dup\nmid\ndup", "dup", "X"),
    ).toThrow(/multiple exact matches/i);
  });

  it("falls back to a unique fuzzy match when exact text differs only by Unicode punctuation or trailing space", () => {
    expect(
      applyExactUniqueLegacyReplace("alpha\nhe said “hi”  \nomega", 'he said "hi"', "HELLO"),
    ).toEqual({
      content: "alpha\nHELLO  \nomega",
      matchCount: 1,
      usedFuzzyMatch: true,
    });
  });

  it("throws when fuzzy matching finds multiple candidates", () => {
    expect(() =>
      applyExactUniqueLegacyReplace(
        "he said “hi”\nhe said “hi”",
        'he said "hi"',
        "HELLO",
      ),
    ).toThrow(/multiple fuzzy matches/i);
  });
});

describe("edit tool compatibility mode", () => {
  it("uses hidden legacy fallback without polluting content text", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          oldText: "bbb",
          newText: "BBB",
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Updated sample.txt");
      expect(getText(result)).toContain("Changes: +1 -1");
      expect(getText(result)).toContain("Diff preview:");
      expect(getText(result)).not.toMatch(/compatibility|fallback/i);
      expect(result.details).toMatchObject({
        compatibility: {
          used: true,
          strategy: "legacy-top-level-replace",
          matchCount: 1,
        },
      });
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("fails when legacy oldText matches multiple exact occurrences", async () => {
    await withTempFile("sample.txt", "dup\nmid\ndup\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.txt",
            oldText: "dup",
            newText: "X",
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        ),
      ).rejects.toThrow(/multiple exact matches|re-read and use hashline/i);
    });
  });

  it("matches multiline legacy oldText after normalizing CRLF and preserves CRLF output", async () => {
    await withTempFile(
      "sample.txt",
      "alpha\r\nbeta\r\ngamma\r\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            oldText: "alpha\r\nbeta",
            newText: "ALPHA\r\nBETA",
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        expect(getText(result)).toContain("Updated sample.txt");
        expect(result.details).toMatchObject({
          compatibility: {
            used: true,
            strategy: "legacy-top-level-replace",
            matchCount: 1,
          },
        });
        expect(await readFile(path, "utf-8")).toBe("ALPHA\r\nBETA\r\ngamma\r\n");
      },
    );
  });

  it("uses fuzzy legacy matching when exact oldText differs only by Unicode punctuation", async () => {
    await withTempFile("sample.txt", "he said “hi”\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          oldText: 'he said "hi"',
          newText: "HELLO",
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Updated sample.txt");
      expect(result.details).toMatchObject({
        compatibility: {
          used: true,
          strategy: "legacy-top-level-replace",
          matchCount: 1,
          fuzzyMatch: true,
        },
      });
      expect(await readFile(path, "utf-8")).toBe("HELLO\n");
    });
  });

  it("falls back to legacy replace when edits is an empty array", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [],
          oldText: "bbb",
          newText: "BBB",
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Updated sample.txt");
      expect(result.details).toMatchObject({
        compatibility: {
          used: true,
          strategy: "legacy-top-level-replace",
          matchCount: 1,
        },
      });
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });

  it("rejects mixed camelCase and snake_case legacy payloads", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      await expect(
        editTool.execute(
          "e1",
          {
            path: "sample.txt",
            oldText: "bbb",
            new_text: "BBB",
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        ),
      ).rejects.toThrow(/cannot mix legacy camelCase and snake_case/i);
    });
  });

  it("prefers strict hashline edits when edits is present", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");
      const betaRef = `2#${computeLineHash(2, "bbb")}`;

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [{ op: "replace", pos: betaRef, lines: ["BBB"] }],
          oldText: "bbb",
          newText: "SHOULD-NOT-APPLY",
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Updated sample.txt");
      expect(getText(result)).toContain("Changes: +1 -1");
      expect(getText(result)).toContain("Diff preview:");
      expect(result.details?.compatibility).toBeUndefined();
      expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
    });
  });
});

describe("execute accepts legacy payloads via hidden compatibility path", () => {
  it("legacy oldText/newText passes through execute()", async () => {
    await withTempFile("sample.txt", "hello world", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      // Public schema now accepts this legacy payload; execute should preserve the same behavior.
      const result = await editTool.execute(
        "e1",
        { path: "sample.txt", oldText: "world", newText: "universe" },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Updated sample.txt");
      expect(await readFile(path, "utf-8")).toBe("hello universe");
    });
  });

  it("legacy old_text/new_text passes through execute()", async () => {
    await withTempFile("sample.txt", "hello world", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        { path: "sample.txt", old_text: "world", new_text: "universe" },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).toContain("Updated sample.txt");
      expect(await readFile(path, "utf-8")).toBe("hello universe");
    });
  });
});
