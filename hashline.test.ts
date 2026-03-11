import { describe, expect, it } from "bun:test";
import {
  applyHashlineEdits,
  computeLineHash,
  resolveEditAnchors,
  type Anchor,
  type HashlineEdit,
  type HashlineToolEdit,
} from "./src/hashline";

function makeTag(lineNum: number, text: string): Anchor {
  return { line: lineNum, hash: computeLineHash(lineNum, text) };
}

describe("applyHashlineEdits — error handling", () => {
  it("throws on hash mismatch", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: { line: 2, hash: "XX" }, lines: ["BBB"] },
    ];
    expect(() => applyHashlineEdits(content, edits)).toThrow(/changed since last read/);
  });

  it("throws on out-of-range line", () => {
    const content = "aaa\nbbb";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: { line: 99, hash: "ZZ" }, lines: ["x"] },
    ];
    expect(() => applyHashlineEdits(content, edits)).toThrow(/does not exist/);
  });

  it("throws on range start > end", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(3, "ccc"),
        end: makeTag(1, "aaa"),
        lines: ["x"],
      },
    ];
    expect(() => applyHashlineEdits(content, edits)).toThrow(/must be <= end line/);
  });

  it("reports multiple mismatches at once", () => {
    const content = "aaa\nbbb\nccc";
    const edits: HashlineEdit[] = [
      { op: "replace", pos: { line: 1, hash: "XX" }, lines: ["A"] },
      { op: "replace", pos: { line: 3, hash: "YY" }, lines: ["C"] },
    ];
    expect(() => applyHashlineEdits(content, edits)).toThrow(/2 lines have changed/);
  });

  it("mismatch message does not mention relocation", () => {
    expect(() =>
      applyHashlineEdits("aaa", [
        {
          op: "replace",
          pos: { line: 1, hash: "ZZ" },
          lines: ["bbb"],
        } as any,
      ]),
    ).toThrow(/Use the updated LINE#HASH references/);
  });
});

// Only explicit input cleanup plus this boundary-duplicate correction remain as
// default assist heuristics; hidden intent-recovery behavior is intentionally excluded.
describe("applyHashlineEdits — heuristics", () => {
  it("auto-corrects trailing duplicate on range replace", () => {
    const content = "if (ok) {\n  run();\n}\nafter();";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(1, "if (ok) {"),
        end: makeTag(2, "  run();"),
        lines: ["if (ok) {", "  runSafe();", "}"],
      },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("if (ok) {\n  runSafe();\n}\nafter();");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain("Auto-corrected range replace");
  });

  it("does NOT auto-correct when end already includes boundary", () => {
    const content =
      "function outer() {\n  function inner() {\n    run();\n  }\n}";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(1, "function outer() {"),
        end: makeTag(4, "  }"),
        lines: [
          "function outer() {",
          "  function inner() {",
          "    runSafe();",
          "  }",
        ],
      },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe(
      "function outer() {\n  function inner() {\n    runSafe();\n  }\n}",
    );
    expect(result.warnings).toBeUndefined();
  });

  it("does NOT auto-correct when trailing line trims to empty", () => {
    const content = "alpha\nbeta\n\ngamma";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(1, "alpha"),
        end: makeTag(2, "beta"),
        lines: ["ALPHA", ""],
      },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("ALPHA\n\n\ngamma");
    expect(result.warnings).toBeUndefined();
  });

  it("auto-corrects leading duplicate on range replace", () => {
    const content = "before();\nif (ok) {\n  run();\n}\nafter();";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(2, "if (ok) {"),
        end: makeTag(3, "  run();"),
        lines: ["before();", "if (ok) {", "  runSafe();"],
      },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe(
      "before();\nif (ok) {\n  runSafe();\n}\nafter();",
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain("removed leading replacement line");
  });

  it("does NOT auto-correct leading duplicate for short non-brace lines", () => {
    const content = "x\nalpha\nbeta";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(2, "alpha"),
        end: makeTag(3, "beta"),
        lines: ["x", "ALPHA", "BETA"],
      },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("x\nx\nALPHA\nBETA");
    expect(result.warnings).toBeUndefined();
  });

  it("auto-corrects leading duplicate for brace closers", () => {
    const content = "}\nfunction foo() {\n  bar();\n}";
    const edits: HashlineEdit[] = [
      {
        op: "replace",
        pos: makeTag(2, "function foo() {"),
        end: makeTag(3, "  bar();"),
        lines: ["}", "function foo() {", "  baz();"],
      },
    ];
    const result = applyHashlineEdits(content, edits);
    expect(result.content).toBe("}\nfunction foo() {\n  baz();\n}");
    expect(result.warnings).toHaveLength(1);
  });
});

describe("integration: resolveEditAnchors → applyHashlineEdits", () => {
  it("full pipeline: tool-schema edit → resolve → apply", () => {
    const content = "aaa\nbbb\nccc";
    const tag2 = `2#${computeLineHash(2, "bbb")}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag2, lines: ["BBB"] },
    ];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });

  it("full pipeline: string lines get parsed correctly", () => {
    const content = "aaa\nbbb\nccc";
    const tag2 = `2#${computeLineHash(2, "bbb")}`;
    const toolEdits: HashlineToolEdit[] = [{ op: "replace", pos: tag2, lines: "BBB" }];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });

  it("full pipeline: null lines → delete", () => {
    const content = "aaa\nbbb\nccc";
    const tag2 = `2#${computeLineHash(2, "bbb")}`;
    const toolEdits: HashlineToolEdit[] = [{ op: "replace", pos: tag2, lines: null }];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nccc");
  });

  it("full pipeline: prepend to BOF", () => {
    const content = "aaa\nbbb";
    const toolEdits: HashlineToolEdit[] = [{ op: "prepend", lines: ["header"] }];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("header\naaa\nbbb");
  });

  it("full pipeline: append to EOF", () => {
    const content = "aaa\nbbb";
    const toolEdits: HashlineToolEdit[] = [{ op: "append", lines: ["footer"] }];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nbbb\nfooter");
  });

  it("full pipeline: hashline-prefixed string lines get stripped", () => {
    const content = "aaa\nbbb\nccc";
    const tag2 = `2#${computeLineHash(2, "bbb")}`;
    const hash = computeLineHash(2, "BBB");
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag2, lines: `2#${hash}:BBB` },
    ];
    const resolved = resolveEditAnchors(toolEdits);
    const result = applyHashlineEdits(content, resolved);
    expect(result.content).toBe("aaa\nBBB\nccc");
  });
});
