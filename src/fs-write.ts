import { randomUUID } from "crypto";
import { chmod, mkdir, rename, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";

export async function writeFileAtomically(
  path: string,
  content: string,
): Promise<void> {
  const dir = dirname(path);
  const tempPath = join(dir, `.tmp-${randomUUID()}`);

  await mkdir(dir, { recursive: true });
  await writeFile(tempPath, content, "utf-8");

  try {
    const existingMode = (await stat(path)).mode & 0o7777;
    await chmod(tempPath, existingMode);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await rename(tempPath, path);
}
