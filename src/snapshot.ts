import { stat } from "fs/promises";
import { resolveMutationTargetPath } from "./fs-write";

export type SnapshotInfo = {
  snapshotId: string;
  mtimeMs: number;
  size: number;
};

function formatSnapshotId(canonicalPath: string, info: { mtimeMs: number; size: number }): string {
  return `v1|${canonicalPath}|${info.mtimeMs}|${info.size}`;
}

/**
 * Stat the file and return its current snapshot fingerprint.
 *
 * The snapshot is exposed only via `details.snapshotId` for host UIs (e.g.
 * "file changed since last view"). It is no longer used to reject edits or
 * surfaced in tool text — the LLM does not need to track it.
 */
export async function getFileSnapshot(absolutePath: string): Promise<SnapshotInfo> {
  const canonicalPath = await resolveMutationTargetPath(absolutePath);
  const stats = await stat(canonicalPath);
  return {
    snapshotId: formatSnapshotId(canonicalPath, stats),
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}
