import { describe, it, expect } from "bun:test";
import { formatHashlineReadPreview } from "./src/read";

describe("formatHashlineReadPreview", () => {
  it("refuses to emit a truncated hashline for an oversized first line", () => {
    const longLine = "x".repeat(70_000);
    const result = formatHashlineReadPreview(longLine, { offset: 1 });

    expect(result.text).toContain("Hashline output requires full lines");
  });
});
