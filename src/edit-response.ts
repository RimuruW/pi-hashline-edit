/**
 * Edit response builders.
 *
 * Pulled out of `src/edit.ts` execute() so each returnMode branch
 * (noop / full / ranges / changed) is independently testable and the
 * top-level execute path stays narrative.
 *
 * No behaviour change: outputs are byte-identical to the previous inline
 * implementation. The only additive surface is `details.metrics` (Phase 2 C
 * — observability for hosts; the LLM-visible text is unchanged).
 */

import {
  buildCompactHashlineDiffPreview,
  generateDiffString,
} from "./edit-diff";

// Local shape — pi-coding-agent does not export a public `ToolResult`. The
// builders return `details` as `any` so callers can keep their own per-tool
// details type without re-asserting it here. This file intentionally does
// not import the agent's tool-result type to stay decoupled from internals.
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: any;
};
import {
  computeAffectedLineRange,
  formatHashlineRegion,
} from "./hashline";

// ─── Public types ───────────────────────────────────────────────────────

export type ReturnMode = "changed" | "full" | "ranges";

export type ReturnRange = {
  start: number;
  end?: number;
};

export type ReturnedRangePreview = {
  start: number;
  end: number;
  text: string;
  nextOffset?: number;
  empty?: true;
};

export type FullContentPreview = {
  text: string;
  nextOffset?: number;
};

export type CompatibilityDetails = {
  used: true;
  strategy: "legacy-top-level-replace";
  matchCount: 1;
  fuzzyMatch?: true;
};

/**
 * Host-visible, opt-in observability surface (Phase 2 C). The LLM never sees
 * this — it lives in `details` only. Hosts can use it for dashboards,
 * adoption metrics, or regression alarms (e.g. "noop rate spiking").
 *
 * snake_case is intentional: most observability backends prefer it and
 * avoiding camelCase saves a transform on the host side.
 */
export type EditMetrics = {
  edits_attempted: number;
  edits_noop: number;
  warnings: number;
  return_mode: ReturnMode;
  classification: "applied" | "noop";
  changed_lines?: { first: number; last: number };
  legacy_replace?: true;
};

export type ReadMetrics = {
  truncated: boolean;
  next_offset?: number;
};

type NoopEditEntry = {
  editIndex: number;
  loc: string;
  currentContent: string;
};

type StructureSection = { label?: string; previewText: string };

type FullPreviewBuilder = (text: string) => FullContentPreview;
type RangePreviewBuilder = (
  text: string,
  ranges: ReturnRange[],
) => { text: string; returnedRanges: ReturnedRangePreview[] };
type OutlineBuilder = (sections: StructureSection[]) => {
  text: string;
  outline: string[];
};

// Diff/anchor preview text budget. When the assembled changed-mode text
// would exceed this, drop the diff preview from text (still in details.diff).
export const RETURN_TEXT_BUDGET = 1500;

// ─── Builder inputs ─────────────────────────────────────────────────────

export interface NoopResponseInput {
  path: string;
  returnMode: ReturnMode;
  requestedReturnRanges: ReturnRange[] | undefined;
  noopEdits: NoopEditEntry[] | undefined;
  originalNormalized: string;
  snapshotId: string;
  editsAttempted: number;
  warnings: string[] | undefined;
  legacyReplace: boolean;
  formatHashlineReadPreview: FullPreviewBuilder;
  formatRequestedRangePreviews: RangePreviewBuilder;
  buildStructureOutline: OutlineBuilder;
}

export interface SuccessResponseInput {
  path: string;
  returnMode: ReturnMode;
  requestedReturnRanges: ReturnRange[] | undefined;
  originalNormalized: string;
  result: string;
  warnings: string[] | undefined;
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
  snapshotId: string;
  compatibilityDetails: CompatibilityDetails | undefined;
  editsAttempted: number;
  noopEditsCount: number;
  legacyReplace: boolean;
  formatHashlineReadPreview: FullPreviewBuilder;
  formatRequestedRangePreviews: RangePreviewBuilder;
  buildStructureOutline: OutlineBuilder;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function getVisibleLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function buildMetrics(args: {
  classification: "applied" | "noop";
  returnMode: ReturnMode;
  editsAttempted: number;
  noopEditsCount: number;
  warningsCount: number;
  legacyReplace: boolean;
  firstChangedLine?: number;
  lastChangedLine?: number;
}): EditMetrics {
  const metrics: EditMetrics = {
    edits_attempted: args.editsAttempted,
    edits_noop: args.noopEditsCount,
    warnings: args.warningsCount,
    return_mode: args.returnMode,
    classification: args.classification,
  };
  if (args.legacyReplace) metrics.legacy_replace = true;
  if (
    args.classification === "applied" &&
    args.firstChangedLine !== undefined &&
    args.lastChangedLine !== undefined
  ) {
    metrics.changed_lines = {
      first: args.firstChangedLine,
      last: args.lastChangedLine,
    };
  }
  return metrics;
}

function warningsBlockOf(warnings: string[] | undefined): string {
  return warnings?.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
}

// ─── Builders ───────────────────────────────────────────────────────────

export function buildNoopResponse(input: NoopResponseInput): ToolResult {
  const {
    path,
    returnMode,
    requestedReturnRanges,
    noopEdits,
    originalNormalized,
    snapshotId,
    editsAttempted,
    warnings,
    legacyReplace,
    formatHashlineReadPreview,
    formatRequestedRangePreviews,
    buildStructureOutline,
  } = input;

  const noopDetailsText = noopEdits?.length
    ? noopEdits
        .map(
          (edit) =>
            `Edit ${edit.editIndex}: replacement for ${edit.loc} is identical to current content:\n  ${edit.loc}: ${edit.currentContent}`,
        )
        .join("\n")
    : "The edits produced identical content.";

  const fullPreview =
    returnMode === "full"
      ? formatHashlineReadPreview(originalNormalized)
      : undefined;
  const rangePreviews =
    returnMode === "ranges"
      ? formatRequestedRangePreviews(originalNormalized, requestedReturnRanges!)
      : undefined;
  const outline =
    returnMode === "full"
      ? buildStructureOutline([{ previewText: fullPreview!.text }])
      : returnMode === "ranges"
        ? buildStructureOutline(
            rangePreviews!.returnedRanges.map((range, index) => ({
              label: `Range ${index + 1} (lines ${range.start}-${range.end})`,
              previewText: range.text,
            })),
          )
        : undefined;

  const text =
    returnMode === "full"
      ? `No changes made to ${path}\nClassification: noop\n\n${outline!.text}\n\nFull content is available in details.fullContent.`
      : returnMode === "ranges"
        ? `No changes made to ${path}\nClassification: noop\n\n${outline!.text}\n\nRequested range payloads are available in details.returnedRanges.`
        : `No changes made to ${path}\nClassification: noop\n${noopDetailsText}`;

  const metrics = buildMetrics({
    classification: "noop",
    returnMode,
    editsAttempted,
    noopEditsCount: noopEdits?.length ?? 0,
    warningsCount: warnings?.length ?? 0,
    legacyReplace,
  });

  return {
    content: [{ type: "text", text }],
    details: {
      diff: "",
      firstChangedLine: undefined,
      snapshotId,
      classification: "noop" as const,
      ...(fullPreview?.nextOffset !== undefined
        ? { nextOffset: fullPreview.nextOffset }
        : {}),
      ...(fullPreview
        ? {
            fullContent: {
              text: fullPreview.text,
              ...(fullPreview.nextOffset !== undefined
                ? { nextOffset: fullPreview.nextOffset }
                : {}),
            },
          }
        : {}),
      ...(rangePreviews ? { returnedRanges: rangePreviews.returnedRanges } : {}),
      ...(outline ? { structureOutline: outline.outline } : {}),
      metrics,
    },
  };
}

export function buildFullResponse(input: SuccessResponseInput): ToolResult {
  const {
    path,
    result,
    warnings,
    firstChangedLine,
    lastChangedLine,
    snapshotId,
    compatibilityDetails,
    originalNormalized,
    editsAttempted,
    noopEditsCount,
    legacyReplace,
    formatHashlineReadPreview,
    buildStructureOutline,
  } = input;

  const diffResult = generateDiffString(originalNormalized, result);
  const fullPreview = formatHashlineReadPreview(result);
  const outline = buildStructureOutline([{ previewText: fullPreview.text }]);
  const text = `Updated ${path}${warningsBlockOf(warnings)}\n\n${outline.text}\n\nFull content is available in details.fullContent.`;

  const metrics = buildMetrics({
    classification: "applied",
    returnMode: "full",
    editsAttempted,
    noopEditsCount,
    warningsCount: warnings?.length ?? 0,
    legacyReplace,
    firstChangedLine,
    lastChangedLine,
  });

  return {
    content: [{ type: "text", text }],
    details: {
      diff: diffResult.diff,
      firstChangedLine: firstChangedLine ?? diffResult.firstChangedLine,
      snapshotId,
      ...(fullPreview.nextOffset !== undefined
        ? { nextOffset: fullPreview.nextOffset }
        : {}),
      fullContent: {
        text: fullPreview.text,
        ...(fullPreview.nextOffset !== undefined
          ? { nextOffset: fullPreview.nextOffset }
          : {}),
      },
      structureOutline: outline.outline,
      ...(compatibilityDetails ? { compatibility: compatibilityDetails } : {}),
      metrics,
    },
  };
}

export function buildRangesResponse(input: SuccessResponseInput): ToolResult {
  const {
    path,
    result,
    warnings,
    firstChangedLine,
    lastChangedLine,
    snapshotId,
    compatibilityDetails,
    originalNormalized,
    requestedReturnRanges,
    editsAttempted,
    noopEditsCount,
    legacyReplace,
    formatRequestedRangePreviews,
    buildStructureOutline,
  } = input;

  const diffResult = generateDiffString(originalNormalized, result);
  const rangePreviews = formatRequestedRangePreviews(
    result,
    requestedReturnRanges!,
  );
  const outline = buildStructureOutline(
    rangePreviews.returnedRanges.map((range, index) => ({
      label: `Range ${index + 1} (lines ${range.start}-${range.end})`,
      previewText: range.text,
    })),
  );
  const text = `Updated ${path}${warningsBlockOf(warnings)}\n\n${outline.text}\n\nRequested range payloads are available in details.returnedRanges.`;

  const metrics = buildMetrics({
    classification: "applied",
    returnMode: "ranges",
    editsAttempted,
    noopEditsCount,
    warningsCount: warnings?.length ?? 0,
    legacyReplace,
    firstChangedLine,
    lastChangedLine,
  });

  return {
    content: [{ type: "text", text }],
    details: {
      diff: diffResult.diff,
      firstChangedLine: firstChangedLine ?? diffResult.firstChangedLine,
      snapshotId,
      returnedRanges: rangePreviews.returnedRanges,
      structureOutline: outline.outline,
      ...(compatibilityDetails ? { compatibility: compatibilityDetails } : {}),
      metrics,
    },
  };
}

export function buildChangedResponse(input: SuccessResponseInput): ToolResult {
  const {
    path,
    result,
    warnings,
    firstChangedLine,
    lastChangedLine,
    snapshotId,
    compatibilityDetails,
    originalNormalized,
    editsAttempted,
    noopEditsCount,
    legacyReplace,
  } = input;

  const diffResult = generateDiffString(originalNormalized, result);
  const preview = buildCompactHashlineDiffPreview(diffResult.diff);
  const summaryLine = `Changes: +${preview.addedLines} -${preview.removedLines}${preview.preview ? "" : " (no textual diff preview)"}`;
  const previewBlock = preview.preview
    ? `\n\nDiff preview:\n${preview.preview}`
    : "";
  const warningsBlock = warningsBlockOf(warnings);

  const resultLines = getVisibleLines(result);
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

  const fullText = `Updated ${path}\n${summaryLine}${anchorsBlock}${previewBlock}${warningsBlock}`;
  const trimmedText =
    fullText.length > RETURN_TEXT_BUDGET && previewBlock
      ? `Updated ${path}\n${summaryLine}${anchorsBlock}${warningsBlock}\n\nDiff preview omitted (text budget ${RETURN_TEXT_BUDGET} exceeded; full diff in details.diff).`
      : fullText;

  const metrics = buildMetrics({
    classification: "applied",
    returnMode: "changed",
    editsAttempted,
    noopEditsCount,
    warningsCount: warnings?.length ?? 0,
    legacyReplace,
    firstChangedLine,
    lastChangedLine,
  });

  return {
    content: [{ type: "text", text: trimmedText }],
    details: {
      diff: diffResult.diff,
      firstChangedLine: firstChangedLine ?? diffResult.firstChangedLine,
      snapshotId,
      ...(compatibilityDetails ? { compatibility: compatibilityDetails } : {}),
      metrics,
    },
  };
}
