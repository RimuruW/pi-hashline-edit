import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createReadTool,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  stat as fsStat,
} from "fs/promises";
import { constants } from "fs";
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

type ReadPreviewTruncation = {
  truncated: boolean;
  outputLines: number;
  outputBytes: number;
  totalLines: number;
  totalBytes: number;
  reason?: "oversized-first-line";
};

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
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
): { text: string; truncation?: ReadPreviewTruncation } {
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
  const formattedLines = selected.map((line, index) => {
    const lineNumber = startLine + index;
    return `${lineNumber}#${computeLineHash(lineNumber, line)}:${line}`;
  });

  const totalFormatted = formattedLines.join("\n");
  const totalBytes = byteLength(totalFormatted);
  const firstFormattedLine = formattedLines[0];
  if (
    firstFormattedLine !== undefined &&
    byteLength(firstFormattedLine) > DEFAULT_MAX_BYTES
  ) {
    return {
      text: `[Line ${startLine} exceeds ${formatSize(DEFAULT_MAX_BYTES)}. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`,
      truncation: {
        truncated: true,
        outputLines: 0,
        outputBytes: 0,
        totalLines,
        totalBytes,
        reason: "oversized-first-line",
      },
    };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  for (const line of formattedLines) {
    if (outputLines.length >= DEFAULT_MAX_LINES) break;

    const chunk = outputLines.length === 0 ? line : `\n${line}`;
    const chunkBytes = byteLength(chunk);
    if (outputBytes + chunkBytes > DEFAULT_MAX_BYTES) break;

    outputLines.push(line);
    outputBytes += chunkBytes;
  }

  let preview = outputLines.join("\n");
  const truncated = outputLines.length < formattedLines.length;
  if (truncated) {
    preview += `\n\n[Output truncated: showing ${outputLines.length} of ${totalLines} lines (${formatSize(outputBytes)} of ${formatSize(totalBytes)}). Use offset=${startLine + outputLines.length} to continue.]`;
  } else if (endIdx < totalLines) {
    preview += `\n\n[Showing lines ${startLine}-${endIdx} of ${totalLines}. Use offset=${endIdx + 1} to continue.]`;
  }

  return {
    text: preview,
    truncation: truncated
      ? {
          truncated: true,
          outputLines: outputLines.length,
          outputBytes,
          totalLines,
          totalBytes,
        }
      : undefined,
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
      const rawPath = params.path.replace(/^@/, "");
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
      const ext = rawPath.split(".").pop()?.toLowerCase() ?? "";
      if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext)) {
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
