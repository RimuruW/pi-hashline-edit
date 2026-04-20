import { stat } from "fs/promises";
import { resolveMutationTargetPath } from "./fs-write";

export type SnapshotInfo = {
  snapshotId: string;
  mtimeMs: number;
  size: number;
};

const snapshotCache = new Map<string, SnapshotInfo>();

function formatSnapshotId(canonicalPath: string, info: { mtimeMs: number; size: number }): string {
  return `v1|${canonicalPath}|${info.mtimeMs}|${info.size}`;
}

export async function getFileSnapshot(absolutePath: string): Promise<SnapshotInfo> {
  const canonicalPath = await resolveMutationTargetPath(absolutePath);
  const stats = await stat(canonicalPath);
  const snapshot: SnapshotInfo = {
    snapshotId: formatSnapshotId(canonicalPath, stats),
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
  snapshotCache.set(canonicalPath, snapshot);
  return snapshot;
}

export async function getCachedSnapshot(absolutePath: string): Promise<SnapshotInfo | undefined> {
  const canonicalPath = await resolveMutationTargetPath(absolutePath);
  return snapshotCache.get(canonicalPath);
}
