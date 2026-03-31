import { realpathSync } from "fs";
import { resolve } from "path";

// Each entry holds the tail of a per-file promise chain.  When an entry's tail
// settles and no newer link has been appended, the entry is deleted.  Under Pi's
// tool-call concurrency (typically a handful of edits per turn) the Map stays
// small and entries are short-lived, so unbounded growth is not a concern.
const fileMutationQueues = new Map<string, Promise<void>>();

function getMutationQueueKey(filePath: string): string {
  const resolvedPath = resolve(filePath);
  try {
    return realpathSync.native(resolvedPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return resolvedPath;
    throw err;
  }
}

export async function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = getMutationQueueKey(filePath);
  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((resolveQueue) => {
    releaseNext = resolveQueue;
  });
  const chainedQueue = currentQueue.then(() => nextQueue);
  fileMutationQueues.set(key, chainedQueue);

  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
