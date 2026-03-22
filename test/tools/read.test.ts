import { describe, it, expect } from "bun:test";
import { formatHashlineReadPreview } from "../../src/read";

describe("formatHashlineReadPreview", () => {
  it("refuses to emit a truncated hashline for an oversized first line", () => {
    const longLine = "x".repeat(70_000);
    const result = formatHashlineReadPreview(longLine, { offset: 1 });

    expect(result.text).toContain("Hashline output requires full lines");
  });

  it("formats ordinary lines as full hashlines", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", { offset: 1 });

    expect(result.text).toContain("1#");
    expect(result.text).toContain(":alpha");
  });

  it("keeps continuation hints for partial previews", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", {
      offset: 1,
      limit: 1,
    });

    expect(result.text).toContain("Use offset=2 to continue");
  });

  it("reports when offset is beyond end of content", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", { offset: 10 });

    expect(result.text).toContain("Offset 10 is beyond end of file");
    expect(result.text).toContain("2 lines total");
  });

  it("rejects fractional offsets", () => {
    expect(() =>
      formatHashlineReadPreview("alpha\nbeta", { offset: 1.5 }),
    ).toThrow(/offset.*positive integer/i);
  });

  it("rejects non-positive limits", () => {
    expect(() =>
      formatHashlineReadPreview("alpha\nbeta", { limit: 0 }),
    ).toThrow(/limit.*positive integer/i);
  });
});
