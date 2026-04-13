import { describe, expect, it } from "bun:test";
import {
  applyHashlineEdits,
  computeAffectedLineRange,
  computeLineHash,
  formatHashlineRegion,
  resolveEditAnchors,
  type HashlineToolEdit,
  type HashlineEdit,
} from "../../src/hashline";

function makeTag(line: number, text: string) {
  return { line, hash: computeLineHash(line, text) };
}

describe("stale-position compound edits", () => {
  it("tracks correct final coordinates for prepend + replace applied bottom-up", () => {
    // 10-line file
    const originalLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const content = originalLines.join("\n");

    // Two edits provided in bottom-up order (as the model would send them):
    // 1. Replace line 5 ("line5") with new content
    // 2. Prepend 3 lines at BOF
    const toolEdits: HashlineToolEdit[] = [
      {
        op: "replace",
        pos: "5#JR", // hash computed below
        lines: ["NEW_LINE_5"],
      },
      {
        op: "prepend",
        lines: ["header-1", "header-2", "header-3"],
      },
    ];

    // Fix up the hash using the real computeLineHash function
    const line5Hash = computeLineHash(5, "line5");
    toolEdits[0].pos = `5#${line5Hash}`;

    // Resolve through the tool-schema → HashlineEdit pipeline
    const resolved: HashlineEdit[] = resolveEditAnchors(toolEdits);

    // Apply all edits at once
    const result = applyHashlineEdits(content, resolved);

    // ── Verify final content ──
    const expectedLines = [
      "header-1",
      "header-2",
      "header-3",
      "line1",
      "line2",
      "line3",
      "line4",
      "NEW_LINE_5",
      "line6",
      "line7",
      "line8",
      "line9",
      "line10",
    ];
    expect(result.content).toBe(expectedLines.join("\n"));

    // ── Verify firstChangedLine and lastChangedLine in final-document coordinates ──
    // Prepend inserted at lines 1-3, replace shifted by +3 → NEW_LINE_5 at line 8.
    expect(result.firstChangedLine).toBe(1);
    expect(result.lastChangedLine).toBe(8);

    // ── Verify line count ──
    expect(result.content.split("\n").length).toBe(13);

    // ── Verify computeAffectedLineRange works with the tracked bounds ──
    const anchorRange = computeAffectedLineRange({
      firstChangedLine: result.firstChangedLine,
      lastChangedLine: result.lastChangedLine,
      resultLineCount: expectedLines.length,
    });
    expect(anchorRange).not.toBeNull();
    // changed span 1-8 + 2 context each side = min(13, 8+2) = 10, fits 12-line budget
    expect(anchorRange!.start).toBe(1);
    expect(anchorRange!.end).toBe(10); // min(13, 8 + 2)

    // ── Verify formatHashlineRegion produces valid anchors ──
    const regionLines = expectedLines.slice(anchorRange!.start - 1, anchorRange!.end);
    const region = formatHashlineRegion(regionLines, anchorRange!.start);
    expect(region).toContain("header-1");
    expect(region).toContain("NEW_LINE_5");
    // Range ends at line 10 of final doc (8 + 2 context), which is "line7"
    // (original line10 shifted to line 13, beyond the 12-line budget)
    expect(region).toContain("line7");
  });

  it("tracks correct coordinates when replace shrinks and prepends shift upward", () => {
    // Replace 2 lines with 1 (shrink), plus prepend at BOF.
    // The prepend's computeOffset must reflect the shrink delta.
    const content = "a\nb\nc\nd\ne";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(3, "c"), end: makeTag(4, "d"), lines: ["C_D"] },
      { op: "prepend", lines: ["P1", "P2"] },
    ];
    const result = applyHashlineEdits(content, edits);

    // Final doc: P1, P2, a, b, C_D, e  (6 lines)
    expect(result.content).toBe("P1\nP2\na\nb\nC_D\ne");
    expect(result.firstChangedLine).toBe(1);
    // Replace at original 3-4 → final 5 (shifted by +2 prepend). Shrunk to 1 line.
    expect(result.lastChangedLine).toBe(5);
  });

  it("rejects stale anchors after compound edits shift content", () => {
    // After a prepend + replace compound edit, the original line 5 anchor
    // should no longer be valid at the same position (its content moved).
    const originalLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const content = originalLines.join("\n");

    const line5Hash = computeLineHash(5, "line5");
    const edits: HashlineEdit[] = [
      { op: "replace", pos: { line: 5, hash: line5Hash }, lines: ["NEW_LINE_5"] },
      { op: "prepend", lines: ["header-1", "header-2", "header-3"] },
    ];

    const result = applyHashlineEdits(content, edits);
    expect(result.content.split("\n")[7]).toBe("NEW_LINE_5"); // line 8 in final doc

    // Attempting to use the OLD anchor (5#hash_of_line5) on the result should fail
    // because line 5 in the new document is "line2", not "line5".
    expect(() => {
      applyHashlineEdits(result.content, [
        { op: "replace", pos: { line: 5, hash: line5Hash }, lines: ["ANOTHER"] },
      ]);
    }).toThrow(/stale anchor/);

    // The correct anchor uses the NEW line number (8) with a fresh hash.
    const newLine5Hash = computeLineHash(8, "NEW_LINE_5");
    const result2 = applyHashlineEdits(result.content, [
      { op: "replace", pos: { line: 8, hash: newLine5Hash }, lines: ["UPDATED_LINE_5"] },
    ]);
    expect(result2.content.split("\n")[7]).toBe("UPDATED_LINE_5");
  });
});
