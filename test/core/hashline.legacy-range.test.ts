import { describe, expect, it } from "bun:test";
import { computeLegacyEditLineRange } from "../../src/hashline";

describe("computeLegacyEditLineRange", () => {
  it("returns null when content is unchanged", () => {
    expect(computeLegacyEditLineRange("a\nb\nc", "a\nb\nc")).toBeNull();
  });

  it("tracks a single-line replace", () => {
    const result = computeLegacyEditLineRange("a\nb\nc", "a\nB\nc");
    expect(result).toEqual({ firstChangedLine: 2, lastChangedLine: 2 });
  });

  it("tracks a multi-line replace that expands", () => {
    const result = computeLegacyEditLineRange("a\nb\nc", "a\nB1\nB2\nc");
    expect(result).toEqual({ firstChangedLine: 2, lastChangedLine: 3 });
  });

  it("tracks a multi-line delete in the middle", () => {
    // Deleting "b\nc\n" from "a\nb\nc\nd" should report line 2 as changed
    // (where "d" moves up), not { firstChangedLine: 2, lastChangedLine: 1 }.
    const result = computeLegacyEditLineRange("a\nb\nc\nd", "a\nd");
    expect(result).not.toBeNull();
    expect(result!.firstChangedLine).toBeLessThanOrEqual(result!.lastChangedLine);
    expect(result).toEqual({ firstChangedLine: 2, lastChangedLine: 2 });
  });

  it("tracks deleting head of file", () => {
    const result = computeLegacyEditLineRange("a\nb\nc\nd", "c\nd");
    expect(result!.firstChangedLine).toBeLessThanOrEqual(result!.lastChangedLine);
    expect(result).toEqual({ firstChangedLine: 1, lastChangedLine: 2 });
  });

  it("tracks deleting tail of file", () => {
    const result = computeLegacyEditLineRange("a\nb\nc\nd", "a\nb");
    expect(result!.firstChangedLine).toBeLessThanOrEqual(result!.lastChangedLine);
  });

  it("tracks prepending at BOF", () => {
    const result = computeLegacyEditLineRange("a\nb\nc", "X\na\nb\nc");
    expect(result).toEqual({ firstChangedLine: 1, lastChangedLine: 1 });
  });

  it("tracks appending at EOF", () => {
    const result = computeLegacyEditLineRange("a\nb\nc", "a\nb\nc\nX");
    expect(result).toEqual({ firstChangedLine: 4, lastChangedLine: 4 });
  });

  it("tracks deleting all content", () => {
    const result = computeLegacyEditLineRange("a\nb\nc", "");
    expect(result).toEqual({ firstChangedLine: 1, lastChangedLine: 1 });
  });
});
