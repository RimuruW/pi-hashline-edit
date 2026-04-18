import { open as fsOpen, stat as fsStat } from "fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { spawn } from "child_process";

const IMAGE_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const FILE_TYPE_SNIFF_BYTES = 8192;

export type FileKind =
  | { kind: "directory" }
  | { kind: "image"; mimeType: string }
  | { kind: "text" }
  | { kind: "binary"; description: string };

function hasNullByte(buffer: Uint8Array): boolean {
  return buffer.includes(0);
}

function isValidUtf8(buffer: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch (_error: unknown) {
    return false;
  }
}

/** Use `file` command to detect if file is text (fallback for strict UTF-8 check). */
function fileCommandDetectsText(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("file", ["--brief", "--mime-type", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data) => { stdout += data.toString(); });
    proc.stderr?.on("data", (data) => { stderr += data.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(false);
        return;
      }
      const mime = stdout.trim();
      // text/* mime types are text, plus a few common ones
      resolve(mime.startsWith("text/") || mime === "application/xml" || mime === "application/json" || mime === "application/javascript");
    });
    proc.on("error", () => {
      resolve(false);
    });
  });
}

export async function classifyFileKind(filePath: string): Promise<FileKind> {
  const pathStat = await fsStat(filePath);
  if (pathStat.isDirectory()) {
    return { kind: "directory" };
  }

  const fileHandle = await fsOpen(filePath, "r");
  try {
    const buffer = Buffer.alloc(FILE_TYPE_SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, FILE_TYPE_SNIFF_BYTES, 0);
    if (bytesRead === 0) {
      return { kind: "text" };
    }

    const sample = buffer.subarray(0, bytesRead);
    const fileType = await fileTypeFromBuffer(sample);
    if (fileType) {
      if (IMAGE_MIME_TYPES.has(fileType.mime)) {
        return { kind: "image", mimeType: fileType.mime };
      }
      return {
        kind: "binary",
        description: fileType.mime,
      };
    }

    if (hasNullByte(sample)) {
      return {
        kind: "binary",
        description: "null bytes detected",
      };
    }

    if (!isValidUtf8(sample)) {
      // Fallback: use `file` command to detect text files
      // This handles edge cases like files with mixed line endings or unusual UTF-8 sequences
      if (await fileCommandDetectsText(filePath)) {
        return { kind: "text" };
      }
      return {
        kind: "binary",
        description: "invalid UTF-8",
      };
    }

    return { kind: "text" };
  } finally {
    await fileHandle.close();
  }
}
