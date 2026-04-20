import { describe, expect, it } from "bun:test";
import { readFile, writeFile } from "fs/promises";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("snapshotId surface (details-only after W2)", () => {
  it("read writes snapshotId to details but not to text", async () => {
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

      expect(getText(result)).not.toContain("snapshotId");
      expect(getText(result)).not.toContain("SnapshotId");
      expect(result.details?.snapshotId).toEqual(expect.any(String));
    });
  });

  it("edit no longer accepts a snapshotId field on the request", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      let errorMessage = "";
      try {
        await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            snapshotId: "v1|fake|0|0",
            edits: [
              {
                op: "replace",
                pos: `2#${computeLineHash(2, "beta")}`,
                lines: ["BETA"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );
      } catch (error: unknown) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("unknown or unsupported fields");
      expect(errorMessage).toContain("snapshotId");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
    });
  });

  it("edit succeeds even when the file changed on disk between read and edit, as long as anchors still match", async () => {
    await withTempFile(
      "sample.txt",
      "one\ntwo\nthree\nfour\nfive\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        // External, unrelated change: line 2 mutated, line 4 still "four".
        await writeFile(path, "one\nTWO!\nthree\nfour\nfive\n", "utf-8");

        const result = await editTool.execute(
          "e1",
          {
            path: "sample.txt",
            edits: [
              {
                op: "replace",
                pos: `4#${computeLineHash(4, "four")}`,
                lines: ["FOUR"],
              },
            ],
          },
          undefined,
          undefined,
          { cwd, hasUI: true, ui: { notify() {} } } as any,
        );

        expect(getText(result)).toContain("Updated sample.txt");
        expect(await readFile(path, "utf-8")).toBe(
          "one\nTWO!\nthree\nFOUR\nfive\n",
        );
      },
    );
  });

  it("edit text response no longer contains a SnapshotId line", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          edits: [
            {
              op: "replace",
              pos: `2#${computeLineHash(2, "beta")}`,
              lines: ["BETA"],
            },
          ],
        },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { notify() {} } } as any,
      );

      expect(getText(result)).not.toContain("SnapshotId");
      // details still expose the post-edit fingerprint for host UIs.
      expect(result.details?.snapshotId).toEqual(expect.any(String));
    });
  });

  it("a stale anchor still triggers [E_STALE_ANCHOR] with refresh hints", async () => {
    await withTempFile(
      "sample.txt",
      "one\ntwo\nthree\n",
      async ({ cwd, path }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        // External change: rewrite the line we are about to target.
        await writeFile(path, "one\nTWO!\nthree\n", "utf-8");

        let errorMessage = "";
        try {
          await editTool.execute(
            "e1",
            {
              path: "sample.txt",
              edits: [
                {
                  op: "replace",
                  pos: `2#${computeLineHash(2, "two")}`,
                  lines: ["TWO"],
                },
              ],
            },
            undefined,
            undefined,
            { cwd, hasUI: true, ui: { notify() {} } } as any,
          );
        } catch (error: unknown) {
          errorMessage = error instanceof Error ? error.message : String(error);
        }

        expect(errorMessage).toMatch(/^\[E_STALE_ANCHOR\]/);
        expect(errorMessage).toContain(
          `>>> 2#${computeLineHash(2, "TWO!")}:TWO!`,
        );
      },
    );
  });
});
