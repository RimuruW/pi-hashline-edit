import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createReadTool,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "fs";
import {
  access as fsAccess,
  open as fsOpen,
  readFile as fsReadFile,
  stat as fsStat,
} from "fs/promises";
import { constants } from "fs";
import { fileTypeFromBuffer } from "file-type";
import { normalizeToLF, stripBom } from "./edit-diff";
import { computeLineHash } from "./hashline";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";

const READ_DESC = readFileSync(
  new URL("../prompts/read.md", import.meta.url),
  "utf-8",
)
  .replaceAll("{{DEFAULT_MAX_LINES}}", String(DEFAULT_MAX_LINES))
  .replaceAll("{{DEFAULT_MAX_BYTES}}", formatSize(DEFAULT_MAX_BYTES))
  .trim();

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const FILE_TYPE_SNIFF_BYTES = 4100;

async function detectSupportedImageMimeType(filePath: string): Promise<string | null> {
  const fileHandle = await fsOpen(filePath, "r");
  try {
    const buffer = Buffer.alloc(FILE_TYPE_SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, FILE_TYPE_SNIFF_BYTES, 0);
    if (bytesRead === 0) {
      return null;
    }

    const fileType = await fileTypeFromBuffer(buffer.subarray(0, bytesRead));
    if (!fileType || !IMAGE_MIME_TYPES.has(fileType.mime)) {
      return null;
    }

    return fileType.mime;
  } finally {
    await fileHandle.close();
  }
}

function normalizePositiveInteger(
  value: number | undefined,
  name: "offset" | "limit",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Read request field "${name}" must be a positive integer.`);
  }

  return value;
}

export function formatHashlineReadPreview(
  text: string,
  options: { offset?: number; limit?: number },
): { text: string; truncation?: TruncationResult } {
  const allLines = text.split("\n");
  const totalLines = allLines.length;
  const startLine = normalizePositiveInteger(options.offset, "offset") ?? 1;
  if (startLine > totalLines) {
    const suggestion =
      totalLines === 0
        ? "The file is empty."
        : `Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`;
    return {
      text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). ${suggestion}`,
    };
  }

  const limit = normalizePositiveInteger(options.limit, "limit");
  const endIdx = limit
    ? Math.min(startLine - 1 + limit, totalLines)
    : totalLines;
  const selected = allLines.slice(startLine - 1, endIdx);
  const formatted = selected
    .map((line, index) => {
      const lineNumber = startLine + index;
      return `${lineNumber}#${computeLineHash(lineNumber, line)}:${line}`;
    })
    .join("\n");

  const truncation = truncateHead(formatted);
  if (truncation.firstLineExceedsLimit) {
    return {
      text: `[Line ${startLine} exceeds ${formatSize(truncation.maxBytes)}. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`,
      truncation,
    };
  }

  let preview = truncation.content;
  if (truncation.truncated) {
    const endLineDisplay = startLine + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    if (truncation.truncatedBy === "lines") {
      preview += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      preview += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines} (${formatSize(truncation.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
    }
  } else if (endIdx < totalLines) {
    preview += `\n\n[Showing lines ${startLine}-${endIdx} of ${totalLines}. Use offset=${endIdx + 1} to continue.]`;
  }

  return {
    text: preview,
    truncation: truncation.truncated ? truncation : undefined,
  };
}

export function registerReadTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "Read",
    description: READ_DESC,
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the file to read (relative or absolute)",
      }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Line number to start reading from (1-indexed)",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Maximum number of lines to read",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const rawPath = params.path;
      const absolutePath = resolveToCwd(rawPath, ctx.cwd);

      throwIfAborted(signal);
      try {
        await fsAccess(absolutePath, constants.R_OK);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `File not found or not readable: ${rawPath}`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      throwIfAborted(signal);
      const pathStat = await fsStat(absolutePath);
      if (pathStat.isDirectory()) {
        return {
          content: [
            {
              type: "text",
              text: `Path is a directory: ${rawPath}. Use ls to inspect directories.`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      throwIfAborted(signal);
      const mimeType = await detectSupportedImageMimeType(absolutePath);
      if (mimeType) {
        const builtinRead = createReadTool(ctx.cwd);
        return builtinRead.execute(_toolCallId, params, signal, _onUpdate);
      }

      throwIfAborted(signal);
      const raw = (await fsReadFile(absolutePath)).toString("utf-8");
      throwIfAborted(signal);

      const normalized = normalizeToLF(stripBom(raw).text);
      const preview = formatHashlineReadPreview(normalized, {
        offset: params.offset,
        limit: params.limit,
      });

      return {
        content: [{ type: "text", text: preview.text }],
        details: { truncation: preview.truncation },
      };
    },
  });
}
