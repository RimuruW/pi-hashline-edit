import type { EditToolDetails, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { constants } from "fs";
import { readFileSync } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import {
  buildCompactHashlineDiffPreview,
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff";
import {
  applyExactUniqueLegacyReplace,
  extractLegacyTopLevelReplace,
} from "./edit-compat";
import { writeFileAtomically } from "./fs-write";
import {
  applyHashlineEdits,
  resolveEditAnchors,
  type HashlineToolEdit,
} from "./hashline";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";

function StringEnum<T extends string[]>(values: [...T]) {
  return Type.Unsafe<T[number]>({ type: "string", enum: values });
}

const hashlineEditItemSchema = Type.Object(
  {
    op: StringEnum(["replace", "append", "prepend"]),
    pos: Type.Optional(Type.String({ description: "anchor" })),
    end: Type.Optional(Type.String({ description: "limit position" })),
    lines: Type.Union([
      Type.Array(Type.String(), { description: "content (preferred format)" }),
      Type.String(),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const hashlineEditToolSchema = Type.Object(
  {
    path: Type.String({ description: "path" }),
    edits: Type.Array(hashlineEditItemSchema, { description: "edits over $path" }),
  },
  { additionalProperties: false },
);

const hashlineEditSchema = Type.Object(
  {
    path: Type.String(),
    edits: Type.Optional(Type.Array(hashlineEditItemSchema)),
    oldText: Type.Optional(Type.String()),
    newText: Type.Optional(Type.String()),
    old_text: Type.Optional(Type.String()),
    new_text: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

type EditRequestParams = Static<typeof hashlineEditSchema>;

type CompatibilityDetails = {
  used: true;
  strategy: "legacy-top-level-replace";
  matchCount: 1;
};

const EDIT_DESC = readFileSync(
  new URL("../prompts/edit.md", import.meta.url),
  "utf-8",
).trim();

const ROOT_KEYS = new Set(["path", "edits", "oldText", "newText", "old_text", "new_text"]);
const ITEM_KEYS = new Set(["op", "pos", "end", "lines"]);
const LEGACY_KEYS = ["oldText", "newText", "old_text", "new_text"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(request: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(request, key);
}

export function assertEditRequest(request: unknown): asserts request is EditRequestParams {
  if (!isRecord(request)) {
    throw new Error("Edit request must be an object.");
  }

  const unknownRootKeys = Object.keys(request).filter((key) => !ROOT_KEYS.has(key));
  if (unknownRootKeys.length > 0) {
    throw new Error(
      `Edit request contains unknown or unsupported fields: ${unknownRootKeys.join(", ")}.`,
    );
  }

  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('Edit request requires a non-empty "path" string.');
  }

  if (hasOwn(request, "edits") && !Array.isArray(request.edits)) {
    throw new Error('Edit request requires an "edits" array when provided.');
  }

  for (const legacyKey of LEGACY_KEYS) {
    if (hasOwn(request, legacyKey) && typeof request[legacyKey] !== "string") {
      throw new Error(`Edit request field "${legacyKey}" must be a string.`);
    }
  }

  const hasCamelLegacy = hasOwn(request, "oldText") || hasOwn(request, "newText");
  const hasSnakeLegacy = hasOwn(request, "old_text") || hasOwn(request, "new_text");
  if (hasCamelLegacy && hasSnakeLegacy) {
    throw new Error(
      'Edit request cannot mix legacy camelCase and snake_case fields. Use either oldText/newText or old_text/new_text.',
    );
  }

  const hasAnyLegacyKey = hasCamelLegacy || hasSnakeLegacy;
  const hasStructuredEdits = Array.isArray(request.edits) && request.edits.length > 0;
  if (hasAnyLegacyKey && !hasStructuredEdits) {
    const legacy = extractLegacyTopLevelReplace(request);
    if (!legacy) {
      throw new Error(
        'Legacy top-level replace requires both oldText/newText or old_text/new_text.',
      );
    }
  }

  if (!Array.isArray(request.edits)) {
    return;
  }

  for (const [index, edit] of request.edits.entries()) {
    if (!isRecord(edit)) {
      throw new Error(`Edit ${index} must be an object.`);
    }

    const unknownItemKeys = Object.keys(edit).filter((key) => !ITEM_KEYS.has(key));
    if (unknownItemKeys.length > 0) {
      throw new Error(
        `Edit ${index} contains unknown or unsupported fields: ${unknownItemKeys.join(", ")}.`,
      );
    }
  }
}

export function registerEditTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "Edit",
    description: EDIT_DESC,
    parameters: hashlineEditToolSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertEditRequest(params);

      const rawPath = params.path;
      const path = rawPath.replace(/^@/, "");
      const absolutePath = resolveToCwd(path, ctx.cwd);
      const toolEdits = Array.isArray(params.edits)
        ? (params.edits as HashlineToolEdit[])
        : [];
      const legacy = extractLegacyTopLevelReplace(params as Record<string, unknown>);

      if (toolEdits.length === 0 && !legacy) {
        return {
          content: [{ type: "text", text: "No edits provided." }],
          isError: true,
          details: { diff: "", firstChangedLine: undefined } as EditToolDetails,
        };
      }

      throwIfAborted(signal);
      try {
        await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
      } catch {
        throw new Error(`File not found: ${path}`);
      }

      throwIfAborted(signal);
      const raw = (await fsReadFile(absolutePath)).toString("utf-8");
      throwIfAborted(signal);

      const { bom, text: content } = stripBom(raw);
      const originalEnding = detectLineEnding(content);
      const originalNormalized = normalizeToLF(content);

      let result: string;
      let warnings: string[] | undefined;
      let noopEdits:
        | Array<{
            editIndex: number;
            loc: string;
            currentContent: string;
          }>
        | undefined;
      let firstChangedLine: number | undefined;
      let compatibilityDetails: CompatibilityDetails | undefined;

      if (toolEdits.length > 0) {
        const resolved = resolveEditAnchors(toolEdits);
        const anchorResult = applyHashlineEdits(originalNormalized, resolved, signal);
        result = anchorResult.content;
        warnings = anchorResult.warnings;
        noopEdits = anchorResult.noopEdits;
        firstChangedLine = anchorResult.firstChangedLine;
      } else {
        // Normalize legacy payload to LF before replacement so CRLF callers still
        // match normalized file content, and so restoreLineEndings does not produce
        // \r\r\n corruption on inserted multiline text.
        const normalizedOldText = normalizeToLF(legacy!.oldText);
        const normalizedNewText = normalizeToLF(legacy!.newText);
        const replaced = applyExactUniqueLegacyReplace(
          originalNormalized,
          normalizedOldText,
          normalizedNewText,
        );
        result = replaced.content;
        compatibilityDetails = {
          used: true,
          strategy: legacy!.strategy,
          matchCount: replaced.matchCount,
        };
      }

      if (originalNormalized === result) {
        let diagnostic = `No changes made to ${path}. The edits produced identical content.`;
        if (noopEdits?.length) {
          diagnostic +=
            "\n" +
            noopEdits
              .map(
                (edit) =>
                  `Edit ${edit.editIndex}: replacement for ${edit.loc} is identical to current content:\n  ${edit.loc}: ${edit.currentContent}`,
              )
              .join("\n");
        }
        diagnostic +=
          "\nYour content must differ from what the file already contains. Re-read the file to see the current state.";
        throw new Error(diagnostic);
      }

      throwIfAborted(signal);
      await writeFileAtomically(
        absolutePath,
        bom + restoreLineEndings(result, originalEnding),
      );

      const diffResult = generateDiffString(originalNormalized, result);
      const preview = buildCompactHashlineDiffPreview(diffResult.diff);
      const summaryLine = `Changes: +${preview.addedLines} -${preview.removedLines}${preview.preview ? "" : " (no textual diff preview)"}`;
      const previewBlock = preview.preview
        ? `\n\nDiff preview:\n${preview.preview}`
        : "";
      const warningsBlock = warnings?.length
        ? `\n\nWarnings:\n${warnings.join("\n")}`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Updated ${path}\n${summaryLine}${previewBlock}${warningsBlock}`,
          },
        ],
        details: {
          diff: diffResult.diff,
          firstChangedLine: firstChangedLine ?? diffResult.firstChangedLine,
          ...(compatibilityDetails ? { compatibility: compatibilityDetails } : {}),
        } as EditToolDetails,
      };
    },
  });
}
