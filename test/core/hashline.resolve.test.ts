import { describe, expect, it } from "bun:test";
import { resolveEditAnchors, type Anchor, type HashlineToolEdit } from "../../src/hashline";

describe("resolveEditAnchors", () => {
  it("resolves replace with pos + end", () => {
    const edits: HashlineToolEdit[] = [
      { op: "replace", pos: "1#ZZ", end: "3#PP", lines: ["a", "b"] },
    ];
    const resolved = resolveEditAnchors(edits);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].op).toBe("replace");
    expect(resolved[0]).toHaveProperty("pos");
    expect(resolved[0]).toHaveProperty("end");
  });

  it("resolves replace with pos only (single-line)", () => {
    const edits: HashlineToolEdit[] = [
      { op: "replace", pos: "5#MQ", lines: ["new"] },
    ];
    const resolved = resolveEditAnchors(edits);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].op).toBe("replace");
    const r = resolved[0] as {
      op: "replace";
      pos: Anchor;
      end?: Anchor;
      lines: string[];
    };
    expect(r.pos.line).toBe(5);
    expect(r.end).toBeUndefined();
  });

  it("resolves replace with end only (falls back)", () => {
    const edits: HashlineToolEdit[] = [
      { op: "replace", end: "5#MQ", lines: ["new"] },
    ];
    const resolved = resolveEditAnchors(edits);
    expect(resolved).toHaveLength(1);
    const r = resolved[0] as { op: "replace"; pos: Anchor; lines: string[] };
    expect(r.pos.line).toBe(5);
  });

  it("throws on replace with no anchors", () => {
    const edits: HashlineToolEdit[] = [{ op: "replace", lines: ["new"] }];
    expect(() => resolveEditAnchors(edits)).toThrow(/at least one anchor/);
  });

  it("throws on malformed pos for append (not silently degraded to EOF)", () => {
    const edits: HashlineToolEdit[] = [
      { op: "append", pos: "garbage", lines: ["new"] },
    ];
    expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
  });

  it("throws on malformed pos for prepend (not silently degraded to BOF)", () => {
    const edits: HashlineToolEdit[] = [
      { op: "prepend", pos: "garbage", lines: ["new"] },
    ];
    expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
  });

  it("throws on malformed pos for replace", () => {
    const edits: HashlineToolEdit[] = [
      { op: "replace", pos: "not-valid", lines: ["x"] },
    ];
    expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
  });

  it("throws on malformed end for replace with valid pos", () => {
    const edits: HashlineToolEdit[] = [
      { op: "replace", pos: "5#MQ", end: "garbage", lines: ["x"] },
    ];
    expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
  });

  it("resolves append with pos", () => {
    const edits: HashlineToolEdit[] = [
      { op: "append", pos: "5#MQ", lines: ["new"] },
    ];
    const resolved = resolveEditAnchors(edits);
    expect(resolved[0].op).toBe("append");
    expect(resolved[0].pos?.line).toBe(5);
  });

  it("resolves append without pos (EOF)", () => {
    const edits: HashlineToolEdit[] = [{ op: "append", lines: ["new"] }];
    const resolved = resolveEditAnchors(edits);
    expect(resolved[0].op).toBe("append");
    expect(resolved[0].pos).toBeUndefined();
  });

  it("resolves prepend with pos", () => {
    const edits: HashlineToolEdit[] = [
      { op: "prepend", pos: "5#MQ", lines: ["new"] },
    ];
    const resolved = resolveEditAnchors(edits);
    expect(resolved[0].op).toBe("prepend");
  });

  it("resolves prepend without pos (BOF)", () => {
    const edits: HashlineToolEdit[] = [{ op: "prepend", lines: ["new"] }];
    const resolved = resolveEditAnchors(edits);
    expect(resolved[0].op).toBe("prepend");
    expect(resolved[0].pos).toBeUndefined();
  });

  it("parses string lines input", () => {
    const edits: HashlineToolEdit[] = [
      { op: "replace", pos: "1#ZZ", lines: "hello\nworld\n" },
    ];
    const resolved = resolveEditAnchors(edits);
    expect(resolved[0].lines).toEqual(["hello", "world"]);
  });

  it("parses null lines as empty array", () => {
    const edits: HashlineToolEdit[] = [
      { op: "replace", pos: "1#ZZ", lines: null },
    ];
    const resolved = resolveEditAnchors(edits);
    expect(resolved[0].lines).toEqual([]);
  });

  it("throws on unknown op", () => {
    const edits: HashlineToolEdit[] = [
      { op: "something_weird", pos: "1#ZZ", lines: ["x"] },
    ];
    expect(() => resolveEditAnchors(edits)).toThrow(
      'Unknown edit op "something_weird"',
    );
  });

  it("rejects missing op", () => {
    const edits: HashlineToolEdit[] = [{ pos: "1#ZZ", lines: ["x"] } as any];
    expect(() => resolveEditAnchors(edits)).toThrow(/Unknown edit op/);
  });
});
