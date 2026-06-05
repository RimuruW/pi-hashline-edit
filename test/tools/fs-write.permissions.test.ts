import { beforeEach, describe, expect, it, vi } from "vitest";

const writeFileMock = vi.fn(async () => undefined);
const handleWriteFileMock = vi.fn(async () => undefined);
const handleChmodMock = vi.fn(async () => undefined);
const handleCloseMock = vi.fn(async () => undefined);
const openMock = vi.fn(async () => ({
	writeFile: handleWriteFileMock,
	chmod: handleChmodMock,
	close: handleCloseMock,
}));
const renameMock = vi.fn(async () => undefined);
const mkdirMock = vi.fn(async () => undefined);
const statMock = vi.fn(async () => ({ mode: 0o100600, nlink: 1 }));
const lstatMock = vi.fn(async () => ({ isSymbolicLink: () => false }));
const readlinkMock = vi.fn(async () => "");

vi.mock("fs/promises", () => ({
	lstat: lstatMock,
	open: openMock,
	mkdir: mkdirMock,
	readlink: readlinkMock,
	rename: renameMock,
	stat: statMock,
	writeFile: writeFileMock,
}));

describe("writeFileAtomically permissions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		openMock.mockResolvedValue({
			writeFile: handleWriteFileMock,
			chmod: handleChmodMock,
			close: handleCloseMock,
		});
		statMock.mockResolvedValue({ mode: 0o100600, nlink: 1 });
		lstatMock.mockResolvedValue({ isSymbolicLink: () => false });
	});

	it("creates the temporary file securely, writes content, then restores the target mode", async () => {
		const { writeFileAtomically } = await import("../../src/fs-write");

		await writeFileAtomically("/tmp/secret.txt", "secret\n");

		expect(openMock).toHaveBeenCalledWith(
			expect.stringMatching(/\/tmp\/.tmp-/),
			"wx",
			0o600,
		);
		expect(handleWriteFileMock).toHaveBeenCalledWith("secret\n", "utf-8");
		expect(handleChmodMock).toHaveBeenCalledWith(0o600);
		expect(handleCloseMock).toHaveBeenCalled();
		expect(writeFileMock).not.toHaveBeenCalled();
	});
});
