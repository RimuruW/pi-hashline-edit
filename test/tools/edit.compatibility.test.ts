import { describe, expect, it } from "bun:test";
import {
  applyExactUniqueLegacyReplace,
  extractLegacyTopLevelReplace,
} from "../../src/edit-compat";

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

  it("returns null when edits[] is present", () => {
    expect(
      extractLegacyTopLevelReplace({
        path: "a.ts",
        edits: [],
        oldText: "before",
        newText: "after",
      }),
    ).toBeNull();
  });
});

describe("applyExactUniqueLegacyReplace", () => {
  it("replaces one exact unique occurrence", () => {
    expect(applyExactUniqueLegacyReplace("a\nb\nc", "b", "B")).toEqual({
      content: "a\nB\nc",
      matchCount: 1,
    });
  });

  it("throws when the old text is missing", () => {
    expect(() => applyExactUniqueLegacyReplace("a\nb\nc", "z", "Z")).toThrow(
      /exact match/i,
    );
  });

  it("throws when the old text matches multiple times", () => {
    expect(() =>
      applyExactUniqueLegacyReplace("dup\nmid\ndup", "dup", "X"),
    ).toThrow(/multiple exact matches/i);
  });
});
