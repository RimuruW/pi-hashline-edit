import {
	chmod,
	link,
	lstat,
	readFile,
	readlink,
	stat,
	symlink,
} from "fs/promises";
import { describe, expect, it } from "vitest";
import { join } from "path";
import { withTempFile } from "../support/fixtures";
import { writeFileAtomically } from "../../src/fs-write";

describe("writeFileAtomically", () => {
	it("creates new files with owner-only permissions", async () => {
		await withTempFile("seed.txt", "seed\n", async ({ cwd }) => {
			const path = join(cwd, "created.txt");

			await writeFileAtomically(path, "secret\n");

			const fileStats = await stat(path);
			expect(fileStats.mode & 0o777).toBe(0o600);
		});
	});

	it("preserves the target file mode when replacing an existing file", async () => {
		await withTempFile("script.sh", "echo before\n", async ({ path }) => {
			await chmod(path, 0o755);

			await writeFileAtomically(path, "echo after\n");

			const fileStats = await stat(path);
			expect(fileStats.mode & 0o777).toBe(0o755);
		});
	});

	it("preserves the target file mode under a restrictive umask", async () => {
		await withTempFile("public.txt", "before\n", async ({ path }) => {
			await chmod(path, 0o644);
			const previousUmask = process.umask(0o077);
			try {
				await writeFileAtomically(path, "after\n");
			} finally {
				process.umask(previousUmask);
			}

			const fileStats = await stat(path);
			expect(fileStats.mode & 0o777).toBe(0o644);
		});
	});

	it("updates a symlink target without replacing the symlink", async () => {
		await withTempFile(
			"target.txt",
			"before\n",
			async ({ cwd, path: targetPath }) => {
				const linkPath = `${cwd}/linked.txt`;
				await symlink("target.txt", linkPath);

				await writeFileAtomically(linkPath, "after\n");

				expect(await readFile(targetPath, "utf-8")).toBe("after\n");
				expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
				expect(await readlink(linkPath)).toBe("target.txt");
			},
		);
	});

	it("follows a dangling symlink chain through to the missing terminal target", async () => {
		await withTempFile("seed.txt", "seed\n", async ({ cwd }) => {
			const intermediateLinkPath = join(cwd, "level-2.txt");
			const topLinkPath = join(cwd, "level-1.txt");
			const missingTargetPath = join(cwd, "missing.txt");

			await symlink("missing.txt", intermediateLinkPath);
			await symlink("level-2.txt", topLinkPath);

			await writeFileAtomically(topLinkPath, "after\n");

			expect((await lstat(topLinkPath)).isSymbolicLink()).toBe(true);
			expect(await readlink(topLinkPath)).toBe("level-2.txt");
			expect((await lstat(intermediateLinkPath)).isSymbolicLink()).toBe(true);
			expect(await readlink(intermediateLinkPath)).toBe("missing.txt");
			expect(await readFile(missingTargetPath, "utf-8")).toBe("after\n");
		});
	});

	it("preserves hard links by updating the existing inode in place", async () => {
		await withTempFile(
			"primary.txt",
			"before\n",
			async ({ cwd, path: primaryPath }) => {
				const siblingPath = join(cwd, "sibling.txt");
				await link(primaryPath, siblingPath);
				const originalInode = (await stat(primaryPath)).ino;

				await writeFileAtomically(primaryPath, "after\n");

				expect(await readFile(primaryPath, "utf-8")).toBe("after\n");
				expect(await readFile(siblingPath, "utf-8")).toBe("after\n");
				expect((await stat(primaryPath)).ino).toBe(originalInode);
				expect((await stat(siblingPath)).ino).toBe(originalInode);
			},
		);
	});
});
