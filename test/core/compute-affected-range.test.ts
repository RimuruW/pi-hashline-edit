import { describe, expect, it } from "bun:test";
import { computeAffectedLineRange } from "../../src/hashline";

describe("computeAffectedLineRange", () => {
  it("returns null when firstChangedLine is undefined", () => {
    expect(
      computeAffectedLineRange({
        firstChangedLine: undefined,
        lastChangedLine: 5,
        resultLineCount: 10,
      }),
    ).toBeNull();
  });

  it("returns null when lastChangedLine is undefined", () => {
    expect(
      computeAffectedLineRange({
        firstChangedLine: 2,
        lastChangedLine: undefined,
        resultLineCount: 10,
      }),
    ).toBeNull();
  });

  it("returns range with context for a single-line change", () => {
    const result = computeAffectedLineRange({
      firstChangedLine: 5,
      lastChangedLine: 5,
      resultLineCount: 20,
    });
    expect(result).toEqual({ start: 3, end: 7 });
  });

  it("returns range with context for a multi-line change", () => {
    const result = computeAffectedLineRange({
      firstChangedLine: 10,
      lastChangedLine: 15,
      resultLineCount: 30,
    });
    expect(result).toEqual({ start: 8, end: 17 });
  });

  it("clamps start to 1 for changes near BOF", () => {
    const result = computeAffectedLineRange({
      firstChangedLine: 1,
      lastChangedLine: 2,
      resultLineCount: 20,
    });
    expect(result).toEqual({ start: 1, end: 4 });
  });

  it("clamps end to resultLineCount for changes near EOF", () => {
    const result = computeAffectedLineRange({
      firstChangedLine: 19,
      lastChangedLine: 20,
      resultLineCount: 20,
    });
    expect(result).toEqual({ start: 17, end: 20 });
  });

  it("returns null when range + context exceeds maxOutputLines", () => {
    const result = computeAffectedLineRange({
      firstChangedLine: 1,
      lastChangedLine: 15,
      resultLineCount: 20,
      maxOutputLines: 12,
    });
    // 1-15 = 15 lines > 12, even with clamping
    expect(result).toBeNull();
  });

  it("accepts a range that exactly fits maxOutputLines", () => {
    const result = computeAffectedLineRange({
      firstChangedLine: 3,
      lastChangedLine: 8,
      resultLineCount: 20,
      maxOutputLines: 12,
      contextLines: 2,
    });
    // 3-2=1 to 8+2=10 → 10 lines ≤ 12
    expect(result).toEqual({ start: 1, end: 10 });
  });

  it("supports custom contextLines", () => {
    const result = computeAffectedLineRange({
      firstChangedLine: 5,
      lastChangedLine: 5,
      resultLineCount: 20,
      contextLines: 1,
    });
    expect(result).toEqual({ start: 4, end: 6 });
  });
});
