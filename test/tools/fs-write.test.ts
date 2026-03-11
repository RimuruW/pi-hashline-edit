import { chmod, lstat, readFile, readlink, stat, symlink } from "fs/promises";
import { describe, expect, it } from "bun:test";
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
});
