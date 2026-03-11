import { describe, expect, it } from "bun:test";
import { hashlineParseText, parseLineRef, stripNewLinePrefixes } from "../../src/hashline";

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
    expect(() => parseLineRef("5:AB")).toThrow(/Invalid line reference/);
  });

  it("throws on line 0", () => {
    expect(() => parseLineRef("0#MQ")).toThrow(/must be >= 1/);
  });
});

describe("stripNewLinePrefixes", () => {
  it("strips hashline prefixes when all non-empty lines carry them", () => {
    const lines = ["1#ZZ:foo", "2#MQ:bar", "3#PP:baz"];
    expect(stripNewLinePrefixes(lines)).toEqual(["foo", "bar", "baz"]);
  });

  it("does NOT strip when any non-empty line is plain", () => {
    const lines = ["1#ZZ:foo", "bar", "3#PP:baz"];
    expect(stripNewLinePrefixes(lines)).toEqual(["1#ZZ:foo", "bar", "3#PP:baz"]);
  });

  it("strips hash-only prefixes (#ID:content)", () => {
    const lines = ["#WQ:", "#TZ:hello", "#HX:world"];
    expect(stripNewLinePrefixes(lines)).toEqual(["", "hello", "world"]);
  });

  it("strips diff + prefixes at majority threshold", () => {
    const lines = ["+added", "+also added", "context"];
    expect(stripNewLinePrefixes(lines)).toEqual(["added", "also added", "context"]);
  });

  it("does NOT strip ++ lines", () => {
    const lines = ["++conflict", "++marker"];
    expect(stripNewLinePrefixes(lines)).toEqual(["++conflict", "++marker"]);
  });

  it("preserves empty lines while stripping prefixed ones", () => {
    const lines = ["1#ZZ:foo", "", "3#PP:baz"];
    expect(stripNewLinePrefixes(lines)).toEqual(["foo", "", "baz"]);
  });

  it("returns lines as-is when no pattern matches", () => {
    const lines = ["normal", "text", "here"];
    expect(stripNewLinePrefixes(lines)).toEqual(["normal", "text", "here"]);
  });

  it("preserves '# Note:' comment lines (not matched by prefix regex)", () => {
    const lines = ["# Note: this is important"];
    expect(stripNewLinePrefixes(lines)).toEqual(["# Note: this is important"]);
  });

  it("preserves '# TODO:' comment lines", () => {
    const lines = ["# TODO: fix this later"];
    expect(stripNewLinePrefixes(lines)).toEqual(["# TODO: fix this later"]);
  });

  it("preserves '# FIXME:' comment lines", () => {
    const lines = ["# FIXME: broken edge case"];
    expect(stripNewLinePrefixes(lines)).toEqual(["# FIXME: broken edge case"]);
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

  it("passes through array input as-is when no strip applies", () => {
    const input = ["a", "b"];
    expect(hashlineParseText(input)).toEqual(["a", "b"]);
  });

  it("strips hashline prefixes from array input", () => {
    const input = ["1#ZZ:foo", "2#MQ:bar"];
    expect(hashlineParseText(input)).toEqual(["foo", "bar"]);
  });

  it("returns empty string as a single empty line for blank content", () => {
    expect(hashlineParseText("")).toEqual([""]);
  });

  it("preserves '# Note:' comment in hashlineParseText", () => {
    expect(hashlineParseText(["# Note: important"])).toEqual(["# Note: important"]);
  });
});
