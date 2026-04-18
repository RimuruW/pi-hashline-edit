import { open as fsOpen, stat as fsStat } from "fs/promises";
import { fileTypeFromBuffer } from "file-type";

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

function decodeUtf8Chunk(decoder: TextDecoder, buffer: Uint8Array): boolean {
  try {
    decoder.decode(buffer, { stream: true });
    return true;
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return false;
    }
    throw error;
  }
}

function finishUtf8(decoder: TextDecoder): boolean {
  try {
    decoder.decode();
    return true;
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return false;
    }
    throw error;
  }
}

export async function classifyFileKind(filePath: string): Promise<FileKind> {
  const pathStat = await fsStat(filePath);
  if (pathStat.isDirectory()) {
    return { kind: "directory" };
  }
  if (!pathStat.isFile()) {
    return {
      kind: "binary",
      description: "unsupported file type",
    };
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

    const decoder = new TextDecoder("utf-8", { fatal: true });
    if (!decodeUtf8Chunk(decoder, sample)) {
      return {
        kind: "binary",
        description: "invalid UTF-8",
      };
    }

    let position = bytesRead;
    while (position < pathStat.size) {
      const { bytesRead: chunkBytesRead } = await fileHandle.read(
        buffer,
        0,
        FILE_TYPE_SNIFF_BYTES,
        position,
      );
      if (chunkBytesRead === 0) {
        break;
      }

      const chunk = buffer.subarray(0, chunkBytesRead);
      if (hasNullByte(chunk)) {
        return {
          kind: "binary",
          description: "null bytes detected",
        };
      }
      if (!decodeUtf8Chunk(decoder, chunk)) {
        return {
          kind: "binary",
          description: "invalid UTF-8",
        };
      }
      position += chunkBytesRead;
    }

    if (!finishUtf8(decoder)) {
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
