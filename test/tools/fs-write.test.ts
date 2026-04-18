import { chmod, link, lstat, readFile, readlink, stat, symlink } from "fs/promises";
import { describe, expect, it } from "bun:test";
import { join } from "path";
import { writeFileAtomically } from "../../src/fs-write";
import { withTempFile } from "../support/fixtures";

describe("writeFileAtomically", () => {
  it("preserves the target file mode when replacing an existing file", async () => {
    await withTempFile("script.sh", "echo before\n", async ({ path }) => {
      await chmod(path, 0o755);

      await writeFileAtomically(path, "echo after\n");

      const fileStats = await stat(path);
      expect(fileStats.mode & 0o777).toBe(0o755);
    });
  });

  it("updates a symlink target without replacing the symlink", async () => {
    await withTempFile("target.txt", "before\n", async ({ cwd, path: targetPath }) => {
      const linkPath = `${cwd}/linked.txt`;
      await symlink("target.txt", linkPath);

      await writeFileAtomically(linkPath, "after\n");

      expect(await readFile(targetPath, "utf-8")).toBe("after\n");
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(linkPath)).toBe("target.txt");
    });
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

  it("replaces only the addressed hard-link path via atomic rename", async () => {
    await withTempFile("primary.txt", "before\n", async ({ cwd, path: primaryPath }) => {
      const siblingPath = join(cwd, "sibling.txt");
      await link(primaryPath, siblingPath);

      await writeFileAtomically(primaryPath, "after\n");

      expect(await readFile(primaryPath, "utf-8")).toBe("after\n");
      expect(await readFile(siblingPath, "utf-8")).toBe("before\n");
      expect((await stat(primaryPath)).ino).not.toBe((await stat(siblingPath)).ino);
    });
  });
});
