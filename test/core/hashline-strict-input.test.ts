import { describe, expect, it } from "bun:test";
import { computeLineHash, resolveEditAnchors, type HashlineToolEdit } from "../../src/hashline";

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
