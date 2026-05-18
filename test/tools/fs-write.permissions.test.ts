import { beforeEach, describe, expect, it, vi } from "vitest";

const writeFileMock = vi.fn(async () => undefined);
const chmodMock = vi.fn(async () => undefined);
const renameMock = vi.fn(async () => undefined);
const mkdirMock = vi.fn(async () => undefined);
const statMock = vi.fn(async () => ({ mode: 0o100600, nlink: 1 }));
const lstatMock = vi.fn(async () => ({ isSymbolicLink: () => false }));
const readlinkMock = vi.fn(async () => "");

vi.mock("fs/promises", () => ({
  chmod: chmodMock,
  lstat: lstatMock,
  mkdir: mkdirMock,
  readlink: readlinkMock,
  rename: renameMock,
  stat: statMock,
  writeFile: writeFileMock,
}));

describe("writeFileAtomically permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statMock.mockResolvedValue({ mode: 0o100600, nlink: 1 });
    lstatMock.mockResolvedValue({ isSymbolicLink: () => false });
  });

  it("creates the temporary replacement file with the target mode immediately", async () => {
    const { writeFileAtomically } = await import("../../src/fs-write");

    await writeFileAtomically("/tmp/secret.txt", "secret\n");

    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/tmp\/.tmp-/),
      "secret\n",
      { encoding: "utf-8", flag: "wx", mode: 0o600 },
    );
    expect(chmodMock).not.toHaveBeenCalled();
  });
});
