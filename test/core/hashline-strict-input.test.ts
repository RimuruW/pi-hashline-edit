import { describe, expect, it } from "vitest";
import {
  applyHashlineEdits,
  computeLineHash,
  resolveEditAnchors,
  type HashlineToolEdit,
} from "../../src/hashline";

describe("strict edit input (no autocorrection)", () => {
  it("rejects array lines containing rendered LINE#HASH: prefixes", () => {
    const tag = `1#${computeLineHash(1, "foo")}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: ["1#ZP:foo"] },
    ];
    expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
  });

  it("rejects string lines containing rendered diff additions", () => {
    const tag = `1#${computeLineHash(1, "foo")}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: "+1#ZP:foo" },
    ];
    expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
  });

  it("rejects diff deletion rows in array form", () => {
    const tag = `1#${computeLineHash(1, "foo")}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: ["-1    foo"] },
    ];
    expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
  });

  it("accepts plain literal content unchanged", () => {
    const tag = `1#${computeLineHash(1, "foo")}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: ["bar"] },
    ];
    const resolved = resolveEditAnchors(toolEdits);
    expect(resolved).toHaveLength(1);
    if (resolved[0]?.op === "replace") {
      expect(resolved[0].lines).toEqual(["bar"]);
    } else {
      throw new Error("expected replace");
    }
  });

  it("preserves '#' comment lines that do not match the strict prefix", () => {
    const tag = `1#${computeLineHash(1, "foo")}`;
    const toolEdits: HashlineToolEdit[] = [
      { op: "replace", pos: tag, lines: ["# Note: keep me"] },
    ];
    const resolved = resolveEditAnchors(toolEdits);
    if (resolved[0]?.op === "replace") {
      expect(resolved[0].lines).toEqual(["# Note: keep me"]);
    } else {
      throw new Error("expected replace");
    }
  });
});

describe("partial hash prefixes copied into content (issue #24)", () => {
  // Fixture hash set is {JN, NK, WB, SJ}; "ZZ"/"ZP"/"TS" are confirmed misses.
  const file = "alpha\nbeta\ngamma\ndelta";
  const anchor = `1#${computeLineHash(1, "alpha")}`;

  function applyTool(toolEdits: HashlineToolEdit[]) {
    return applyHashlineEdits(file, resolveEditAnchors(toolEdits));
  }

  it("hard-rejects a bare prefix whose hash matches an existing file line", () => {
    // "NK" is the hash of line 2 ("beta"); copying it into content is the bug.
    expect(() =>
      applyTool([
        { op: "replace", pos: anchor, lines: ["NK:### heading", "real content"] },
      ]),
    ).toThrow(/^\[E_INVALID_PATCH\]/);
  });

  it("includes the offending hash and a re-read hint in the rejection", () => {
    expect(() =>
      applyTool([{ op: "replace", pos: anchor, lines: ['NK:text'] }]),
    ).toThrow(/"NK".*Re-read the file/s);
  });

  it("warns (does not reject) when bare prefixes miss the file hash set", () => {
    const result = applyTool([
      { op: "replace", pos: anchor, lines: ["ZZ:one", "ZP:two"] },
    ]);
    expect(result.warnings?.some((w) => /2-char hash/.test(w))).toBe(true);
    // Content is written verbatim — strict semantics, no silent patching.
    expect(result.content).toContain("ZZ:one");
    expect(result.content).toContain("ZP:two");
  });

  it("accepts a single legit 'HH:' line without warning (below threshold)", () => {
    const result = applyTool([
      { op: "replace", pos: anchor, lines: ["TS: TypeScript"] },
    ]);
    expect(result.warnings?.some((w) => /2-char hash/.test(w)) ?? false).toBe(false);
    expect(result.content).toContain("TS: TypeScript");
  });
});
