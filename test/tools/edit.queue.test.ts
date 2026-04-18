import { execFile } from "child_process";
import { describe, expect, it } from "bun:test";
import { computeLineHash } from "../../src/hashline";
import { withTempFile } from "../support/fixtures";

async function runQueueScenarioInSubprocess(cwd: string): Promise<string> {
  const fsWriteModulePath = new URL("../../src/fs-write.ts", import.meta.url).href;
  const editModulePath = new URL("../../src/edit.ts", import.meta.url).href;
  const racePath = `${cwd}/race.ts`;
  const script = `
import { mock } from "bun:test";
import { readFile, writeFile } from "fs/promises";

const fsWriteModulePath = ${JSON.stringify(fsWriteModulePath)};
const editModulePath = ${JSON.stringify(editModulePath)};
const cwd = ${JSON.stringify(cwd)};

mock.module(fsWriteModulePath, () => ({
  async writeFileAtomically(path: string, content: string): Promise<void> {
    await Bun.sleep(50);
    await writeFile(path, content, "utf-8");
  },
}));

try {
  const { registerEditTool } = await import(\`${editModulePath}?queue-test=\${Date.now()}\`);
  const tools = new Map<string, any>();
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    on() {},
  };
  registerEditTool(pi as any);
  const tool = tools.get("edit");
  if (!tool) {
    throw new Error("Tool not registered: edit");
  }

  const ctx = { cwd };
  const first = tool.execute(
    "call-1",
    {
      path: "race.ts",
      edits: [
        {
          op: "replace",
          pos: ${JSON.stringify(`1#${computeLineHash(1, "alpha")}`)},
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
          pos: ${JSON.stringify(`2#${computeLineHash(2, "beta")}`)},
          lines: ["BETA"],
        },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  await Promise.all([first, second]);
  console.log(await readFile(${JSON.stringify(racePath)}, "utf-8"));
} finally {
  mock.restore();
}
`;

  return new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--eval", script],
      { cwd: process.cwd() },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

describe("edit tool file mutation queue", () => {
  it("serializes concurrent edits to the same file", async () => {
    await withTempFile("race.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      expect(await runQueueScenarioInSubprocess(cwd)).toBe("ALPHA\nBETA\ngamma\n\n");
    });
  });
});
