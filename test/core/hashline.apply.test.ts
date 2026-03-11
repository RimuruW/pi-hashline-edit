import { describe, expect, it } from "bun:test";
import { applyHashlineEdits, computeLineHash, type HashlineEdit } from "../../src/hashline";

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
