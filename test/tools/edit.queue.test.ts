import { describe, expect, it, mock } from "bun:test";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("edit tool file mutation queue", () => {
  it("serializes concurrent edits to the same file", async () => {
    const fsWriteModulePath = new URL("../../src/fs-write.ts", import.meta.url).href;
    const editModulePath = new URL("../../src/edit.ts", import.meta.url).href;
    mock.module(fsWriteModulePath, () => ({
      async writeFileAtomically(path: string, content: string): Promise<void> {
        await Bun.sleep(50);
        await writeFile(path, content, "utf-8");
      },
    }));

    try {
      const { registerEditTool } = await import(
        `${editModulePath}?queue-test=${Date.now()}`
      );
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const tool = getTool("edit");

      await withTempFile("race.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
        const ctx = { cwd };
        const first = tool.execute(
          "call-1",
          {
            path: "race.ts",
            edits: [
              {
                op: "replace",
                pos: `1#${computeLineHash(1, "alpha")}`,
                lines: ["ALPHA"],
              },
            ],
          },
          undefined,
          undefined,
          ctx,
        );
        const second = tool.execute(
          "call-2",
          {
            path: "race.ts",
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
          ctx,
        );

        await Promise.all([first, second]);

        expect(await readFile(join(cwd, "race.ts"), "utf-8")).toBe(
          "ALPHA\nBETA\ngamma\n",
        );
      });
    } finally {
      mock.restore();
    }
  });
});
