import { describe, expect, it } from "bun:test";
import { hashlineParseText, parseLineRef } from "../../src/hashline";

describe("parseLineRef", () => {
  it("parses standard LINE#HASH format", () => {
    const ref = parseLineRef("5#MQ");
    expect(ref).toEqual({ line: 5, hash: "MQ" });
  });

  it("parses with trailing content", () => {
    const ref = parseLineRef("10#ZP:  const x = 1;");
    expect(ref).toEqual({ line: 10, hash: "ZP" });
  });

  it("tolerates leading >>> markers", () => {
    const ref = parseLineRef(">>> 5#MQ:content");
    expect(ref).toEqual({ line: 5, hash: "MQ" });
  });

  it("tolerates leading +/- diff markers", () => {
    expect(parseLineRef("+5#MQ")).toEqual({ line: 5, hash: "MQ" });
    expect(parseLineRef("-5#MQ")).toEqual({ line: 5, hash: "MQ" });
  });

  it("throws on invalid format", () => {
    expect(() => parseLineRef("invalid")).toThrow(/Invalid line reference/);
  });

  it("diagnoses missing hash", () => {
    expect(() => parseLineRef("12")).toThrow(/missing hash/i);
  });

  it("diagnoses wrong separator", () => {
    expect(() => parseLineRef("5:AB")).toThrow(/wrong separator/i);
  });

  it("diagnoses invalid hash alphabet", () => {
    expect(() => parseLineRef("12#ab")).toThrow(/alphabet ZPMQVRWSNKTXJBYH only/i);
  });

  it("diagnoses invalid hash length", () => {
    expect(() => parseLineRef("12#ABC")).toThrow(/hash must be exactly 2 characters/i);
  });

  it("throws on line 0", () => {
    expect(() => parseLineRef("0#MQ")).toThrow(/must be >= 1/);
  });

  it("prefixes structured errors with [E_BAD_REF]", () => {
    expect(() => parseLineRef("invalid")).toThrow(/^\[E_BAD_REF\]/);
  });
});

describe("hashlineParseText", () => {
  it("returns [] for null", () => {
    expect(hashlineParseText(null)).toEqual([]);
  });

  it("splits string on newline", () => {
    expect(hashlineParseText("a\nb")).toEqual(["a", "b"]);
  });

  it("removes trailing blank line from string input", () => {
    expect(hashlineParseText("a\nb\n")).toEqual(["a", "b"]);
  });

  it("preserves a trailing whitespace-only content line in string input", () => {
    expect(hashlineParseText("a\nb\n  ")).toEqual(["a", "b", "  "]);
  });

  it("passes through array input verbatim", () => {
    const input = ["a", "b"];
    expect(hashlineParseText(input)).toEqual(["a", "b"]);
  });

  it("preserves '# Note:' comment lines (no autocorrection)", () => {
    expect(hashlineParseText(["# Note: important"])).toEqual(["# Note: important"]);
  });

  it("preserves literal '+' prefixed content (no autocorrection)", () => {
    expect(hashlineParseText(["+added"])).toEqual(["+added"]);
  });

  it("returns empty string as a single empty line for blank content", () => {
    expect(hashlineParseText("")).toEqual([""]);
  });

  it("rejects array input that contains LINE#HASH: prefixes", () => {
    expect(() => hashlineParseText(["1#ZZ:foo", "2#MQ:bar"])).toThrow(/^\[E_INVALID_PATCH\]/);
  });

  it("rejects diff-preview hunks with + and context hash prefixes", () => {
    expect(() =>
      hashlineParseText([" 9#MQ:keep", "+10#VR:new", " 11#WS:after"]),
    ).toThrow(/^\[E_INVALID_PATCH\]/);
  });

  it("rejects diff-preview deletion rows", () => {
    expect(() =>
      hashlineParseText([" 9#MQ:keep", "-10    old", " 11#WS:after"]),
    ).toThrow(/^\[E_INVALID_PATCH\]/);
  });

  it("rejects string-form rendered diff hunks", () => {
    const input = " 9#MQ:keep\n-10    old\n+10#VR:new\n 11#WS:after";
    expect(() => hashlineParseText(input)).toThrow(/^\[E_INVALID_PATCH\]/);
  });
});
