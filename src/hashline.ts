/**
 * Hashline engine — hash-anchored line editing.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 */

import * as XXH from "xxhashjs";
import { throwIfAborted } from "./runtime";

// ─── Types ──────────────────────────────────────────────────────────────

export type Anchor = { line: number; hash: string };
export type HashlineEdit =
	| { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] }
	| { op: "append"; pos?: Anchor; lines: string[] }
	| { op: "prepend"; pos?: Anchor; lines: string[] };

interface HashMismatch {
	line: number;
	expected: string;
	actual: string;
}

interface NoopEdit {
	editIndex: number;
	loc: string;
	currentContent: string;
}

// ─── Hash computation ───────────────────────────────────────────────────

/**
 * Custom 16-character hash alphabet. Deliberately excludes:
 * - Hex digits A–F (prevents confusion with hex literals in code)
 * - Visually confusable letters: D, G, I, L, O (look like digits 0, 6, 1, 1, 0)
 * - Common vowels A, E, I, O, U (prevents accidental English words)
 *
 * This makes hash references like "5#MQ" unambiguous — they can never be
 * mistaken for code content, hex literals, or natural language.
 */
const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

const DICT = Array.from({ length: 256 }, (_, i) => {
	const h = i >>> 4;
	const l = i & 0x0f;
	return `${NIBBLE_STR[h]}${NIBBLE_STR[l]}`;
});

/** Pattern matching hashline display format prefixes: `LINE#ID:CONTENT` and `#ID:CONTENT` */
const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;
const DIFF_PLUS_RE = /^\+(?!\+)/;
const HASH_RELOCATION_WINDOW = 20;

/** Lines containing no alphanumeric characters (only punctuation/symbols/whitespace). */
const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

function xxh32(input: string, seed = 0): number {
	return XXH.h32(seed).update(input).digest().toNumber() >>> 0;
}

export function computeLineHash(idx: number, line: string): string {
	if (line.endsWith("\r")) line = line.slice(0, -1);
	line = line.replace(/\s+/g, "");
	// Mix in the line number for non-significant lines (e.g. "}", "---", blank)
	// to reduce hash collisions on structural/separator lines.
	let seed = 0;
	if (!RE_SIGNIFICANT.test(line)) {
		seed = idx;
	}
	return DICT[xxh32(line, seed) & 0xff];
}

// ─── Parsing ────────────────────────────────────────────────────────────

export function parseLineRef(ref: string): { line: number; hash: string } {
	// Match LINE#HASH format, tolerating:
	//  - leading ">+" and whitespace (from mismatch/diff display)
	//  - optional trailing display suffix (":..." content)
	const match = ref.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/);
	if (!match) throw new Error(`Invalid line reference "${ref}". Expected "LINE#HASH" (e.g. "5#MQ").`);
	const line = Number.parseInt(match[1], 10);
	if (line < 1) throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	return { line, hash: match[2] };
}

// ─── Mismatch formatting ────────────────────────────────────────────────

function formatMismatchError(mismatches: HashMismatch[], fileLines: string[]): string {
	const mismatchSet = new Map<number, HashMismatch>();
	for (const m of mismatches) mismatchSet.set(m.line, m);

	const displayLines = new Set<number>();
	for (const m of mismatches) {
		for (let i = Math.max(1, m.line - 2); i <= Math.min(fileLines.length, m.line + 2); i++) {
			displayLines.add(i);
		}
	}

	const sorted = [...displayLines].sort((a, b) => a - b);
	const out: string[] = [
		`${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Auto-relocation checks only within ±${HASH_RELOCATION_WINDOW} lines of each anchor. Use the updated LINE#HASH references shown below (>>> marks changed lines).`,
		"",
	];

	let prev = -1;
	for (const num of sorted) {
		if (prev !== -1 && num > prev + 1) out.push("    ...");
		prev = num;
		const content = fileLines[num - 1];
		const hash = computeLineHash(num, content);
		const prefix = `${num}#${hash}`;
		out.push(mismatchSet.has(num) ? `>>> ${prefix}:${content}` : `    ${prefix}:${content}`);
	}

	return out.join("\n");
}

// ─── Content preprocessing ─────────────────────────────────────────────────────

export function stripNewLinePrefixes(lines: string[]): string[] {
	let hashCount = 0;
	let plusCount = 0;
	let nonEmpty = 0;

	for (const l of lines) {
		if (!l.length) continue;
		nonEmpty++;
		if (HASHLINE_PREFIX_RE.test(l)) hashCount++;
		if (DIFF_PLUS_RE.test(l)) plusCount++;
	}

	if (!nonEmpty) return lines;
	const stripHash = hashCount > 0 && hashCount === nonEmpty;
	const stripPlus = !stripHash && plusCount > 0 && plusCount >= nonEmpty * 0.5;
	if (!stripHash && !stripPlus) return lines;

	return lines.map((l) =>
		stripHash ? l.replace(HASHLINE_PREFIX_RE, "") : stripPlus ? l.replace(DIFF_PLUS_RE, "") : l,
	);
}

/**
 * Parse replacement text into lines with prefix stripping and trailing blank removal.
 * Accepts string[], string, or null — matching upstream hashlineParseText semantics:
 *   1. Normalize to string[]
 *   2. Strip hashline/diff prefixes
 *   3. Remove trailing blank line (models frequently include a trailing newline)
 */
export function hashlineParseText(edit: string[] | string | null): string[] {
	if (edit === null) return [];
	const lines = stripNewLinePrefixes(Array.isArray(edit) ? edit : edit.split("\n"));
	if (lines.length === 0) return lines;
	if (lines[lines.length - 1].trim() === "") return lines.slice(0, -1);
	return lines;
}


/**
 * Map flat tool-schema edits into typed internal representations.
 *
 * Strict: provided anchors must parse successfully. Missing anchors are
 * fine for append (→ EOF) and prepend (→ BOF), but a malformed anchor
 * that was explicitly supplied is always an error.
 *
 * - replace + pos only → single-line replace
 * - replace + pos + end → range replace
 * - append + pos or end → append after that anchor
 * - prepend + pos or end → prepend before that anchor
 * - no anchors → file-level append/prepend (only for those ops)
 *
 * Unknown ops default to "replace".
 */
export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
	const result: HashlineEdit[] = [];
	for (const edit of edits) {
		const lines = hashlineParseText(edit.lines);
		const tag = edit.pos ? parseLineRef(edit.pos) : undefined;
		const end = edit.end ? parseLineRef(edit.end) : undefined;

		// Validate op
		const op = edit.op ?? "replace";
		if (op !== "replace" && op !== "append" && op !== "prepend") {
			throw new Error(`Unknown edit op "${op}". Expected "replace", "append", or "prepend".`);
		}
		switch (op) {
			case "replace": {
				if (tag && end) {
					result.push({ op: "replace", pos: tag, end, lines });
				} else if (tag || end) {
					result.push({ op: "replace", pos: tag || end!, lines });
				} else {
					throw new Error("Replace requires at least one anchor (pos or end).");
				}
				break;
			}
			case "append": {
				result.push({ op: "append", pos: tag ?? end, lines });
				break;
			}
			case "prepend": {
				result.push({ op: "prepend", pos: end ?? tag, lines });
				break;
			}
		}
	}
	return result;
}

// ─── Main edit engine ───────────────────────────────────────────────────

/** Schema-level edit as received from the tool layer (pos/end are tag strings, lines may be string|null). */
export type HashlineToolEdit = {
	op: string;
	pos?: string;
	end?: string;
	lines: string[] | string | null;
};


const MIN_AUTOCORRECT_LENGTH = 2;

function shouldAutocorrect(line: string, otherLine: string): boolean {
	if (!line || line !== otherLine) return false;
	line = line.trim();
	if (line.length < MIN_AUTOCORRECT_LENGTH) {
		// Short lines: only allow brace/paren closers
		return line.endsWith("}") || line.endsWith(")");
	}
	return true;
}

function isEscapedTabAutocorrectEnabled(): boolean {
	const value = process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
	if (value === "0") return false;
	return true;
}

function maybeAutocorrectEscapedTabIndentation(edits: HashlineEdit[], warnings: string[]): void {
	if (!isEscapedTabAutocorrectEnabled()) return;
	for (const edit of edits) {
		if (edit.lines.length === 0) continue;
		const hasEscapedTabs = edit.lines.some(line => line.includes("\\t"));
		if (!hasEscapedTabs) continue;
		const hasRealTabs = edit.lines.some(line => line.includes("\t"));
		if (hasRealTabs) continue;
		let correctedCount = 0;
		const corrected = edit.lines.map(line =>
			line.replace(/^((?:\\t)+)/, escaped => {
				correctedCount += escaped.length / 2;
				return "\t".repeat(escaped.length / 2);
			}),
		);
		if (correctedCount === 0) continue;
		edit.lines = corrected;
		warnings.push(
			`Auto-corrected escaped tab indentation in edit: converted leading \\t sequence(s) to real tab characters`,
		);
	}
}

function maybeWarnSuspiciousUnicodeEscapePlaceholder(edits: HashlineEdit[], warnings: string[]): void {
	for (const edit of edits) {
		if (edit.lines.length === 0) continue;
		if (!edit.lines.some(line => /\\uDDDD/i.test(line))) continue;
		warnings.push(
			`Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.`,
		);
	}
}
export function applyHashlineEdits(
	content: string,
	edits: HashlineEdit[],
	signal?: AbortSignal,
): { content: string; firstChangedLine: number | undefined; warnings?: string[]; noopEdits?: NoopEdit[] } {
	throwIfAborted(signal);
	if (!edits.length) return { content, firstChangedLine: undefined };

	const fileLines = content.split("\n");
	const origLines = [...fileLines];
	let firstChanged: number | undefined;
	const noopEdits: NoopEdit[] = [];
	const warnings: string[] = [];

	// Build hash index for local-window relocation
	const lineHashes: string[] = [];
	const hashToLines = new Map<string, number[]>();
	for (let i = 0; i < fileLines.length; i++) {
		throwIfAborted(signal);
		const lineNumber = i + 1;
		const h = computeLineHash(lineNumber, fileLines[i]);
		lineHashes.push(h);
		const bucket = hashToLines.get(h);
		if (bucket) bucket.push(lineNumber);
		else hashToLines.set(h, [lineNumber]);
	}

	const relocationNotes = new Set<string>();

	function findRelocationLine(expectedHash: string, hintLine: number): number | undefined {
		const candidates = hashToLines.get(expectedHash);
		if (!candidates?.length) return undefined;

		const minLine = Math.max(1, hintLine - HASH_RELOCATION_WINDOW);
		const maxLine = Math.min(fileLines.length, hintLine + HASH_RELOCATION_WINDOW);
		let match: number | undefined;

		for (const candidate of candidates) {
			if (candidate < minLine || candidate > maxLine) continue;
			if (match !== undefined) return undefined; // ambiguous within window
			match = candidate;
		}
		return match;
	}

	// Validate all refs before mutation
	const mismatches: HashMismatch[] = [];

	function validate(ref: Anchor): boolean {
		if (ref.line < 1 || ref.line > fileLines.length)
			throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
		const expected = ref.hash;
		const originalLine = ref.line;
		const actual = lineHashes[originalLine - 1];
		if (actual === expected) return true;
		const relocated = findRelocationLine(expected, originalLine);
		if (relocated !== undefined) {
			ref.line = relocated;
			relocationNotes.add(
				`Auto-relocated anchor ${originalLine}#${ref.hash} -> ${relocated}#${ref.hash} (window ±${HASH_RELOCATION_WINDOW}).`,
			);
			return true;
		}
		mismatches.push({ line: originalLine, expected: ref.hash, actual });
		return false;
	}

	// Pre-validate: collect all hash mismatches before mutating
	for (const edit of edits) {
		throwIfAborted(signal);
		switch (edit.op) {
			case "replace": {
				if (edit.end) {
					const originalStart = edit.pos.line;
					const originalEnd = edit.end.line;
					const originalCount = originalEnd - originalStart + 1;

					if (originalStart > originalEnd) {
						throw new Error(`Range start line ${originalStart} must be <= end line ${originalEnd}`);
					}

					const startOk = validate(edit.pos);
					const endOk = validate(edit.end);
					if (!startOk || !endOk) continue;

					// If both validated but relocation invalidated the range, revert and report mismatch
					const relocatedCount = edit.end.line - edit.pos.line + 1;
					const invalidRange = edit.pos.line > edit.end.line;
					const scopeChanged = relocatedCount !== originalCount;
					if (invalidRange || scopeChanged) {
						edit.pos.line = originalStart;
						edit.end.line = originalEnd;
						mismatches.push(
							{ line: originalStart, expected: edit.pos.hash, actual: lineHashes[originalStart - 1] },
							{ line: originalEnd, expected: edit.end.hash, actual: lineHashes[originalEnd - 1] },
						);
					}
				} else {
					if (!validate(edit.pos)) continue;
				}
				break;
			}
			case "append": {
				if (edit.pos && !validate(edit.pos)) continue;
				if (edit.lines.length === 0) {
					throw new Error("Append with empty lines payload. Provide content to insert or remove the edit.");
				}
				break;
			}
			case "prepend": {
				if (edit.pos && !validate(edit.pos)) continue;
				if (edit.lines.length === 0) {
					throw new Error("Prepend with empty lines payload. Provide content to insert or remove the edit.");
				}
				break;
			}
		}
	}
	if (mismatches.length) throw new Error(formatMismatchError(mismatches, fileLines));

	// Auto-correct escaped tab indentation and warn on suspicious Unicode escapes
	maybeAutocorrectEscapedTabIndentation(edits, warnings);
	maybeWarnSuspiciousUnicodeEscapePlaceholder(edits, warnings);

	// Deduplicate identical edits
	const seenEditKeys = new Map<string, number>();
	const dedupIndices = new Set<number>();
	for (let i = 0; i < edits.length; i++) {
		throwIfAborted(signal);
		const edit = edits[i];
		let lineKey: string;
		switch (edit.op) {
			case "replace":
				if (!edit.end) {
					lineKey = `s:${edit.pos.line}`;
				} else {
					lineKey = `r:${edit.pos.line}:${edit.end.line}`;
				}
				break;
			case "append":
				if (edit.pos) {
					lineKey = `i:${edit.pos.line}`;
					break;
				}
				lineKey = "ieof";
				break;
			case "prepend":
				if (edit.pos) {
					lineKey = `ib:${edit.pos.line}`;
					break;
				}
				lineKey = "ibef";
				break;
		}
		const dstKey = `${lineKey}:${edit.lines.join("\n")}`;
		if (seenEditKeys.has(dstKey)) {
			dedupIndices.add(i);
		} else {
			seenEditKeys.set(dstKey, i);
		}
	}
	if (dedupIndices.size > 0) {
		for (let i = edits.length - 1; i >= 0; i--) {
			if (dedupIndices.has(i)) edits.splice(i, 1);
		}
	}

	// Compute sort key (descending) — bottom-up application
	const annotated = edits.map((edit, idx) => {
		let sortLine: number;
		let precedence: number;
		switch (edit.op) {
			case "replace":
				if (!edit.end) {
					sortLine = edit.pos.line;
				} else {
					sortLine = edit.end.line;
				}
				precedence = 0;
				break;
			case "append":
				sortLine = edit.pos ? edit.pos.line : fileLines.length + 1;
				precedence = 1;
				break;
			case "prepend":
				sortLine = edit.pos ? edit.pos.line : 0;
				precedence = 2;
				break;
		}
		return { edit, idx, sortLine, precedence };
	});

	annotated.sort((a, b) => b.sortLine - a.sortLine || a.precedence - b.precedence || a.idx - b.idx);

	warnings.push(...relocationNotes);

	// Apply edits bottom-up
	for (const { edit, idx } of annotated) {
		throwIfAborted(signal);
		switch (edit.op) {
			case "replace": {
				if (!edit.end) {
					const origLine = origLines.slice(edit.pos.line - 1, edit.pos.line);
					const newLines = edit.lines;
					if (origLine.length === newLines.length && origLine.every((line, i) => line === newLines[i])) {
						noopEdits.push({
							editIndex: idx,
							loc: `${edit.pos.line}#${edit.pos.hash}`,
							currentContent: origLine.join("\n"),
						});
						break;
					}
					fileLines.splice(edit.pos.line - 1, 1, ...newLines);
					track(edit.pos.line);
				} else {
					const count = edit.end.line - edit.pos.line + 1;
					const orig = origLines.slice(edit.pos.line - 1, edit.pos.line - 1 + count);

					// Noop check on range replaces
					if (orig.length === edit.lines.length && orig.every((line, i) => line === edit.lines[i])) {
						noopEdits.push({
							editIndex: idx,
							loc: `${edit.pos.line}#${edit.pos.hash}`,
							currentContent: orig.join("\n"),
						});
						break;
					}

					const newLines = [...edit.lines];
					// Auto-correct trailing duplicate: if the last replacement line duplicates
					// the next surviving line after the range, the model likely echoed the
					// boundary. Strip the duplicate to avoid doubled lines.
					const trailingReplacementLine = newLines[newLines.length - 1]?.trimEnd();
					const nextSurvivingLine = fileLines[edit.end.line]?.trimEnd();
					if (
						shouldAutocorrect(trailingReplacementLine, nextSurvivingLine) &&
						// Safety: only correct when end-line content differs from the duplicate.
						// If end already points to the boundary, matching next line is coincidence.
						fileLines[edit.end.line - 1]?.trimEnd() !== trailingReplacementLine
					) {
						newLines.pop();
						warnings.push(
							`Auto-corrected range replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}: removed trailing replacement line "${trailingReplacementLine}" that duplicated next surviving line`,
						);
					}
					// Auto-correct leading duplicate: if the first replacement line duplicates
					// the line before the range start, the model likely echoed the preceding
					// context. Strip the duplicate.
					const leadingReplacementLine = newLines[0]?.trimEnd();
					const prevSurvivingLine = fileLines[edit.pos.line - 2]?.trimEnd();
					if (
						shouldAutocorrect(leadingReplacementLine, prevSurvivingLine) &&
						// Safety: only correct when pos-line content differs from the duplicate.
						// If pos already points to the boundary, matching prev line is coincidence.
						fileLines[edit.pos.line - 1]?.trimEnd() !== leadingReplacementLine
					) {
						newLines.shift();
						warnings.push(
							`Auto-corrected range replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}: removed leading replacement line "${leadingReplacementLine}" that duplicated preceding surviving line`,
						);
					}
					fileLines.splice(edit.pos.line - 1, count, ...newLines);
					track(edit.pos.line);
				}
				break;
			}
			case "append": {
				const inserted = edit.lines;
				if (inserted.length === 0) {
					noopEdits.push({
						editIndex: idx,
						loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "EOF",
						currentContent: edit.pos ? origLines[edit.pos.line - 1] : "",
					});
					break;
				}
				if (edit.pos) {
					fileLines.splice(edit.pos.line, 0, ...inserted);
					track(edit.pos.line + 1);
				} else {
					if (fileLines.length === 1 && fileLines[0] === "") {
						fileLines.splice(0, 1, ...inserted);
						track(1);
					} else {
						fileLines.splice(fileLines.length, 0, ...inserted);
						track(fileLines.length - inserted.length + 1);
					}
				}
				break;
			}
			case "prepend": {
				const inserted = edit.lines;
				if (inserted.length === 0) {
					noopEdits.push({
						editIndex: idx,
						loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "BOF",
						currentContent: edit.pos ? origLines[edit.pos.line - 1] : "",
					});
					break;
				}
				if (edit.pos) {
					fileLines.splice(edit.pos.line - 1, 0, ...inserted);
					track(edit.pos.line);
				} else {
					if (fileLines.length === 1 && fileLines[0] === "") {
						fileLines.splice(0, 1, ...inserted);
					} else {
						fileLines.splice(0, 0, ...inserted);
					}
					track(1);
				}
				break;
			}
		}
	}

	let diff = Math.abs(fileLines.length - origLines.length);
	for (let i = 0; i < Math.min(fileLines.length, origLines.length); i++) {
		if (fileLines[i] !== origLines[i]) diff++;
	}
	if (diff > edits.length * 4) {
		warnings.push(`Edit changed ${diff} lines across ${edits.length} operations — verify no unintended reformatting.`);
	}

	return {
		content: fileLines.join("\n"),
		firstChangedLine: firstChanged,
		...(warnings.length ? { warnings } : {}),
		...(noopEdits.length ? { noopEdits } : {}),
	};

	function track(line: number): void {
		if (firstChanged === undefined || line < firstChanged) {
			firstChanged = line;
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Compact Diff Preview
// ═══════════════════════════════════════════════════════════════════════════

export interface CompactHashlineDiffPreview {
	preview: string;
	addedLines: number;
	removedLines: number;
}

export interface CompactHashlineDiffOptions {
	maxUnchangedRun?: number;
	maxAdditionRun?: number;
	maxDeletionRun?: number;
	maxOutputLines?: number;
}

const NUMBERED_DIFF_LINE_RE = /^([ +-])(\d+)\|(.*)$/;

type DiffRunKind = " " | "+" | "-" | "meta";
type DiffRun = { kind: DiffRunKind; lines: string[] };

function collapseFromStart(lines: string[], maxLines: number, label: string): string[] {
	if (lines.length <= maxLines) return lines;
	const hidden = lines.length - maxLines;
	return [...lines.slice(0, maxLines), ` ... ${hidden} more ${label} lines`];
}

function collapseFromEnd(lines: string[], maxLines: number, label: string): string[] {
	if (lines.length <= maxLines) return lines;
	const hidden = lines.length - maxLines;
	return [` ... ${hidden} more ${label} lines`, ...lines.slice(-maxLines)];
}

function collapseFromMiddle(lines: string[], maxLines: number, label: string): string[] {
	if (lines.length <= maxLines * 2) return lines;
	const hidden = lines.length - maxLines * 2;
	return [...lines.slice(0, maxLines), ` ... ${hidden} more ${label} lines`, ...lines.slice(-maxLines)];
}

function splitDiffRuns(lines: string[]): DiffRun[] {
	const runs: DiffRun[] = [];
	for (const line of lines) {
		const match = NUMBERED_DIFF_LINE_RE.exec(line);
		const kind = (match?.[1] as " " | "+" | "-" | undefined) ?? "meta";
		const prev = runs[runs.length - 1];
		if (prev && prev.kind === kind) {
			prev.lines.push(line);
			continue;
		}
		runs.push({ kind, lines: [line] });
	}
	return runs;
}

/**
 * Build a compact diff preview suitable for model-visible tool responses.
 *
 * Collapses long unchanged runs and long consecutive additions/removals so the
 * model sees the shape of edits without replaying full file content.
 */
export function buildCompactHashlineDiffPreview(
	diff: string,
	options: CompactHashlineDiffOptions = {},
): CompactHashlineDiffPreview {
	const maxUnchangedRun = options.maxUnchangedRun ?? 2;
	const maxAdditionRun = options.maxAdditionRun ?? 2;
	const maxDeletionRun = options.maxDeletionRun ?? 2;
	const maxOutputLines = options.maxOutputLines ?? 16;

	const inputLines = diff.length === 0 ? [] : diff.split("\n");
	const runs = splitDiffRuns(inputLines);

	const out: string[] = [];
	let addedLines = 0;
	let removedLines = 0;

	for (let runIndex = 0; runIndex < runs.length; runIndex++) {
		const run = runs[runIndex];
		switch (run.kind) {
			case "meta":
				out.push(...run.lines);
				break;
			case "+":
				addedLines += run.lines.length;
				out.push(...collapseFromStart(run.lines, maxAdditionRun, "added"));
				break;
			case "-":
				removedLines += run.lines.length;
				out.push(...collapseFromStart(run.lines, maxDeletionRun, "removed"));
				break;
			case " ":
				if (runIndex === 0) {
					out.push(...collapseFromEnd(run.lines, maxUnchangedRun, "unchanged"));
					break;
				}
				if (runIndex === runs.length - 1) {
					out.push(...collapseFromStart(run.lines, maxUnchangedRun, "unchanged"));
					break;
				}
				out.push(...collapseFromMiddle(run.lines, maxUnchangedRun, "unchanged"));
				break;
		}
	}

	if (out.length > maxOutputLines) {
		const hidden = out.length - maxOutputLines;
		return {
			preview: [...out.slice(0, maxOutputLines), ` ... ${hidden} more preview lines`].join("\n"),
			addedLines,
			removedLines,
		};
	}

	return { preview: out.join("\n"), addedLines, removedLines };
}