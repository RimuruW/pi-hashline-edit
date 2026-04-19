import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { readFileSync } from "fs";
import { access as fsAccess } from "fs/promises";
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
  computeAffectedLineRange,
  computeLegacyEditLineRange,
  formatHashlineRegion,
  resolveEditAnchors,
  type HashlineToolEdit,
} from "./hashline";
import { loadFileKindAndText } from "./file-kind";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { getCachedSnapshot, getFileSnapshot } from "./snapshot";

const hashlineEditLinesSchema = Type.Union([
  Type.Array(Type.String(), { description: "content (preferred format)" }),
  Type.String(),
  Type.Null(),
]);

const hashlineEditItemSchema = Type.Object(
  {
    op: StringEnum(["replace", "append", "prepend", "replace_text"] as const, {
      description: 'edit operation: "replace", "append", "prepend", or "replace_text"',
    }),
    pos: Type.Optional(Type.String({ description: "anchor" })),
    end: Type.Optional(Type.String({ description: "limit position" })),
    lines: Type.Optional(hashlineEditLinesSchema),
    oldText: Type.Optional(Type.String({ description: "exact text to replace" })),
    newText: Type.Optional(Type.String({ description: "replacement text" })),
  },
  { additionalProperties: false },
);

export const hashlineEditToolSchema = Type.Object(
  {
    path: Type.String({ description: "path" }),
    snapshotId: Type.Optional(Type.String({ description: "snapshot fingerprint from read" })),
    edits: Type.Optional(
      Type.Array(hashlineEditItemSchema, { description: "edits over $path" }),
    ),
  },
  { additionalProperties: false },
);

type EditRequestParams = {
  path: string;
  snapshotId?: string;
  edits?: HashlineToolEdit[];
  oldText?: string;
  newText?: string;
  old_text?: string;
  new_text?: string;
};

type CompatibilityDetails = {
  used: true;
  strategy: "legacy-top-level-replace";
  matchCount: 1;
  fuzzyMatch?: true;
};

type HashlineEditToolDetails = {
  diff: string;
  firstChangedLine?: number;
  compatibility?: CompatibilityDetails;
  snapshotId?: string;
  classification?: "noop";
};

const EDIT_DESC = readFileSync(
  new URL("../prompts/edit.md", import.meta.url),
  "utf-8",
).trim();

const EDIT_PROMPT_SNIPPET = readFileSync(
  new URL("../prompts/edit-snippet.md", import.meta.url),
  "utf-8",
).trim();

const ROOT_KEYS = new Set([
  "path",
  "snapshotId",
  "edits",
  "oldText",
  "newText",
  "old_text",
  "new_text",
]);
const ITEM_KEYS = new Set(["op", "pos", "end", "lines", "oldText", "newText"]);
const LEGACY_KEYS = ["oldText", "newText", "old_text", "new_text"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(request: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(request, key);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function assertSnapshotIdMatches(
  absolutePath: string,
  rawPath: string,
  expectedSnapshotId: string | undefined,
): Promise<string> {
  const cached = getCachedSnapshot(absolutePath);
  const snapshot = cached && cached.snapshotId === expectedSnapshotId
    ? cached
    : await getFileSnapshot(absolutePath);

  if (expectedSnapshotId !== undefined && snapshot.snapshotId !== expectedSnapshotId) {
    throw new Error(
      `Stale snapshotId for ${rawPath}. Re-run read and retry with the latest snapshotId. Current snapshotId: ${snapshot.snapshotId}`,
    );
  }

  return snapshot.snapshotId;
}

function withHiddenStringProperty(
  target: Record<string, unknown>,
  key: typeof LEGACY_KEYS[number],
  value: string,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * Normalise raw tool-call arguments before validation and execution.
 *
 * In newer pi runtimes this is registered as `prepareArguments` so it runs
 * before schema validation, letting old-session payloads with top-level
 * `oldText/newText` continue to work without exposing those fields in the
 * public tool schema.
 *
 * The legacy fields are stored as non-enumerable properties so they pass
 * through `Object.keys()` and `JSON.stringify()` silently while still being
 * accessible to `assertEditRequest` and `extractLegacyTopLevelReplace`.
 */
export function prepareEditArguments(args: unknown): unknown {
  if (!isRecord(args)) {
    return args;
  }

  const hasAnyLegacyKey = LEGACY_KEYS.some((key) => hasOwn(args, key));
  if (!hasAnyLegacyKey) {
    return args;
  }

  const prepared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!LEGACY_KEYS.includes(key as typeof LEGACY_KEYS[number])) {
      prepared[key] = value;
    }
  }

  for (const legacyKey of LEGACY_KEYS) {
    if (!hasOwn(args, legacyKey)) continue;
    const value = args[legacyKey];
    if (typeof value === "string") {
      withHiddenStringProperty(prepared, legacyKey, value);
    } else {
      // Preserve non-string legacy values as non-enumerable so
      // assertEditRequest can reject them with a clear type error
      // instead of silently dropping them.
      Object.defineProperty(prepared, legacyKey, {
        value,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }

  return prepared;
}

// Intentional overlap with the published TypeBox schema:
// - pi normally runs AJV validation before execute(), but that can be disabled in
//   environments without runtime code generation support.
// - some request rules here are cross-field semantics the top-level object schema does
//   not express cleanly, such as rejecting mixed camelCase/snake_case legacy keys.
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

  if (hasOwn(request, "snapshotId") && typeof request.snapshotId !== "string") {
    throw new Error('Edit request field "snapshotId" must be a string when provided.');
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

    if (typeof edit.op !== "string") {
      throw new Error(`Edit ${index} requires an "op" string.`);
    }
    if (
      edit.op !== "replace" &&
      edit.op !== "append" &&
      edit.op !== "prepend" &&
      edit.op !== "replace_text"
    ) {
      throw new Error(
        `Edit ${index} uses unknown op "${edit.op}". Expected "replace", "append", "prepend", or "replace_text".`,
      );
    }

    if (hasOwn(edit, "pos") && typeof edit.pos !== "string") {
      throw new Error(`Edit ${index} field "pos" must be a string when provided.`);
    }
    if (hasOwn(edit, "end") && typeof edit.end !== "string") {
      throw new Error(`Edit ${index} field "end" must be a string when provided.`);
    }
    if (hasOwn(edit, "oldText") && typeof edit.oldText !== "string") {
      throw new Error(`Edit ${index} field "oldText" must be a string when provided.`);
    }
    if (hasOwn(edit, "newText") && typeof edit.newText !== "string") {
      throw new Error(`Edit ${index} field "newText" must be a string when provided.`);
    }
    if (
      hasOwn(edit, "lines") &&
      edit.lines !== null &&
      typeof edit.lines !== "string" &&
      !isStringArray(edit.lines)
    ) {
      throw new Error(
        `Edit ${index} field "lines" must be a string array, string, or null.`,
      );
    }

    if (edit.op === "replace_text") {
      if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
        throw new Error(
          `Edit ${index} with op "replace_text" requires string "oldText" and "newText" fields.`,
        );
      }
      if (hasOwn(edit, "pos") || hasOwn(edit, "end") || hasOwn(edit, "lines")) {
        throw new Error(
          `Edit ${index} with op "replace_text" only supports "oldText" and "newText".`,
        );
      }
      continue;
    }

    if (!hasOwn(edit, "lines")) {
      throw new Error(`Edit ${index} requires a "lines" field.`);
    }

    if (hasOwn(edit, "oldText") || hasOwn(edit, "newText")) {
      throw new Error(
        `Edit ${index} with op "${edit.op}" does not support "oldText" or "newText".`,
      );
    }

    if (edit.op === "replace" && typeof edit.pos !== "string") {
      throw new Error(`Edit ${index} with op "replace" requires a "pos" anchor string.`);
    }

    if ((edit.op === "append" || edit.op === "prepend") && hasOwn(edit, "end")) {
      throw new Error(
        `Edit ${index} with op "${edit.op}" does not support "end". Use "pos" or omit it for file boundary insertion.`,
      );
    }
  }

}

type EditPreview = { diff: string } | { error: string };
type EditRenderState = {
  argsKey?: string;
  preview?: EditPreview;
};

function getRenderablePreviewInput(args: unknown): EditRequestParams | null {
  if (!isRecord(args) || typeof args.path !== "string") {
    return null;
  }

  const request: EditRequestParams = { path: args.path };
  if (typeof args.snapshotId === "string") {
    request.snapshotId = args.snapshotId;
  }
  if (Array.isArray(args.edits)) {
    request.edits = args.edits as HashlineToolEdit[];
  }
  if (typeof args.oldText === "string") {
    request.oldText = args.oldText;
  }
  if (typeof args.newText === "string") {
    request.newText = args.newText;
  }
  if (typeof args.old_text === "string") {
    request.old_text = args.old_text;
  }
  if (typeof args.new_text === "string") {
    request.new_text = args.new_text;
  }

  const hasAnyEditPayload =
    request.edits !== undefined ||
    request.oldText !== undefined ||
    request.newText !== undefined ||
    request.old_text !== undefined ||
    request.new_text !== undefined;
  return hasAnyEditPayload ? request : null;
}

function formatPreviewDiff(
  diff: string,
  expanded: boolean,
  theme: { fg: (token: string, text: string) => string },
): string {
  const lines = diff.split("\n");
  const maxLines = expanded ? 40 : 16;
  const shown = lines.slice(0, maxLines).map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return theme.fg("success", line);
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return theme.fg("error", line);
    }
    return theme.fg("dim", line);
  });

  if (lines.length > maxLines) {
    shown.push(theme.fg("muted", `... ${lines.length - maxLines} more diff lines`));
  }
  return shown.join("\n");
}

function formatRenderedEditResult(
  result: { content?: Array<{ type: string; text?: string }> },
  options: { expanded: boolean; isError: boolean },
  theme: { fg: (token: string, text: string) => string },
): string | undefined {
  const textContent = result.content?.find(
    (entry): entry is { type: "text"; text: string } =>
      entry.type === "text" && typeof entry.text === "string",
  );
  if (!textContent) {
    return undefined;
  }

  if (options.isError) {
    return `\n${theme.fg("error", textContent.text)}`;
  }

  const lines = textContent.text.split("\n");
  const maxLines = options.expanded ? 60 : 20;
  const shown = lines.slice(0, maxLines).map((line) => {
    if (line.length === 0) {
      return line;
    }
    if (line.startsWith("Updated ")) {
      return theme.fg("success", line);
    }
    if (line === "Warnings:") {
      return theme.fg("warning", line);
    }
    if (line === "Diff preview:" || line.startsWith("Changes: ")) {
      return theme.fg("muted", line);
    }
    if (line.startsWith("--- Updated anchors")) {
      return theme.fg("accent", line);
    }
    if (line.startsWith("+")) {
      return theme.fg("success", line);
    }
    if (line.startsWith("-")) {
      return theme.fg("error", line);
    }
    if (line.startsWith("... ")) {
      return theme.fg("muted", line);
    }
    if (/^\d+#/.test(line)) {
      return theme.fg("toolOutput", line);
    }
    return theme.fg("dim", line);
  });

  if (lines.length > maxLines) {
    shown.push(theme.fg("muted", `... ${lines.length - maxLines} more result lines`));
  }

  return `\n${shown.join("\n")}`;
}

function formatEditCall(
  args: EditRequestParams | undefined,
  state: EditRenderState,
  expanded: boolean,
  theme: {
    bold: (text: string) => string;
    fg: (token: string, text: string) => string;
  },
): string {
  const path = args?.path;
  const pathDisplay =
    typeof path === "string" && path.length > 0
      ? theme.fg("accent", path)
      : theme.fg("toolOutput", "...");
  let text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

  if (!state.preview) {
    return text;
  }

  if ("error" in state.preview) {
    text += `\n\n${theme.fg("error", state.preview.error)}`;
    return text;
  }

  if (state.preview.diff) {
    text += `\n\n${formatPreviewDiff(state.preview.diff, expanded, theme)}`;
  }
  return text;
}

export async function computeEditPreview(
  request: unknown,
  cwd: string,
): Promise<EditPreview> {
  const preparedRequest = prepareEditArguments(request);
  try {
    assertEditRequest(preparedRequest);
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const params = preparedRequest as EditRequestParams;
  const path = params.path;
  const absolutePath = resolveToCwd(path, cwd);
  const toolEdits = Array.isArray(params.edits) ? params.edits : [];
  const legacy = extractLegacyTopLevelReplace(params as Record<string, unknown>);

  if (toolEdits.length === 0 && !legacy) {
    return { error: "No edits provided." };
  }

  try {
    await fsAccess(absolutePath, constants.R_OK);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { error: `File not found: ${path}` };
    }
    if (code === "EACCES" || code === "EPERM") {
      return { error: `File is not readable: ${path}` };
    }
    return { error: `Cannot access file: ${path}` };
  }

  try {
    const file = await loadFileKindAndText(absolutePath);
    if (file.kind === "directory") {
      return { error: `Path is a directory: ${path}. Use ls to inspect directories.` };
    }
    if (file.kind === "image") {
      return {
        error: `Path is an image file: ${path}. Hashline edit only supports UTF-8 text files.`,
      };
    }
    if (file.kind === "binary") {
      return {
        error: `Path is a binary file: ${path} (${file.description}). Hashline edit only supports UTF-8 text files.`,
      };
    }

    await assertSnapshotIdMatches(absolutePath, path, params.snapshotId);

    const originalNormalized = normalizeToLF(stripBom(file.text).text);

    let result: string;
    if (toolEdits.length > 0) {
      const resolved = resolveEditAnchors(toolEdits);
      result = applyHashlineEdits(originalNormalized, resolved).content;
    } else {
      result = applyExactUniqueLegacyReplace(
        originalNormalized,
        normalizeToLF(legacy!.oldText),
        normalizeToLF(legacy!.newText),
      ).content;
    }

    if (originalNormalized === result) {
      return {
        error: `No changes made to ${path}. The edits produced identical content.`,
      };
    }

    return { diff: generateDiffString(originalNormalized, result).diff };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerEditTool(pi: ExtensionAPI): void {
  const toolDefinition: ToolDefinition<
    typeof hashlineEditToolSchema,
    HashlineEditToolDetails,
    EditRenderState
  > = {
    name: "edit",
    label: "Edit",
    description: EDIT_DESC,
    parameters: hashlineEditToolSchema,
    prepareArguments: prepareEditArguments,
    promptSnippet: EDIT_PROMPT_SNIPPET,
    renderCall(args, theme, context) {
      const previewInput = getRenderablePreviewInput(args);
      if (!context.argsComplete || !previewInput) {
        context.state.argsKey = undefined;
        context.state.preview = undefined;
      } else {
        const argsKey = JSON.stringify(previewInput);
        if (context.state.argsKey !== argsKey) {
          context.state.argsKey = argsKey;
          context.state.preview = undefined;
          computeEditPreview(previewInput, context.cwd)
            .then((preview) => {
              if (context.state.argsKey === argsKey) {
                context.state.preview = preview;
                context.invalidate();
              }
            })
            .catch((err: unknown) => {
              if (context.state.argsKey === argsKey) {
                context.state.preview = {
                  error: err instanceof Error ? err.message : String(err),
                };
                context.invalidate();
              }
            });
        }
      }
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        formatEditCall(
          getRenderablePreviewInput(args) ?? undefined,
          context.state as EditRenderState,
          context.expanded,
          theme,
        ),
      );
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Editing..."));
        return text;
      }

      text.setText(
        formatRenderedEditResult(
          result as { content?: Array<{ type: string; text?: string }> },
          { expanded, isError: Boolean(context.isError) },
          theme,
        ) ?? "",
      );
      return text;
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertEditRequest(params);

      const normalizedParams = params as EditRequestParams;
      const path = normalizedParams.path;
      const absolutePath = resolveToCwd(path, ctx.cwd);
      const toolEdits = Array.isArray(normalizedParams.edits)
        ? (normalizedParams.edits as HashlineToolEdit[])
        : [];
      const legacy = extractLegacyTopLevelReplace(
        normalizedParams as Record<string, unknown>,
      );

      if (toolEdits.length === 0 && !legacy) {
        return {
          content: [{ type: "text", text: "No edits provided." }],
          isError: true,
          details: { diff: "", firstChangedLine: undefined },
        };
      }

      return withFileMutationQueue(absolutePath, async () => {
        throwIfAborted(signal);
        try {
          await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
        } catch (error: unknown) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            throw new Error(`File not found: ${path}`);
          }
          if (code === "EACCES" || code === "EPERM") {
            throw new Error(`File is not writable: ${path}`);
          }
          throw new Error(`Cannot access file: ${path}`);
        }

        throwIfAborted(signal);
        const file = await loadFileKindAndText(absolutePath);
        if (file.kind === "directory") {
          throw new Error(`Path is a directory: ${path}. Use ls to inspect directories.`);
        }
        if (file.kind === "image") {
          throw new Error(
            `Path is an image file: ${path}. Hashline edit only supports UTF-8 text files.`,
          );
        }
        if (file.kind === "binary") {
          throw new Error(
            `Path is a binary file: ${path} (${file.description}). Hashline edit only supports UTF-8 text files.`,
          );
        }

        const snapshotId = await assertSnapshotIdMatches(
          absolutePath,
          path,
          normalizedParams.snapshotId,
        );

        throwIfAborted(signal);
        const { bom, text: content } = stripBom(file.text);
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
        let lastChangedLine: number | undefined;
        let compatibilityDetails: CompatibilityDetails | undefined;

        if (toolEdits.length > 0) {
          const resolved = resolveEditAnchors(toolEdits);
          const anchorResult = applyHashlineEdits(originalNormalized, resolved, signal);
          result = anchorResult.content;
          warnings = anchorResult.warnings;
          noopEdits = anchorResult.noopEdits;
          firstChangedLine = anchorResult.firstChangedLine;
          lastChangedLine = anchorResult.lastChangedLine;
        } else {
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
            ...(replaced.usedFuzzyMatch ? { fuzzyMatch: true } : {}),
          };
          const legacyRange = computeLegacyEditLineRange(
            originalNormalized,
            result,
          );
          firstChangedLine = legacyRange?.firstChangedLine;
          lastChangedLine = legacyRange?.lastChangedLine;
        }

        if (originalNormalized === result) {
          const noopDetails = noopEdits?.length
            ? noopEdits
                .map(
                  (edit) =>
                    `Edit ${edit.editIndex}: replacement for ${edit.loc} is identical to current content:\n  ${edit.loc}: ${edit.currentContent}`,
                )
                .join("\n")
            : "The edits produced identical content.";
          return {
            content: [
              {
                type: "text",
                text: `No changes made to ${path}\nClassification: noop\n${noopDetails}` ,
              },
            ],
            details: {
              diff: "",
              firstChangedLine: undefined,
              snapshotId,
              classification: "noop" as const,
            },
          };
        }

        throwIfAborted(signal);
        await writeFileAtomically(
          absolutePath,
          bom + restoreLineEndings(result, originalEnding),
        );
        const updatedSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;

        const diffResult = generateDiffString(originalNormalized, result);
        const preview = buildCompactHashlineDiffPreview(diffResult.diff);
        const summaryLine = `Changes: +${preview.addedLines} -${preview.removedLines}${preview.preview ? "" : " (no textual diff preview)"}`;
        const snapshotLine = `SnapshotId: ${updatedSnapshotId}`;
        const previewBlock = preview.preview
          ? `\n\nDiff preview:\n${preview.preview}`
          : "";
        const warningsBlock = warnings?.length
          ? `\n\nWarnings:\n${warnings.join("\n")}`
          : "";

        const resultLines = result.length === 0
          ? []
          : result.endsWith("\n")
            ? result.split("\n").slice(0, -1)
            : result.split("\n");
        const anchorRange = computeAffectedLineRange({
          firstChangedLine,
          lastChangedLine,
          resultLineCount: resultLines.length,
        });
        const anchorsBlock = anchorRange
          ? (() => {
              const region = resultLines.slice(anchorRange.start - 1, anchorRange.end);
              const formatted = formatHashlineRegion(region, anchorRange.start);
              return `\n\n--- Updated anchors (lines ${anchorRange.start}-${anchorRange.end}; use these for subsequent edits in this region, or read for distant edits) ---\n${formatted}`;
            })()
          : "";

        return {
          content: [
            {
              type: "text",
              text: `Updated ${path}\n${summaryLine}\n${snapshotLine}${previewBlock}${warningsBlock}${anchorsBlock}`,
            },
          ],
          details: {
            diff: diffResult.diff,
            firstChangedLine: firstChangedLine ?? diffResult.firstChangedLine,
            snapshotId: updatedSnapshotId,
            ...(compatibilityDetails ? { compatibility: compatibilityDetails } : {}),
          },
        };
      });
    },
  };

  pi.registerTool(toolDefinition);
}
