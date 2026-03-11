import { chmod, stat } from "fs/promises";
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
});
