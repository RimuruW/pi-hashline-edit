import { describe, expect, it } from "bun:test";
import { applyHashlineEdits, computeLineHash, hashlineParseText } from "../../src/hashline";

describe("computeLineHash", () => {
  it("returns a 2-character string from NIBBLE_STR alphabet", () => {
    const hash = computeLineHash(1, "hello");
    expect(hash).toHaveLength(2);
    expect(hash).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
  });

  it("trims trailing whitespace without collapsing internal spaces", () => {
    expect(computeLineHash(1, "a\t")).toBe(computeLineHash(1, "a"));
    expect(computeLineHash(1, "a  b")).not.toBe(computeLineHash(1, "a b"));
  });

  it("strips trailing CR", () => {
    expect(computeLineHash(1, "hello\r")).toBe(computeLineHash(1, "hello"));
  });

  it("mixes line index for symbol-only lines", () => {
    const h1 = computeLineHash(1, "}");
    const h10 = computeLineHash(10, "}");
    expect(h1).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
    expect(h10).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
  });

  it("does NOT mix line index for lines with alphanumeric content", () => {
    expect(computeLineHash(1, "function foo()")).toBe(
      computeLineHash(99, "function foo()"),
    );
  });
});

describe("strict hashline contract", () => {
  it("preserves internal spaces when hashing", () => {
    expect(computeLineHash(1, "a b")).not.toBe(computeLineHash(1, "ab"));
  });

  it("trims trailing spaces when hashing", () => {
    expect(computeLineHash(1, "value  ")).toBe(computeLineHash(1, "value"));
  });

  it("preserves explicit blank trailing line in array input", () => {
    expect(hashlineParseText(["alpha", ""])).toEqual(["alpha", ""]);
  });

  it("rejects stale anchors instead of relocating by hash", () => {
    const content = ["a", "INSERTED", "b", "target", "c"].join("\n");
    const stale = {
      op: "replace",
      pos: { line: 3, hash: computeLineHash(3, "target") },
      lines: ["updated"],
    };

    expect(() => applyHashlineEdits(content, [stale as any])).toThrow(
      /changed since last read/,
    );
  });
});
