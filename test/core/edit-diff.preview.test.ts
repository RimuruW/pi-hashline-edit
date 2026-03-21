import { describe, expect, it } from "bun:test";
import { buildCompactHashlineDiffPreview } from "../../src/edit-diff";

describe("buildCompactHashlineDiffPreview", () => {
  it("collapses long unchanged runs and counts add/remove lines", () => {
    const diff = [
      " 1 ctx-a",
      " 2 ctx-b",
      " 3 ctx-c",
      " 4 ctx-d",
      "+5 added",
      "-6 removed",
      " 7 tail-a",
      " 8 tail-b",
      " 9 tail-c",
    ].join("\n");

    const preview = buildCompactHashlineDiffPreview(diff);

    expect(preview.preview).toContain("... 2 more unchanged lines");
    expect(preview.addedLines).toBe(1);
    expect(preview.removedLines).toBe(1);
  });
});
