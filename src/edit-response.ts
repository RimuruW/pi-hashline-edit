/**
 * Edit response builders.
 *
 * `changed` response is only model-facing success mode. Rich post-edit payloads
 * belong in fresh `read` calls, not invisible `details` branches.
 */

import { generateDiffString } from "./edit-diff";
import { computeAffectedLineRange, formatHashlineRegion } from "./hashline";

const CHANGED_ANCHOR_TEXT_BUDGET_BYTES = 50 * 1024;

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: HashlineEditToolDetails;
};

export type EditClassification = "applied" | "noop";

/**
 * Host-visible, opt-in observability surface. LLM never sees this — it lives in
 * `details` only. Hosts can use it for dashboards, adoption metrics, or
 * regression alarms.
 *
 * snake_case is intentional: most observability backends prefer it and avoiding
 * camelCase saves a transform on host side.
 */
export type EditMetrics = {
	edits_attempted: number;
	edits_noop: number;
	warnings: number;
	classification: EditClassification;
	changed_lines?: { first: number; last: number };
	added_lines?: number;
	removed_lines?: number;
};

export type HashlineEditToolDetails = {
	diff: string;
	firstChangedLine?: number;
	/**
	 * Post-edit snapshot fingerprint. Surfaced in details only — LLM no longer
	 * receives or echoes it. Hosts may use this for UI hints.
	 */
	snapshotId?: string;
	classification: EditClassification;
	warnings: string[];
	/**
	 * Opt-in observability surface for hosts. Never echoed in text.
	 */
	metrics: EditMetrics;
};

export type EditMeta = {
	editsAttempted: number;
	noopEditsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
};

type NoopEditEntry = {
	editIndex: number;
	loc: string;
	currentContent: string;
};

export interface NoopResponseInput {
	path: string;
	noopEdits: NoopEditEntry[] | undefined;
	snapshotId: string;
	editMeta: EditMeta;
	warnings: string[] | undefined;
}

export interface SuccessResponseInput {
	originalNormalized: string;
	result: string;
	warnings: string[] | undefined;
	snapshotId: string;
	editMeta: EditMeta;
}

function getVisibleLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function countDiffLines(diff: string, marker: "+" | "-"): number {
	if (!diff) return 0;
	let count = 0;
	for (const line of diff.split("\n")) {
		if (
			line.startsWith(marker) &&
			!line.startsWith(`${marker}${marker}${marker}`)
		) {
			count += 1;
		}
	}
	return count;
}

function buildMetrics(args: {
	classification: EditClassification;
	editsAttempted: number;
	noopEditsCount: number;
	warningsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
	addedLines?: number;
	removedLines?: number;
}): EditMetrics {
	const metrics: EditMetrics = {
		edits_attempted: args.editsAttempted,
		edits_noop: args.noopEditsCount,
		warnings: args.warningsCount,
		classification: args.classification,
	};
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
	if (args.addedLines !== undefined) metrics.added_lines = args.addedLines;
	if (args.removedLines !== undefined)
		metrics.removed_lines = args.removedLines;
	return metrics;
}

function warningsBlockOf(warnings: string[] | undefined): string {
	return warnings?.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
}

const ANCHORS_OMITTED_TEXT = "Anchors omitted; use read for subsequent edits.";

/**
 * Model-facing anchor block for the changed region: fresh LINE#HASH lines the
 * model can chain into nearby follow-up edits without a re-read. Falls back to
 * a re-read hint when the region is unbounded or exceeds the text budget.
 */
function buildAnchorsBlock(
	resultLines: string[],
	anchorRange: { start: number; end: number } | null,
): string {
	if (!anchorRange) {
		return ANCHORS_OMITTED_TEXT;
	}
	const region = resultLines.slice(anchorRange.start - 1, anchorRange.end);
	const formatted = formatHashlineRegion(region, anchorRange.start);
	const block = `--- Anchors ${anchorRange.start}-${anchorRange.end} ---\n${formatted}`;
	return Buffer.byteLength(block, "utf8") <= CHANGED_ANCHOR_TEXT_BUDGET_BYTES
		? block
		: ANCHORS_OMITTED_TEXT;
}

export function buildNoopResponse(input: NoopResponseInput): ToolResult {
	const { path, noopEdits, snapshotId, editMeta, warnings } = input;

	const noopDetailsText = noopEdits?.length
		? noopEdits
				.map(
					(edit) =>
						`Edit ${edit.editIndex}: replacement for ${edit.loc} is identical to current content:\n  ${edit.loc}: ${edit.currentContent}`,
				)
				.join("\n")
		: "The edits produced identical content.";

	const metrics = buildMetrics({
		classification: "noop",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
	});

	return {
		content: [
			{
				type: "text",
				text: `No changes made to ${path}\nClassification: noop\n${noopDetailsText}${warningsBlockOf(warnings)}`,
			},
		],
		details: {
			diff: "",
			firstChangedLine: undefined,
			snapshotId,
			classification: "noop",
			warnings: warnings ?? [],
			metrics,
		},
	};
}

export function buildChangedResponse(input: SuccessResponseInput): ToolResult {
	const { result, warnings, snapshotId, originalNormalized, editMeta } = input;

	const diffResult = generateDiffString(originalNormalized, result);
	const addedLines = countDiffLines(diffResult.diff, "+");
	const removedLines = countDiffLines(diffResult.diff, "-");
	const warningsBlock = warningsBlockOf(warnings);

	const resultLines = getVisibleLines(result);
	const anchorRange = computeAffectedLineRange({
		firstChangedLine: editMeta.firstChangedLine,
		lastChangedLine: editMeta.lastChangedLine,
		resultLineCount: resultLines.length,
	});
	const anchorsBlock = buildAnchorsBlock(resultLines, anchorRange);

	const text = [anchorsBlock, warningsBlock.trimStart()]
		.filter((section) => section.length > 0)
		.join("\n\n");

	const metrics = buildMetrics({
		classification: "applied",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
		firstChangedLine: editMeta.firstChangedLine,
		lastChangedLine: editMeta.lastChangedLine,
		addedLines,
		removedLines,
	});

	return {
		content: [{ type: "text", text }],
		details: {
			diff: diffResult.diff,
			firstChangedLine: editMeta.firstChangedLine,
			snapshotId,
			classification: "applied",
			warnings: warnings ?? [],
			metrics,
		},
	};
}
