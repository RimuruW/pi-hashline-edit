import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { classifyFileKind } from "../../src/file-kind";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

async function createTempRoot(): Promise<string> {
  const root = join(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "pi-hashline-kind-"));
}

async function withTempBytes(
  name: string,
  bytes: Uint8Array,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const cwd = await createTempRoot();
  const path = join(cwd, name);
  try {
    await writeFile(path, bytes);
    await run({ cwd, path });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function withTempDirectory(
  name: string,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const cwd = await createTempRoot();
  const path = join(cwd, name);
  try {
    await mkdir(path, { recursive: true });
    await run({ cwd, path });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("classifyFileKind", () => {
  it("classifies directories explicitly", async () => {
    await withTempDirectory("nested", async ({ path }) => {
      await expect(classifyFileKind(path)).resolves.toEqual({ kind: "directory" });
    });
  });

  it("classifies supported images separately from text", async () => {
    const imagePath = join(process.cwd(), "assets", "banner.jpeg");

    await expect(classifyFileKind(imagePath)).resolves.toMatchObject({
      kind: "image",
      mimeType: "image/jpeg",
    });
  });

  it("classifies plain utf-8 text as text", async () => {
    await withTempFile("sample.txt", "alpha\nbeta\n", async ({ path }) => {
      await expect(classifyFileKind(path)).resolves.toEqual({ kind: "text" });
    });
  });

  it("classifies utf-8 text as text when the sniff window ends mid-code-point", async () => {
    const prefix = new Uint8Array(8190).fill(0x61);
    const emDash = new Uint8Array([0xe2, 0x80, 0x94]);
    const suffix = new Uint8Array([0x0a]);
    const bytes = new Uint8Array(prefix.length + emDash.length + suffix.length);
    bytes.set(prefix, 0);
    bytes.set(emDash, prefix.length);
    bytes.set(suffix, prefix.length + emDash.length);

    await withTempBytes("sample.md", bytes, async ({ path }) => {
      await expect(classifyFileKind(path)).resolves.toEqual({ kind: "text" });
    });
  });

  it("classifies files with null bytes as binary", async () => {
    await withTempBytes(
      "sample.bin",
      new Uint8Array([0x61, 0x00, 0x62, 0x63]),
      async ({ path }) => {
        await expect(classifyFileKind(path)).resolves.toEqual({
          kind: "binary",
          description: "null bytes detected",
        });
      },
    );
  });

  it("classifies invalid utf-8 without null bytes as binary", async () => {
    await withTempBytes("sample.bin", new Uint8Array([0xc3, 0x28]), async ({ path }) => {
      await expect(classifyFileKind(path)).resolves.toEqual({
        kind: "binary",
        description: "invalid UTF-8",
      });
    });
  });
});

describe("file kind guards in tools", () => {
  it("read reports directories explicitly", async () => {
    await withTempDirectory("nested", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      await expect(
        readTool.execute(
          "r1",
          { path: "nested" },
          undefined,
          undefined,
          { cwd } as any,
        ),
      ).rejects.toThrow(/Path is a directory: nested/);
    });
  });

  it("read accepts utf-8 text when the sniff window ends mid-code-point", async () => {
    const prefix = new Uint8Array(8190).fill(0x61);
    const emDash = new Uint8Array([0xe2, 0x80, 0x94]);
    const suffix = new Uint8Array([0x0a]);
    const bytes = new Uint8Array(prefix.length + emDash.length + suffix.length);
    bytes.set(prefix, 0);
    bytes.set(emDash, prefix.length);
    bytes.set(suffix, prefix.length + emDash.length);

    await withTempBytes("sample.md", bytes, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");

      const result = await readTool.execute(
        "r1",
        { path: "sample.md" },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(getText(result)).toContain("—");
    });
  });

  it("read rejects binary files with classifier detail", async () => {
    await withTempBytes(
      "sample.bin",
      new Uint8Array([0x61, 0x00, 0x62, 0x63]),
      async ({ cwd }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const readTool = getTool("read");

        await expect(
          readTool.execute(
            "r1",
            { path: "sample.bin" },
            undefined,
            undefined,
            { cwd } as any,
          ),
        ).rejects.toThrow(/Path is a binary file: sample\.bin \(null bytes detected\)/i);
      },
    );
  });

  it("edit rejects binary files before reading them as text", async () => {
    await withTempBytes(
      "sample.bin",
      new Uint8Array([0x61, 0x00, 0x62, 0x63]),
      async ({ cwd }) => {
        const { pi, getTool } = makeFakePiRegistry();
        register(pi);
        const editTool = getTool("edit");

        await expect(
          editTool.execute(
            "e1",
            {
              path: "sample.bin",
              oldText: "a",
              newText: "A",
            },
            undefined,
            undefined,
            { cwd } as any,
          ),
        ).rejects.toThrow(/binary file: sample\.bin/i);
      },
    );
  });
});
