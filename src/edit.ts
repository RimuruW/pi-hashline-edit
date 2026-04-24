import { StringEnum } from "@mariozechner/pi-ai";
import { Markdown, Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { readFileSync } from "fs";
import { access as fsAccess } from "fs/promises";
import {
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
import { resolveMutationTargetPath, writeFileAtomically } from "./fs-write";
import {
  applyHashlineEdits,
  computeLegacyEditLineRange,
  resolveEditAnchors,
  type HashlineToolEdit,
} from "./hashline";
import { loadFileKindAndText } from "./file-kind";
import { resolveToCwd } from "./path-utils";
import { formatHashlineReadPreview } from "./read";
import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";
import {
  buildChangedResponse,
  buildFullResponse,
  buildNoopResponse,
  buildRangesResponse,
  type CompatibilityDetails as ResponseCompatibilityDetails,
  type ReturnMode,
} from "./edit-response";

const hashlineEditLinesSchema = Type.Union([
  Type.Array(Type.String(), { description: "content (preferred format)" }),
  Type.String(),
  Type.Null(),
]);

const returnRangeSchema = Type.Object(
  {
    start: Type.Integer({ minimum: 1, description: "first post-edit line to return" }),
    end: Type.Optional(Type.Integer({ minimum: 1, description: "last post-edit line to return" })),
  },
  { additionalProperties: false },
);

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
    returnMode: Type.Optional(
      StringEnum(["changed", "full", "ranges"] as const, { description: 'response mode: "changed", "full", or "ranges"' }),
    ),
    returnRanges: Type.Optional(
      Type.Array(returnRangeSchema, { description: "post-edit line ranges when returnMode is ranges" }),
    ),
    edits: Type.Optional(
      Type.Array(hashlineEditItemSchema, { description: "edits over $path" }),
    ),
  },
  { additionalProperties: false },
);

type ReturnRange = {
  start: number;
  end?: number;
};

type ReturnedRangePreview = {
  start: number;
  end: number;
  text: string;
  nextOffset?: number;
  empty?: true;
};

type FullContentPreview = {
  text: string;
  nextOffset?: number;
};

type EditRequestParams = {
  path: string;
  returnMode?: "changed" | "full" | "ranges";
  returnRanges?: ReturnRange[];
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

type EditMetrics = {
  edits_attempted: number;
  edits_noop: number;
  warnings: number;
  return_mode: "changed" | "full" | "ranges";
  classification: "applied" | "noop";
  changed_lines?: { first: number; last: number };
  added_lines?: number;
  removed_lines?: number;
  legacy_replace?: true;
};

type HashlineEditToolDetails = {
  diff: string;
  firstChangedLine?: number;
  compatibility?: CompatibilityDetails;
  /**
   * Post-edit snapshot fingerprint. Surfaced in details only — the LLM no
   * longer receives or echoes it. Hosts may use this for UI hints (e.g.
   * "file changed since last view"). See plan W2.
   */
  snapshotId?: string;
  classification?: "noop";
  nextOffset?: number;
  fullContent?: FullContentPreview;
  returnedRanges?: ReturnedRangePreview[];
  structureOutline?: string[];
  /**
   * Phase 2 C — opt-in observability surface for hosts. Never echoed in text.
   * Hosts can use it for adoption/regression dashboards.
   */
  metrics?: EditMetrics;
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
  "returnMode",
  "returnRanges",
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

function getVisibleLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
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

  if (hasOwn(request, "returnMode")) {
    if (
      request.returnMode !== "changed" &&
      request.returnMode !== "full" &&
      request.returnMode !== "ranges"
    ) {
      throw new Error('Edit request field "returnMode" must be "changed", "full", or "ranges" when provided.');
    }
  }

  if (hasOwn(request, "returnRanges")) {
    if (!Array.isArray(request.returnRanges) || request.returnRanges.length === 0) {
      throw new Error('Edit request field "returnRanges" must be a non-empty array when provided.');
    }
    for (const [index, range] of request.returnRanges.entries()) {
      if (!isRecord(range)) {
        throw new Error(`returnRanges[${index}] must be an object.`);
      }
      if (!Number.isInteger(range.start) || (range.start as number) < 1) {
        throw new Error(`returnRanges[${index}].start must be a positive integer.`);
      }
      if (hasOwn(range, "end")) {
        if (!Number.isInteger(range.end) || (range.end as number) < 1) {
          throw new Error(`returnRanges[${index}].end must be a positive integer when provided.`);
        }
        if ((range.end as number) < (range.start as number)) {
          throw new Error(`returnRanges[${index}].end must be >= start.`);
        }
      }
    }
  }

  if (request.returnMode === "ranges") {
    if (!Array.isArray(request.returnRanges) || request.returnRanges.length === 0) {
      throw new Error('Edit request with returnMode "ranges" requires a non-empty "returnRanges" array.');
    }
  } else if (hasOwn(request, "returnRanges")) {
    throw new Error('Edit request field "returnRanges" is only supported when returnMode is "ranges".');
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
  previewGeneration?: number;
};

function getRenderablePreviewInput(args: unknown): EditRequestParams | null {
  if (!isRecord(args) || typeof args.path !== "string") {
    return null;
  }

  const request: EditRequestParams = { path: args.path };
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

function getRenderedEditTextContent(
  result: { content?: Array<{ type: string; text?: string }> },
): string | undefined {
  const textContent = result.content?.find(
    (entry): entry is { type: "text"; text: string } =>
      entry.type === "text" && typeof entry.text === "string",
  );
  return textContent?.text;
}

function buildUiRenderedEditText(
  text: string | undefined,
  details: HashlineEditToolDetails | undefined,
  options: { showDiffForAppliedChanged?: boolean } = {},
): string | undefined {
  const sections: string[] = [];
  const metrics = details?.metrics;
  const isAppliedChanged =
    metrics?.classification === "applied" &&
    metrics.return_mode === "changed" &&
    metrics.added_lines !== undefined &&
    metrics.removed_lines !== undefined;

  if (isAppliedChanged) {
    sections.push(`Changes: +${metrics.added_lines} -${metrics.removed_lines}`);
  }

  if (isAppliedChanged && options.showDiffForAppliedChanged && details?.diff) {
    sections.push(["Diff preview:", "```diff", details.diff, "```"].join("\n"));
    const warnings = text?.match(/(?:^|\n)Warnings:\n[\s\S]*$/)?.[0]?.trimStart();
    if (warnings) sections.push(warnings);
  } else if (text && text.length > 0) {
    sections.push(text);
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}


function trimEdgeEmptyLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start] === "") {
    start++;
  }
  while (end > start && lines[end - 1] === "") {
    end--;
  }

  return lines.slice(start, end);
}

function isRenderedEditSectionBoundary(line: string): boolean {
  return (
    line.startsWith("--- Anchors ") ||
    line === "Warnings:" ||
    line === "Structure outline:" ||
    /^--- Range \d+ /.test(line)
  );
}

function formatRenderedEditResultMarkdown(text: string): string {
  const lines = text.split("\n");
  const sections: string[] = [];
  let plainLines: string[] = [];

  const flushPlainLines = () => {
    const trimmed = trimEdgeEmptyLines(plainLines);
    if (trimmed.length > 0) {
      sections.push(trimmed.join("\n"));
    }
    plainLines = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;

    if (line.startsWith("--- Anchors ")) {
      flushPlainLines();
      const title = line.replace(/^---\s*/, "").replace(/\s*---$/, "");
      index++;
      const bodyLines: string[] = [];
      while (index < lines.length && !isRenderedEditSectionBoundary(lines[index]!)) {
        bodyLines.push(lines[index]!);
        index++;
      }
      sections.push([`#### ${title}`, "```text", ...trimEdgeEmptyLines(bodyLines), "```"].join("\n"));
      continue;
    }

    plainLines.push(line);
    index++;
  }

  flushPlainLines();

  return sections.join("\n\n");
}

function createRenderedEditMarkdownTheme(theme: {
  fg: (token: string, text: string) => string;
  bold: (text: string) => string;
  italic?: (text: string) => string;
  underline?: (text: string) => string;
  strikethrough?: (text: string) => string;
}) {
  return {
    heading: (text: string) => theme.fg("mdHeading", text),
    link: (text: string) => theme.fg("mdLink", text),
    linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
    code: (text: string) => theme.fg("mdCode", text),
    codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
    quote: (text: string) => theme.fg("mdQuote", text),
    quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
    hr: (text: string) => theme.fg("mdHr", text),
    listBullet: (text: string) => theme.fg("mdListBullet", text),
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => theme.italic ? theme.italic(text) : text,
    underline: (text: string) => theme.underline ? theme.underline(text) : text,
    strikethrough: (text: string) => theme.strikethrough ? theme.strikethrough(text) : text,
    highlightCode: (code: string, lang?: string) =>
      code.split("\n").map((line) => {
        if (lang === "diff") {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            return theme.fg("toolDiffAdded", line);
          }
          if (line.startsWith("-") && !line.startsWith("---")) {
            return theme.fg("toolDiffRemoved", line);
          }
          return theme.fg("toolDiffContext", line);
        }

        return theme.fg("mdCodeBlock", line);
      }),
  };
}

function formatRequestedRangePreviews(
  text: string,
  ranges: ReturnRange[],
): { text: string; returnedRanges: ReturnedRangePreview[] } {
  const totalLines = getVisibleLines(text).length;
  const returnedRanges = ranges.map((range) => {
    const requestedEnd = range.end ?? range.start;
    const preview = formatHashlineReadPreview(text, {
      offset: range.start,
      limit: requestedEnd - range.start + 1,
    });
    const hasReturnedLines = /^\d+#/m.test(preview.text);
    const actualEnd = hasReturnedLines
      ? preview.nextOffset !== undefined
        ? preview.nextOffset - 1
        : Math.min(requestedEnd, totalLines)
      : requestedEnd;
    return {
      start: range.start,
      end: hasReturnedLines ? Math.max(range.start, actualEnd) : actualEnd,
      text: preview.text,
      ...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
      ...(!hasReturnedLines ? { empty: true as const } : {}),
    };
  });

  const formatted = returnedRanges
    .map(
      (range, index) =>
        `--- Range ${index + 1} (lines ${range.start}-${range.end}) ---\n${range.text}`,
    )
    .join("\n\n");

  return {
    text: formatted,
    returnedRanges,
  };
}

const STRUCTURE_MARKER_RE = /^(#{1,6}\s+.+|(export\s+)?(async\s+)?function\s+\w+|(export\s+)?class\s+\w+|(export\s+)?interface\s+\w+|(export\s+)?type\s+\w+|(export\s+)?enum\s+\w+|(const|let|var)\s+\w+\s*=\s*(async\s*)?\()/;

function truncateOutlineEntry(text: string, max = 88): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function collectOutlineEntries(previewText: string): string[] {
  const structural: string[] = [];
  for (const line of previewText.split("\n")) {
    const match = line.match(/^(\d+)#[A-Z]{2}:(.*)$/);
    if (!match) continue;
    const content = match[2]!.trim();
    if (content.length === 0) continue;
    if (!STRUCTURE_MARKER_RE.test(content)) continue;
    structural.push(`${match[1]!}: ${truncateOutlineEntry(content.replace(/\s+/g, " "))}`);
  }
  return structural.slice(0, 8);
}

function buildStructureOutline(
  sections: Array<{ label?: string; previewText: string }>,
): { text: string; outline: string[] } {
  const outlineLines: string[] = [];
  const detailOutline: string[] = [];
  const useSectionLabels = sections.length > 1;

  for (const section of sections) {
    const entries = collectOutlineEntries(section.previewText);
    if (entries.length === 0) continue;
    if (useSectionLabels && section.label) {
      outlineLines.push(`- ${section.label}`);
    }
    for (const entry of entries) {
      outlineLines.push(useSectionLabels ? `  - ${entry}` : `- ${entry}`);
      detailOutline.push(section.label ? `${section.label}: ${entry}` : entry);
    }
  }

  if (outlineLines.length === 0) {
    return { text: "", outline: [] };
  }
  return {
    text: ["Structure outline:", ...outlineLines].join("\n"),
    outline: detailOutline,
  };
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
  > & { renderShell?: "default" | "self" } = {
    name: "edit",
    label: "Edit",
    description: EDIT_DESC,
    parameters: hashlineEditToolSchema,
    prepareArguments: prepareEditArguments,
    promptSnippet: EDIT_PROMPT_SNIPPET,
    // Force the default tool shell (Box with pending/success/error background) so
    // we don't inherit renderShell: "self" from the built-in edit tool of the
    // same name, which would drop the shared background color block.
    renderShell: "default",
    renderCall(args, theme, context) {
      const previewInput = getRenderablePreviewInput(args);
      if (context.executionStarted) {
        context.state.argsKey = undefined;
        context.state.preview = undefined;
        context.state.previewGeneration = (context.state.previewGeneration ?? 0) + 1;
      } else if (!context.argsComplete || !previewInput) {
        context.state.argsKey = undefined;
        context.state.preview = undefined;
        context.state.previewGeneration = (context.state.previewGeneration ?? 0) + 1;
      } else {
        const argsKey = JSON.stringify(previewInput);
        if (context.state.argsKey !== argsKey) {
          context.state.argsKey = argsKey;
          context.state.preview = undefined;
          const previewGeneration = (context.state.previewGeneration ?? 0) + 1;
          context.state.previewGeneration = previewGeneration;
          computeEditPreview(previewInput, context.cwd)
            .then((preview) => {
              if (
                context.state.argsKey === argsKey &&
                context.state.previewGeneration === previewGeneration
              ) {
                context.state.preview = preview;
                context.invalidate();
              }
            })
            .catch((err: unknown) => {
              if (
                context.state.argsKey === argsKey &&
                context.state.previewGeneration === previewGeneration
              ) {
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
      if (isPartial) {
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(theme.fg("warning", "Editing..."));
        return text;
      }

      const typedResult = result as {
        content?: Array<{ type: string; text?: string }> ;
        details?: HashlineEditToolDetails;
      };
      const renderedText = getRenderedEditTextContent(typedResult);

      const renderState = context.state as EditRenderState | undefined;
      if (renderState) {
        renderState.preview = undefined;
        renderState.previewGeneration = (renderState.previewGeneration ?? 0) + 1;
      }

      if (context.isError) {
        if (!renderedText) {
          return new Text("", 0, 0);
        }
        const text = context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);
        text.setText(`\n${theme.fg("error", renderedText)}`);
        return text;
      }

      const uiRenderedText = buildUiRenderedEditText(
        renderedText,
        typedResult.details,
        { showDiffForAppliedChanged: true },
      );
      if (!uiRenderedText) {
        return new Text("", 0, 0);
      }

      const markdown = context.lastComponent instanceof Markdown
        ? context.lastComponent
        : new Markdown("", 0, 0, createRenderedEditMarkdownTheme(theme));
      markdown.setText(formatRenderedEditResultMarkdown(uiRenderedText));
      return markdown;
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertEditRequest(params);

      const normalizedParams = params as EditRequestParams;
      const path = normalizedParams.path;
      const absolutePath = resolveToCwd(path, ctx.cwd);
      const returnMode = normalizedParams.returnMode ?? "changed";
      const requestedReturnRanges = normalizedParams.returnRanges;
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

      const mutationTargetPath = await resolveMutationTargetPath(absolutePath);
      return withFileMutationQueue(mutationTargetPath, async () => {
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

        const editsAttempted = toolEdits.length > 0 ? toolEdits.length : 1;
        const legacyReplace = toolEdits.length === 0;

        if (originalNormalized === result) {
          const noopSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;
          return buildNoopResponse({
            path,
            returnMode: returnMode as ReturnMode,
            requestedReturnRanges,
            noopEdits,
            originalNormalized,
            snapshotId: noopSnapshotId,
            editsAttempted,
            warnings,
            legacyReplace,
            formatHashlineReadPreview: (text) =>
              formatHashlineReadPreview(text, { offset: 1 }),
            formatRequestedRangePreviews,
            buildStructureOutline,
          });
        }

        throwIfAborted(signal);
        await writeFileAtomically(
          absolutePath,
          bom + restoreLineEndings(result, originalEnding),
        );
        const updatedSnapshotId = (await getFileSnapshot(absolutePath)).snapshotId;

        const successInput = {
          path,
          returnMode: returnMode as ReturnMode,
          requestedReturnRanges,
          originalNormalized,
          result,
          warnings,
          firstChangedLine,
          lastChangedLine,
          snapshotId: updatedSnapshotId,
          compatibilityDetails: compatibilityDetails as
            | ResponseCompatibilityDetails
            | undefined,
          editsAttempted,
          noopEditsCount: noopEdits?.length ?? 0,
          legacyReplace,
          formatHashlineReadPreview: (text: string) =>
            formatHashlineReadPreview(text, { offset: 1 }),
          formatRequestedRangePreviews,
          buildStructureOutline,
        };

        if (returnMode === "full") return buildFullResponse(successInput);
        if (returnMode === "ranges") return buildRangesResponse(successInput);
        return buildChangedResponse(successInput);
      });
    },
  };

  pi.registerTool(toolDefinition);
}
