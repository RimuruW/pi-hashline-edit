import { randomUUID } from "crypto";
import { chmod, lstat, mkdir, readlink, realpath, rename, stat, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";

async function resolveAtomicWritePath(path: string): Promise<string> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) {
      return path;
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return path;
    }
    throw error;
  }

  try {
    return await realpath(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    return resolve(dirname(path), await readlink(path));
  }
}
export async function writeFileAtomically(
  path: string,
  content: string,
): Promise<void> {
  const targetPath = await resolveAtomicWritePath(path);
  const dir = dirname(targetPath);
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(tempPath, content, "utf-8");
  try {
    const existingMode = (await stat(targetPath)).mode & 0o7777;
    await chmod(tempPath, existingMode);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await rename(tempPath, targetPath);
}
