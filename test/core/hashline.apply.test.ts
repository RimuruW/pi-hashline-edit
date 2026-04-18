import { describe, expect, it } from "bun:test";
import { applyHashlineEdits, computeAffectedLineRange, computeLineHash, type HashlineEdit } from "../../src/hashline";

function makeTag(line: number, text: string) {
  return { line, hash: computeLineHash(line, text) };
}

describe("applyHashlineEdits — basic operations", () => {
  it("returns content unchanged for empty edits", () => {
    const result = applyHashlineEdits("hello\nworld", []);
    expect(result.content).toBe("hello\nworld");
    expect(result.firstChangedLine).toBeUndefined();
  });

  it("replaces a single line", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), lines: ["BBB"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nccc");
    expect(result.firstChangedLine).toBe(2);
  });

  it("replaces a single line with multiple lines", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), lines: ["BBB", "B2"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nB2\nccc");
  });

  it("deletes a single line (empty lines array)", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), lines: [] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nccc");
  });

  it("replaces a range of lines", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits: HashlineEdit[] = [{
      op: "replace",
      pos: makeTag(2, "bbb"),
      end: makeTag(3, "ccc"),
      lines: ["BBB", "CCC"],
    }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nCCC\nddd");
  });

  it("deletes a range of lines", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits: HashlineEdit[] = [{
      op: "replace",
      pos: makeTag(2, "bbb"),
      end: makeTag(3, "ccc"),
      lines: [],
    }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nddd");
  });

  it("appends after a line", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "append", pos: makeTag(2, "bbb"), lines: ["inserted"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nbbb\ninserted\nccc");
    expect(result.firstChangedLine).toBe(3);
  });

  it("appends to EOF (no pos)", () => {
    const content = "aaa\nbbb";
    const edits: HashlineEdit[] = [{ op: "append", lines: ["ccc"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nbbb\nccc");
  });

  it("appends to EOF before the terminal newline sentinel", () => {
    const content = "aaa\nbbb\n";
    const edits: HashlineEdit[] = [{ op: "append", lines: ["ccc"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nbbb\nccc\n");
    expect(result.firstChangedLine).toBe(3);
  });

  it("treats append after the terminal newline sentinel as EOF append", () => {
    const content = "aaa\nbbb\n";
    const edits: HashlineEdit[] = [{ op: "append", pos: makeTag(3, ""), lines: ["ccc"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nbbb\nccc\n");
    expect(result.firstChangedLine).toBe(3);
  });

  it("appends to empty file", () => {
    const content = "";
    const edits: HashlineEdit[] = [{ op: "append", lines: ["first"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("first");
  });

  it("prepends before a line", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "prepend", pos: makeTag(2, "bbb"), lines: ["inserted"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\ninserted\nbbb\nccc");
    expect(result.firstChangedLine).toBe(2);
  });

  it("prepends to BOF (no pos)", () => {
    const content = "aaa\nbbb";
    const edits: HashlineEdit[] = [{ op: "prepend", lines: ["zzz"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("zzz\naaa\nbbb");
    expect(result.firstChangedLine).toBe(1);
  });

  it("prepends to empty file", () => {
    const content = "";
    const edits: HashlineEdit[] = [{ op: "prepend", lines: ["first"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("first");
  });
});

describe("applyHashlineEdits — multi-edit ordering", () => {
  it("applies multiple edits bottom-up correctly", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(1, "aaa"), lines: ["AAA"] },
      { op: "replace", pos: makeTag(3, "ccc"), lines: ["CCC"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("AAA\nbbb\nCCC");
  });

  it("handles append + replace on same file", () => {
    const content = "aaa\nbbb";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(1, "aaa"), lines: ["AAA"] },
      { op: "append", pos: makeTag(2, "bbb"), lines: ["ccc"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("AAA\nbbb\nccc");
  });

  it("deduplicates identical edits", () => {
    const content = "aaa\nbbb\nccc";
    const pos = makeTag(2, "bbb");
    const edits: HashlineEdit[] = [
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });

  it("preserves append-after-range-end because edits apply bottom-up", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(2, "bbb"),
        end: makeTag(3, "ccc"),
        lines: ["BBB", "CCC"],
      },
      { op: "append", pos: makeTag(3, "ccc"), lines: ["tail"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("aaa\nBBB\nCCC\ntail\nddd");
  });

  it("does not mutate caller-owned edit arrays while deduplicating", () => {
    const content = "aaa\nbbb\nccc";
    const pos = makeTag(2, "bbb");
    const edits: HashlineEdit[] = [
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
      { op: "replace", pos: { ...pos }, lines: ["BBB"] },
    ];

    applyHashlineEdits(content, edits);

    expect(edits).toHaveLength(2);
    expect(edits[0]).toEqual({ op: "replace", pos: { ...pos }, lines: ["BBB"] });
    expect(edits[1]).toEqual({ op: "replace", pos: { ...pos }, lines: ["BBB"] });
  });
});

describe("applyHashlineEdits — noop detection", () => {
  it("detects single-line noop", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), lines: ["bbb"] }];
    const result = applyHashlineEdits(content, edits);
    expect(result.noopEdits).toHaveLength(1);
    expect(result.noopEdits![0].editIndex).toBe(0);
  });

  it("detects range noop", () => {
    const content = "aaa\nbbb\nccc\nddd";
    const edits: HashlineEdit[] = [{
      op: "replace",
      pos: makeTag(2, "bbb"),
      end: makeTag(3, "ccc"),
      lines: ["bbb", "ccc"],
    }];
    const result = applyHashlineEdits(content, edits);
    expect(result.noopEdits).toHaveLength(1);
  });

  it("throws on empty append lines payload", () => {
    const content = "aaa\nbbb";
    const edits: HashlineEdit[] = [{ op: "append", pos: makeTag(2, "bbb"), lines: [] }];
    expect(() => applyHashlineEdits(content, edits)).toThrow(/empty lines payload/);
  });

  it("throws on empty prepend lines payload", () => {
    const content = "aaa\nbbb";
    const edits: HashlineEdit[] = [{ op: "prepend", pos: makeTag(1, "aaa"), lines: [] }];
    expect(() => applyHashlineEdits(content, edits)).toThrow(/empty lines payload/);
  });
});

describe("applyHashlineEdits — warning heuristics", () => {
  it("does not warn when a single prepend only shifts existing lines", () => {
    const content = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");
    const edits: HashlineEdit[] = [{ op: "prepend", lines: ["HEADER"] }];

    const result = applyHashlineEdits(content, edits);

    expect(result.content.startsWith("HEADER\nline 1\nline 2")).toBeTrue();
    expect(result.warnings).toBeUndefined();
  });
});

describe("applyHashlineEdits — lastChangedLine tracking", () => {
  it("tracks lastChangedLine when single-line replace expands to multiple lines", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(2, "bbb"), lines: ["B1", "B2", "B3", "B4", "B5"] },
    ];
    const result = applyHashlineEdits(content, edits);

    expect(result.firstChangedLine).toBe(2);
    expect(result.lastChangedLine).toBe(6);
  });

  it("tracks lastChangedLine correctly for single-line delete", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [{ op: "replace", pos: makeTag(2, "bbb"), lines: [] }];
    const result = applyHashlineEdits(content, edits);

    expect(result.firstChangedLine).toBe(2);
    expect(result.lastChangedLine).toBe(2);
  });

  it("tracks lastChangedLine correctly for multi-line delete", () => {
    const content = "aaa\nbbb\nccc\nddd\neee\nfff\nggg";
    const edits: HashlineEdit[] = [{
      op: "replace",
      pos: makeTag(2, "bbb"),
      end: makeTag(4, "ddd"),
      lines: [],
    }];
    const result = applyHashlineEdits(content, edits);

    expect(result.firstChangedLine).toBe(2);
    expect(result.lastChangedLine).toBe(4);
  });

  it("tracks lastChangedLine for append with terminal newline", () => {
    const content = "aaa\nbbb\n";
    const edits: HashlineEdit[] = [{ op: "append", lines: ["ccc"] }];
    const result = applyHashlineEdits(content, edits);

    expect(result.firstChangedLine).toBe(3);
    expect(result.lastChangedLine).toBe(3);
  });

  it("tracks lastChangedLine for prepend at BOF", () => {
    const content = "aaa\nbbb\n";
    const edits: HashlineEdit[] = [{ op: "prepend", lines: ["zzz"] }];
    const result = applyHashlineEdits(content, edits);

    expect(result.firstChangedLine).toBe(1);
    expect(result.lastChangedLine).toBe(1);
  });

  it("tracks affected range for prepend + lower replace (P1 regression)", () => {
    // Prepend at top shifts a lower replace downward; the tracked range must
    // use final-document coordinates, not stale pre-shift line numbers.
    const content = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: makeTag(5, "e"), lines: ["E1", "E2", "E3", "E4"] },
      { op: "prepend", lines: ["P1", "P2", "P3"] },
    ];
    const result = applyHashlineEdits(content, edits);
    // Final doc: P1,P2,P3,a,b,c,d,E1,E2,E3,E4,f,g,h,i,j  (16 lines)
    // Changed region: lines 1-3 (prepend) and 8-11 (replace shifted by +3)
    expect(result.firstChangedLine).toBe(1);
    expect(result.lastChangedLine).toBe(11);
    expect(result.content.split("\n").length).toBe(16);
  });

  it("tracks lastChangedLine for append + prepend (P1 regression)", () => {
    // Append near EOF is tracked using intermediate buffer position. When a
    // prepend runs later it shifts the appended block downward, so the tracked
    // span must use original coordinates + computeOffset, not insertAt.
    const content = "a\nb\nc\nd";
    const edits: HashlineEdit[] = [
      { op: "append", pos: makeTag(3, "c"), lines: ["X"] },
      { op: "prepend", lines: ["P1", "P2"] },
    ];
    const result = applyHashlineEdits(content, edits);
    // Final doc: P1,P2,a,b,c,X,d  (7 lines)
    // Append content "X" ends up at line 6, not line 4.
    expect(result.firstChangedLine).toBe(1);
    expect(result.lastChangedLine).toBe(6);
    expect(result.content).toBe("P1\nP2\na\nb\nc\nX\nd");
  });

  it("tracks lastChangedLine for EOF append + prepend (P1 regression)", () => {
    const content = "a\nb\nc\n";
    const edits: HashlineEdit[] = [
      { op: "append", lines: ["X"] },
      { op: "prepend", lines: ["P"] },
    ];
    const result = applyHashlineEdits(content, edits);
    // Final doc: P,a,b,c,X\n  →  P,a,b,c,X  (5 lines after join)
    // "X" is at line 5, not line 4.
    expect(result.firstChangedLine).toBe(1);
    expect(result.lastChangedLine).toBe(5);
    expect(result.content).toBe("P\na\nb\nc\nX\n");
  });

  it("tracks lastChangedLine for EOF append (no terminal newline) + prepend (P1 regression)", () => {
    const content = "a\nb\nc";
    const edits: HashlineEdit[] = [
      { op: "append", lines: ["X"] },
      { op: "prepend", lines: ["P"] },
    ];
    const result = applyHashlineEdits(content, edits);
    // Final doc: P,a,b,c,X  (5 lines)
    expect(result.firstChangedLine).toBe(1);
    expect(result.lastChangedLine).toBe(5);
    expect(result.content).toBe("P\na\nb\nc\nX");
  });

  it("tracks lastChangedLine for empty-file append + prepend (P1 regression)", () => {
    const content = "";
    const edits: HashlineEdit[] = [
      { op: "append", lines: ["A"] },
      { op: "prepend", lines: ["P"] },
    ];
    const result = applyHashlineEdits(content, edits);
    // Final doc: P,A  (2 lines)
    expect(result.firstChangedLine).toBe(1);
    expect(result.lastChangedLine).toBe(2);
    expect(result.content).toBe("P\nA");
  });

  it("tracks lastChangedLine for sentinel append + prepend (P1 regression)", () => {
    const content = "a\nb\nc\n";
    const edits: HashlineEdit[] = [
      { op: "append", pos: makeTag(4, ""), lines: ["X"] },
      { op: "prepend", lines: ["P"] },
    ];
    const result = applyHashlineEdits(content, edits);
    // Final doc: P,a,b,c,X\n  →  P,a,b,c,X  (5 lines after join)
    expect(result.firstChangedLine).toBe(1);
    expect(result.lastChangedLine).toBe(5);
    expect(result.content).toBe("P\na\nb\nc\nX\n");
  });

  it("tracks offsets for range replace combined with boundary append without autocorrection", () => {
    const content = "a\nb\nc\n}";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(2, "b"),
        end: makeTag(3, "c"),
        lines: ["B", "C", "}"],
      },
      { op: "append", pos: makeTag(3, "c"), lines: ["X"] },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("a\nB\nC\nX\n}\n}");
    expect(result.firstChangedLine).toBe(2);
    expect(result.lastChangedLine).toBe(5);
    expect(result.warnings).toBeUndefined();
  });
});
