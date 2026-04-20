import { execFile } from "child_process";
import { symlink } from "fs/promises";
import { describe, expect, it } from "bun:test";
import { computeLineHash } from "../../src/hashline";
import { withTempFile } from "../support/fixtures";

type QueueScenarioResult = {
  finalContent: string;
  queueKeys: string[];
};

async function runQueueScenarioInSubprocess(
  cwd: string,
  options?: { useSymlinkPath?: boolean; secondPath?: string },
): Promise<QueueScenarioResult> {
  const editModulePath = new URL("../../src/edit.ts", import.meta.url).href;
  const racePath = `${cwd}/race.ts`;
  const secondPath = options?.secondPath ?? (options?.useSymlinkPath === true ? "linked-race.ts" : "race.ts");
  const readModulePath = new URL("../../src/read.ts", import.meta.url).href;
  const script = `
import { mock } from "bun:test";
import { readFile } from "fs/promises";

const editModulePath = ${JSON.stringify(editModulePath)};
const readModulePath = ${JSON.stringify(readModulePath)};
const cwd = ${JSON.stringify(cwd)};
const secondPath = ${JSON.stringify(secondPath)};
const queueKeys: string[] = [];

mock.module("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: async (path: string, work: () => Promise<unknown>) => {
    queueKeys.push(path);
    return work();
  },
}));

mock.module(readModulePath, () => ({
  formatHashlineReadPreview: (text: string) => ({ text }),
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
  await tool.execute(
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
  await tool.execute(
    "call-2",
    {
      path: secondPath,
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

  console.log(
    JSON.stringify({
      finalContent: await readFile(${JSON.stringify(racePath)}, "utf-8"),
      queueKeys,
    }),
  );
} finally {
  mock.restore();
}
`;

  return new Promise<QueueScenarioResult>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--eval", script],
      { cwd: process.cwd() },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(JSON.parse(stdout) as QueueScenarioResult);
      },
    );
  });
}

describe("edit tool file mutation queue", () => {
  it("uses the same queue key for repeated edits to the same path", async () => {
    await withTempFile("race.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      expect(await runQueueScenarioInSubprocess(cwd)).toEqual({
        finalContent: "ALPHA\nBETA\ngamma\n",
        queueKeys: [path, path],
      });
    });
  });

  it("canonicalizes the queue key when a symlink points at the same file", async () => {
    await withTempFile("race.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      await symlink("race.ts", `${cwd}/linked-race.ts`);

      expect(
        await runQueueScenarioInSubprocess(cwd, { useSymlinkPath: true }),
      ).toEqual({
        finalContent: "ALPHA\nBETA\ngamma\n",
        queueKeys: [path, path],
      });
    });
  });
  it("canonicalizes the queue key when a parent directory is a symlink", async () => {
    await withTempFile("race.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      await symlink(".", `${cwd}/aliasdir`);

      expect(
        await runQueueScenarioInSubprocess(cwd, { secondPath: "aliasdir/race.ts" }),
      ).toEqual({
        finalContent: "ALPHA\nBETA\ngamma\n",
        queueKeys: [path, path],
      });
    });
  });
});
