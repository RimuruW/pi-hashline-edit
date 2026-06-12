import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import register from "../../index";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, makeTempDir, makeToolContext } from "../support/fixtures";

/**
 * Permission-error tests rely on chmod(0o000) producing EACCES/EPERM.
 * This is POSIX-specific: on Windows chmod is a no-op (or throws ENOTSUP).
 * Skip the entire suite on Windows; root already skips via the existing check.
 */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const isWindows = process.platform === "win32";

describe.skipIf(isRoot || isWindows)("permission errors", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await makeTempDir("pi-perm-test-");
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("read tool EACCES", () => {
		it("throws 'File is not readable' when file has no permissions", async () => {
			const filePath = join(tempDir, "unreadable.txt");
			writeFileSync(filePath, "secret content", "utf-8");
			chmodSync(filePath, 0o000);

			try {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const readTool = getTool("read");

				await expect(
					readTool.execute(
						"r1",
						{ path: filePath },
						undefined,
						undefined,
						makeToolContext(tempDir),
					),
				).rejects.toThrow("File is not readable");
			} finally {
				chmodSync(filePath, 0o644);
			}
		});
	});

	describe("edit tool EACCES", () => {
		it("throws 'File is not writable' when file has no permissions", async () => {
			const filePath = join(tempDir, "unwritable.txt");
			writeFileSync(filePath, "original content\n", "utf-8");
			chmodSync(filePath, 0o000);

			try {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const editTool = getTool("edit");

				await expect(
					editTool.execute(
						"e1",
						{
							path: filePath,
							// A valid anchor, so this test keeps failing on the access check
							// even if the pipeline ever validates anchors first.
							edits: [
								{
									op: "replace",
									pos: `1#${computeLineHash(1, "original content")}`,
									lines: ["new content"],
								},
							],
						},
						undefined,
						undefined,
						makeToolContext(tempDir),
					),
				).rejects.toThrow("File is not writable");
			} finally {
				chmodSync(filePath, 0o644);
			}
		});
	});
});
