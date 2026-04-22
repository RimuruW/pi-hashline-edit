import { execFile } from "child_process";
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

  it("uses the shared text loader for preview instead of classifying then re-reading text", async () => {
    const fileKindModulePath = new URL("../../src/file-kind.ts", import.meta.url).href;
    const editModulePath = new URL("../../src/edit.ts", import.meta.url).href;
    const betaRef = `2#${computeLineHash(2, "bbb")}:bbb`;

    await withTempFile("sample.txt", "ignored\n", async ({ cwd }) => {
      const script = `
import { mock } from "bun:test";

const fileKindModulePath = ${JSON.stringify(fileKindModulePath)};
const editModulePath = ${JSON.stringify(editModulePath)};
const cwd = ${JSON.stringify(cwd)};
const betaRef = ${JSON.stringify(betaRef)};

mock.module(fileKindModulePath, () => ({
  async loadFileKindAndText() {
    return { kind: "text", text: "aaa\\nbbb\\nccc\\n" };
  },
  async classifyFileKind() {
    throw new Error("preview should not call classifyFileKind on text paths");
  },
}));

try {
  const { computeEditPreview: computeSinglePassPreview } = await import(\`${editModulePath}?preview-single-pass=\${Date.now()}\`);
  const preview = await computeSinglePassPreview(
    {
      path: "sample.txt",
      edits: [{ op: "replace", pos: betaRef, lines: ["BBB"] }],
    },
    cwd,
  );
  console.log(JSON.stringify(preview));
} finally {
  mock.restore();
}
`;

      const output = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, ["--eval", script], { cwd: process.cwd() }, (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout);
        });
      });

      const preview = JSON.parse(output) as { diff?: string; error?: string };
      expect(preview.diff).toContain(":BBB");
    });
  });
  it("does not let a delayed preview resurrect after a settled result", async () => {
    const fileKindModulePath = new URL("../../src/file-kind.ts", import.meta.url).href;
    const editModulePath = new URL("../../src/edit.ts", import.meta.url).href;
    const betaRef = `2#${computeLineHash(2, "bbb")}:bbb`;

    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const script = `
import { mock } from "bun:test";

const fileKindModulePath = ${JSON.stringify(fileKindModulePath)};
const editModulePath = ${JSON.stringify(editModulePath)};
const cwd = ${JSON.stringify(cwd)};
const betaRef = ${JSON.stringify(betaRef)};
let loadCount = 0;

mock.module(fileKindModulePath, () => ({
  async loadFileKindAndText() {
    loadCount += 1;
    if (loadCount === 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { kind: "text", text: "aaa\\nbbb\\nccc\\n" };
  },
}));

try {
  const { registerEditTool } = await import(\`${editModulePath}?preview-race=\${Date.now()}\`);
  const tools = new Map<string, any>();
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    on() {},
  };
  registerEditTool(pi as any);
  const tool = tools.get("edit");
  const editArgs = {
    path: "sample.txt",
    edits: [{ op: "replace", pos: betaRef, lines: ["BBB"] }],
  };
  const theme = {
    bold: (text: string) => text,
    fg: (_token: string, text: string) => text,
  };
  const state: Record<string, unknown> = {};

  tool.renderCall(editArgs, theme, {
    argsComplete: true,
    state,
    cwd,
    expanded: false,
    lastComponent: undefined,
    invalidate() {},
  });

  const result = await tool.execute(
    "e1",
    editArgs,
    undefined,
    undefined,
    { cwd },
  );
  tool.renderResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    {
      args: editArgs,
      state,
      isError: false,
      lastComponent: undefined,
      invalidate() {},
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  console.log(JSON.stringify({ preview: state.preview ?? null }));
} finally {
  mock.restore();
}
`;

      const output = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, ["--eval", script], { cwd: process.cwd() }, (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout);
        });
      });

      const summary = JSON.parse(output) as { preview: { diff?: string; error?: string } | null };
      expect(summary.preview).toBeNull();
    });
  });
});
