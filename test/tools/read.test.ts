import { describe, it, expect } from "bun:test";
import register from "../../index";
import { formatHashlineReadPreview, formatHashlineRegion } from "../../src/read";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("formatHashlineReadPreview", () => {
  it("refuses to emit a truncated hashline for an oversized first line", () => {
    const longLine = "x".repeat(70_000);
    const result = formatHashlineReadPreview(longLine, { offset: 1 });

    expect(result.text).toContain("Hashline output requires full lines");
    expect(result.truncation?.truncated).toBeTrue();
    expect(result.truncation?.truncatedBy).toBe("bytes");
    expect(result.truncation?.firstLineExceedsLimit).toBeTrue();
  });

  it("formats ordinary lines as full hashlines", () => {
    const result = formatHashlineReadPreview("alpha\nbeta", { offset: 1 });

    expect(result.text).toContain("1#");
    expect(result.text).toContain(":alpha");
  });

  it("returns an advisory for empty files instead of a synthetic empty-line anchor", () => {
    const result = formatHashlineReadPreview("", { offset: 1 });

    expect(result.text).toContain("File is empty");
    expect(result.text).toContain("prepend or append");
    expect(result.text).not.toContain("1#");
  });

  it("hides the terminal newline sentinel from preview output", () => {
    const result = formatHashlineReadPreview("alpha\nbeta\n", { offset: 1 });

    expect(result.text).toContain("1#");
    expect(result.text).toContain("2#");
    expect(result.text).toContain(":alpha");
    expect(result.text).toContain(":beta");
    expect(result.text).not.toContain("3#");
    expect(result.text).not.toContain("2 lines total");
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

describe("formatHashlineRegion", () => {
  it("formats lines with LINE#HASH anchors starting from the given line number", () => {
    const lines = ["alpha", "beta", "gamma"];
    const result = formatHashlineRegion(lines, 5);

    expect(result).toBe(
      `5#${computeLineHash(5, "alpha")}:alpha\n` +
      `6#${computeLineHash(6, "beta")}:beta\n` +
      `7#${computeLineHash(7, "gamma")}:gamma`,
    );
  });

  it("handles a single line", () => {
    const result = formatHashlineRegion(["hello"], 1);
    expect(result).toBe(`1#${computeLineHash(1, "hello")}:hello`);
  });

  it("handles empty array", () => {
    const result = formatHashlineRegion([], 1);
    expect(result).toBe("");
  });
});

describe("read tool protocol", () => {
  it("returns the empty-file advisory through the registered tool", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "empty.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("File is empty");
      expect(result.content[0].text).not.toContain("1#");
    });
  });

  it("omits the trailing newline sentinel through the registered tool", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "sample.txt" },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain(":alpha");
      expect(result.content[0].text).toContain(":beta");
      expect(result.content[0].text).not.toContain("3#");
    });
  });
});
