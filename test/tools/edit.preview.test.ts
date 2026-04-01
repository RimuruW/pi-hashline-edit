import { describe, expect, it } from "bun:test";
import { chmod } from "fs/promises";
import { computeEditPreview } from "../../src/edit";
import { computeLineHash } from "../../src/hashline";
import { withTempFile } from "../support/fixtures";

describe("computeEditPreview", () => {
  it("returns a diff for strict hashline edits before execution", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const betaRef = `2#${computeLineHash(2, "bbb")}:bbb`;
      const preview = await computeEditPreview(
        {
          path: "sample.txt",
          edits: [{ op: "replace", pos: betaRef, lines: ["BBB"] }],
        },
        cwd,
      );

      expect("diff" in preview).toBeTrue();
      if (!("diff" in preview)) {
        return;
      }
      expect(preview.diff).toContain("+2#");
      expect(preview.diff).toContain(":BBB");
    });
  });

  it("returns a diff for fuzzy legacy replacements before execution", async () => {
    await withTempFile("sample.txt", "he said “hi”\n", async ({ cwd }) => {
      const preview = await computeEditPreview(
        {
          path: "sample.txt",
          oldText: 'he said "hi"',
          newText: "HELLO",
        },
        cwd,
      );

      expect("diff" in preview).toBeTrue();
      if (!("diff" in preview)) {
        return;
      }
      expect(preview.diff).toContain("HELLO");
    });
  });

  it("still computes a preview diff for read-only files", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      await chmod(path, 0o444);
      const betaRef = `2#${computeLineHash(2, "bbb")}:bbb`;

      try {
        const preview = await computeEditPreview(
          {
            path: "sample.txt",
            edits: [{ op: "replace", pos: betaRef, lines: ["BBB"] }],
          },
          cwd,
        );

        expect("diff" in preview).toBeTrue();
        if (!("diff" in preview)) {
          return;
        }
        expect(preview.diff).toContain(":BBB");
      } finally {
        await chmod(path, 0o644);
      }
    });
  });
});
