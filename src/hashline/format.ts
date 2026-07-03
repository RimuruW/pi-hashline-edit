/**
 * Format helpers — hashline region rendering, affected-line range, changed-line range.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 */

import { computeLineHash } from "./hash";

// ─── Affected-line computation (for returning anchors after edit) ───────

const ANCHOR_CONTEXT_LINES = 2;
const ANCHOR_MAX_OUTPUT_LINES = 12;

/**
 * Compute the post-edit line range covering changed lines plus context.
 * Uses `firstChangedLine` and `lastChangedLine` from the edit result for
 * precise bounds. Returns null if the range (with context) exceeds the
 * output budget, signalling that the LLM should re-read instead.
 */
export function computeAffectedLineRange(params: {
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	resultLineCount: number;
	contextLines?: number;
	maxOutputLines?: number;
}): { start: number; end: number } | null {
	const {
		firstChangedLine,
		lastChangedLine,
		resultLineCount,
		contextLines = ANCHOR_CONTEXT_LINES,
		maxOutputLines = ANCHOR_MAX_OUTPUT_LINES,
	} = params;

	if (firstChangedLine === undefined || lastChangedLine === undefined) {
		return null;
	}

	const start = Math.max(1, firstChangedLine - contextLines);
	const end = Math.min(resultLineCount, lastChangedLine + contextLines);

	// Degenerate range: an empty result document (resultLineCount 0) clamps
	// end below start. Unreachable from the edit tool (E_WOULD_EMPTY rejects
	// emptying writes upstream), but this is a pure exported helper, so it
	// keeps a sane null contract for that input rather than {start:1, end:0}.
	if (end < start) {
		return null;
	}

	if (end - start + 1 > maxOutputLines) {
		return null;
	}

	return { start, end };
}

export function formatHashlineRegion(
	fileLines: readonly string[],
	startLine: number,
	endLine: number,
): string {
	const lineNumberWidth = String(endLine).length;
	const out: string[] = [];
	for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
		const line = fileLines[lineNum - 1]!;
		const hash = computeLineHash(fileLines, lineNum - 1);
		const paddedLineNumber = String(lineNum).padStart(lineNumberWidth, " ");
		out.push(`${paddedLineNumber}#${hash}:${line}`);
	}
	return out.join("\n");
}

// ─── Changed line range computation ─────────────────────────────────

/**
 * Compute first/last changed line numbers between two document versions.
 * Uses character-level diff to locate the changed span, then maps to line
 * numbers in the result document so downstream anchor chaining works.
 */
export function computeChangedLineRange(
	original: string,
	result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
	if (original === result) return null;

	function countVisibleLines(text: string): number {
		if (text.length === 0) {
			return 0;
		}
		const lines = text.split("\n");
		return text.endsWith("\n") ? lines.length - 1 : lines.length;
	}

	if (original.length === 0) {
		return {
			firstChangedLine: 1,
			lastChangedLine: countVisibleLines(result),
		};
	}

	if (result.startsWith(original) && original.endsWith("\n")) {
		return {
			firstChangedLine: countVisibleLines(original) + 1,
			lastChangedLine: countVisibleLines(result),
		};
	}

	let firstDiff = 0;
	const minLen = Math.min(original.length, result.length);
	while (firstDiff < minLen && original[firstDiff] === result[firstDiff]) {
		firstDiff++;
	}
	if (firstDiff === minLen && original.length === result.length) return null;

	let lastOrig = original.length - 1;
	let lastRes = result.length - 1;
	while (
		lastOrig >= firstDiff &&
		lastRes >= firstDiff &&
		original[lastOrig] === result[lastRes]
	) {
		lastOrig--;
		lastRes--;
	}

	function indexToLine(charIdx: number, text: string): number {
		let line = 1;
		for (let i = 0; i < charIdx && i < text.length; i++) {
			if (text[i] === "\n") line++;
		}
		return line;
	}

	const firstChangedLine = indexToLine(firstDiff + 1, result);
	let lastChangedLine: number;
	if (lastRes < firstDiff) {
		lastChangedLine = result.length === 0 ? 1 : countVisibleLines(result);
	} else if (
		firstDiff === 0 &&
		original.length > 0 &&
		result.endsWith(original)
	) {
		lastChangedLine = firstChangedLine;
	} else {
		lastChangedLine = indexToLine(lastRes + 1, result);
	}

	return { firstChangedLine, lastChangedLine };
}
