import { existsSync } from "fs";
import {
  mkdir as fsMkdir,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "fs/promises";
import { dirname } from "path";

export interface ValidateFileOperationRequestParams {
  deleteFile?: boolean;
  move?: string;
  hasEdits: boolean;
  hasTextReplace: boolean;
}

export function validateFileOperationRequest({
  deleteFile,
  move,
  hasEdits,
  hasTextReplace,
}: ValidateFileOperationRequestParams): void {
  if (deleteFile && (move || hasEdits || hasTextReplace)) {
    throw new Error(
      "Conflicting file-level operations: 'delete' cannot be combined with 'move', 'edits', or 'text_replace'. Use separate calls.",
    );
  }
}

export interface EnsureMoveDestinationAvailableParams {
  absolutePath: string;
  resolvedMove?: string;
  move?: string;
}

export function ensureMoveDestinationAvailable({
  absolutePath,
  resolvedMove,
  move,
}: EnsureMoveDestinationAvailableParams): void {
  if (
    resolvedMove &&
    resolvedMove !== absolutePath &&
    existsSync(resolvedMove)
  ) {
    throw new Error(
      `Move destination already exists: ${move}. Remove the target first or choose a different path.`,
    );
  }
}

export async function deleteFileIfExists(
  absolutePath: string,
): Promise<boolean> {
  if (!existsSync(absolutePath)) return false;
  await fsUnlink(absolutePath);
  return true;
}

export interface WriteEditResultParams {
  absolutePath: string;
  resolvedMove?: string;
  content: string;
  encoding: BufferEncoding;
}

export async function writeEditResult({
  absolutePath,
  resolvedMove,
  content,
  encoding,
}: WriteEditResultParams): Promise<{ writePath: string; moved: boolean }> {
  const writePath = resolvedMove ?? absolutePath;
  const moved = !!resolvedMove && resolvedMove !== absolutePath;
  if (moved) {
    await fsMkdir(dirname(writePath), { recursive: true });
  }
  await fsWriteFile(writePath, content, encoding);
  if (moved) {
    await fsUnlink(absolutePath);
  }
  return { writePath, moved };
}
