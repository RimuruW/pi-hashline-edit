import { randomUUID } from "crypto";
import { chmod, lstat, mkdir, readlink, rename, stat, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";

async function resolveAtomicWritePath(path: string): Promise<string> {
  let currentPath = path;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(currentPath)) {
      const error: any = new Error(`Too many symbolic links while resolving ${path}`);
      error.code = "ELOOP";
      throw error;
    }
    visited.add(currentPath);

    try {
      if (!(await lstat(currentPath)).isSymbolicLink()) {
        return currentPath;
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return currentPath;
      }
      throw error;
    }

    currentPath = resolve(dirname(currentPath), await readlink(currentPath));
  }
}

export async function writeFileAtomically(
  path: string,
  content: string,
): Promise<void> {
  const targetPath = await resolveAtomicWritePath(path);

  let existingStats: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    existingStats = await stat(targetPath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (existingStats && existingStats.nlink > 1) {
    await writeFile(targetPath, content, "utf-8");
    return;
  }

  const dir = dirname(targetPath);
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(tempPath, content, "utf-8");

  if (existingStats) {
    await chmod(tempPath, existingStats.mode & 0o7777);
  }

  await rename(tempPath, targetPath);
}
