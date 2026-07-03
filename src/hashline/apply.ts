/**
 * Apply engine — anchor validation, edit-span resolution, assembly.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 */

import { throwIfAborted } from "../runtime";
import {
	RE_SIGNIFICANT,
	computeLineHash,
	normalizeHashInput,
	computeHashFromContext,
	isFuzzyEquivalentLine,
} from "./hash";
import {
	HASHLINE_BARE_PREFIX_RE,
	type Anchor,
	type HashlineEdit,
} from "./parse";
import { computeChangedLineRange } from "./format";

interface HashMismatch {
	line: number;
	expected: string;
	actual: string;
	textHint?: string;
}

interface NoopEdit {
	editIndex: number;
	loc: string;
	currentContent: string;
}

// ─── Mismatch formatting ────────────────────────────────────────────────

// Max total candidates across all anchors before we stop listing per-anchor candidates.
const CANDIDATE_TOTAL_LIMIT = 8;
// Max candidates per individual stale anchor.
const CANDIDATE_PER_ANCHOR_LIMIT = 3;

function formatMismatchError(
	mismatches: HashMismatch[],
	fileLines: string[],
	retryLines: ReadonlySet<number> = new Set<number>(),
): string {
	const retryLineSet = new Set<number>(retryLines);
	for (const m of mismatches) {
		retryLineSet.add(m.line);
	}

	const displayLines = new Set<number>();
	for (const m of mismatches) {
		for (
			let i = Math.max(1, m.line - 2);
			i <= Math.min(fileLines.length, m.line + 2);
			i++
		) {
			displayLines.add(i);
		}
	}
	for (const line of retryLineSet) {
		displayLines.add(line);
	}

	const sorted = [...displayLines].sort((a, b) => a - b);
	const maxDisplayLine = sorted[sorted.length - 1] ?? 1;
	const lineNumberWidth = String(maxDisplayLine).length;
	const staleRefs = mismatches
		.map((mismatch) => `${mismatch.line}#${mismatch.expected}`)
		.join(", ");
	const out: string[] = [
		`[E_STALE_ANCHOR] ${mismatches.length} stale anchor${mismatches.length > 1 ? "s" : ""}. Retry with the >>> LINE#HASH lines below; keep both endpoints for range replaces.`,
		`Stale refs: ${staleRefs}`,
		"",
	];

	let prev = -1;
	for (const num of sorted) {
		if (prev !== -1 && num > prev + 1) out.push("    ...");
		prev = num;
		const content = fileLines[num - 1];
		const hash = computeLineHash(fileLines, num - 1);
		const prefix = `${String(num).padStart(lineNumberWidth, " ")}#${hash}`;
		out.push(
			retryLineSet.has(num)
				? `>>> ${prefix}:${content}`
				: `    ${prefix}:${content}`,
		);
	}

	// Scan for fuzzy-match candidates for stale anchors that carry a textHint.
	// Runs only on the error path after all mismatches are collected (O(n×mismatches), acceptable).
	const hintedMismatches = mismatches.filter((m) => m.textHint !== undefined);
	if (hintedMismatches.length > 0) {
		// Per-anchor candidate lists: 1-based line numbers outside the display window.
		type AnchorCandidates =
			| { kind: "list"; lines: number[] }
			| { kind: "overflow"; count: number };

		const perAnchor: { mismatch: HashMismatch; result: AnchorCandidates }[] =
			[];
		let totalCandidates = 0;

		for (const m of hintedMismatches) {
			const hint = m.textHint!;
			const matches: number[] = [];
			for (let i = 0; i < fileLines.length; i++) {
				const oneBasedLine = i + 1;
				// Skip lines already shown in the display window.
				if (displayLines.has(oneBasedLine)) continue;
				if (isFuzzyEquivalentLine(hint, fileLines[i]!)) {
					matches.push(oneBasedLine);
				}
			}

			if (totalCandidates + matches.length > CANDIDATE_TOTAL_LIMIT) {
				// Total budget exhausted: show overflow message for this anchor.
				perAnchor.push({
					mismatch: m,
					result: { kind: "overflow", count: matches.length },
				});
			} else if (matches.length > CANDIDATE_PER_ANCHOR_LIMIT) {
				// Per-anchor limit exceeded before total: show overflow message.
				totalCandidates += matches.length;
				perAnchor.push({
					mismatch: m,
					result: { kind: "overflow", count: matches.length },
				});
			} else {
				totalCandidates += matches.length;
				perAnchor.push({
					mismatch: m,
					result: { kind: "list", lines: matches },
				});
			}
		}

		// Only emit the "Did you mean" section when at least one anchor has candidates.
		const hasAnyCandidates = perAnchor.some(
			({ result }) =>
				result.kind === "overflow" ||
				(result.kind === "list" && result.lines.length > 0),
		);
		if (hasAnyCandidates) {
			out.push("");
			out.push(
				"Did you mean (content-matched candidates for stale anchors):",
			);
			for (const { mismatch, result } of perAnchor) {
				if (result.kind === "overflow") {
					out.push(
						`  ${result.count} similar lines found for ${mismatch.line}#${mismatch.expected} — re-read to disambiguate`,
					);
				} else {
					for (const lineNum of result.lines) {
						const freshHash = computeLineHash(fileLines, lineNum - 1);
						const lineContent = fileLines[lineNum - 1]!;
						out.push(`  ${lineNum}#${freshHash}:${lineContent}   ← for stale ${mismatch.line}#${mismatch.expected}`);
					}
				}
			}
		}
	}

	return out.join("\n");
}

// ─── Content preprocessing ─────────────────────────────────────────────────────

function maybeWarnSuspiciousUnicodeEscapePlaceholder(
	edits: HashlineEdit[],
	warnings: string[],
): void {
	for (const edit of edits) {
		if (edit.op === "replace_text") {
			continue;
		}
		if (edit.lines.some((line) => /\\uDDDD/i.test(line))) {
			warnings.push(
				"Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
			);
		}
	}
}

/**
 * Warn on edit content that may carry a hash the model copied out of `read`
 * output instead of literal file text (issue #24, e.g.
 * `lines: ["KK:### heading"]`). Companion to `assertNoDisplayPrefixes`, which
 * handles the unambiguous full `LINE#HASH:` form on shape alone.
 *
 * Bare `HH:` prefixes are ambiguous: the hash is only 8 bits, and legitimate
 * file content can contain short keys / abbreviations such as `TS:` or `PR:`.
 * Therefore this detector never rejects on bare shape or hash-set membership;
 * it surfaces a warning and preserves strict semantics by writing content
 * verbatim instead of silently patching it.
 */
function warnBareHashPrefixLines(
	edits: HashlineEdit[],
	fileLines: string[],
	warnings: string[],
): void {
	// Collect bare-prefix suspects up front: regex only. Almost every edit has
	// none, so this lets the common path bail before paying for file hashes.
	const suspects: { line: string; hash: string }[] = [];
	for (const edit of edits) {
		if (edit.op === "replace_text") continue;
		for (const line of edit.lines) {
			const match = line.match(HASHLINE_BARE_PREFIX_RE);
			if (match) suspects.push({ line, hash: match[1]! });
		}
	}
	if (suspects.length === 0) return;

	const fileHashSet = new Set(
		fileLines.map((_line, i) => computeLineHash(fileLines, i)),
	);
	const matchCount = suspects.filter(({ hash }) =>
		fileHashSet.has(hash),
	).length;

	if (matchCount > 0 || suspects.length >= 2) {
		const matchHint =
			matchCount > 0
				? ` ${matchCount} prefix(es) match existing line hashes in this file.`
				: "";
		warnings.push(
			`${suspects.length} edit line(s) start with a 2-char hash and ":" (e.g. ${JSON.stringify(suspects[0]!.line)}).${matchHint} If you copied these from "read" output, they are hash prefixes, not file content — resend "lines" as literal content.`,
		);
	}
}


type ResolvedEditSpan = {
	kind: "replace" | "insert";
	index: number;
	label: string;
	start: number;
	end: number;
	replacement: string;
	boundary?: number;
	insertMode?: "append-empty-origin" | "prepend-empty-origin";
};

type LineIndex = {
	fileLines: string[];
	lineStarts: number[];
	hasTerminalNewline: boolean;
};

function buildLineIndex(content: string): LineIndex {
	const fileLines = content.split("\n");
	const lineStarts: number[] = [];
	let offset = 0;

	for (let index = 0; index < fileLines.length; index++) {
		lineStarts.push(offset);
		offset += fileLines[index]!.length;
		if (index < fileLines.length - 1) {
			offset += 1;
		}
	}

	return {
		fileLines,
		lineStarts,
		hasTerminalNewline: content.endsWith("\n"),
	};
}

function assertDoesNotEmptyFile(originalContent: string, result: string): void {
	if (originalContent.length > 0 && result.length === 0) {
		throw new Error(
			"[E_WOULD_EMPTY] Refusing to empty a non-empty file through edit. If intentional, use the write tool or bash.",
		);
	}
}

function previewText(text: string): string {
	const compact = text.replaceAll("\n", "\\n");
	return compact.length > 32 ? `${compact.slice(0, 29)}...` : compact;
}

function describeEdit(edit: HashlineEdit): string {
	switch (edit.op) {
		case "replace":
			return edit.end
				? `replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}`
				: `replace ${edit.pos.line}#${edit.pos.hash}`;
		case "append":
			return edit.pos
				? `append after ${edit.pos.line}#${edit.pos.hash}`
				: "append at EOF";
		case "prepend":
			return edit.pos
				? `prepend before ${edit.pos.line}#${edit.pos.hash}`
				: "prepend at BOF";
		case "replace_text":
			return `replace_text "${previewText(edit.oldText)}"`;
	}
}

function throwEditConflict(
	left: { index: number; label: string },
	right: { index: number; label: string },
	reason: string,
): never {
	throw new Error(
		`[E_EDIT_CONFLICT] Conflicting edits in a single request: edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}. Merge them into one non-overlapping change or split the request.`,
	);
}

function computeInsertionBoundary(
	edit: Extract<HashlineEdit, { op: "append" | "prepend" }>,
	lineIndex: LineIndex,
): number {
	if (edit.op === "prepend") {
		return edit.pos ? edit.pos.line - 1 : 0;
	}

	// append
	const fileLineCount = lineIndex.fileLines.length;
	const eofBoundary =
		lineIndex.hasTerminalNewline && fileLineCount > 0
			? fileLineCount - 1
			: fileLineCount;
	if (!edit.pos) {
		return eofBoundary;
	}
	if (lineIndex.hasTerminalNewline && edit.pos.line === fileLineCount) {
		return eofBoundary;
	}
	return edit.pos.line;
}

function findExactUniqueTextMatch(
	content: string,
	oldText: string,
): { start: number; end: number } {
	if (oldText.length === 0) {
		throw new Error("[E_BAD_OP] replace_text requires non-empty oldText.");
	}

	const matches: number[] = [];
	let from = 0;
	while (from <= content.length - oldText.length) {
		const index = content.indexOf(oldText, from);
		if (index === -1) {
			break;
		}
		matches.push(index);
		from = index + 1;
	}

	for (let index = 1; index < matches.length; index++) {
		if (matches[index]! - matches[index - 1]! < oldText.length) {
			throw new Error(
				"[E_MULTI_MATCH] replace_text found overlapping exact matches; re-read and use hashline edits.",
			);
		}
	}

	if (matches.length === 0) {
		throw new Error(
			"[E_NO_MATCH] replace_text found no exact unique match in the current file.",
		);
	}

	if (matches.length > 1) {
		throw new Error(
			"[E_MULTI_MATCH] replace_text found multiple exact matches in the current file. Re-read and use hashline edits.",
		);
	}

	const start = matches[0]!;
	return {
		start,
		end: start + oldText.length,
	};
}

function resolveEditToSpan(
	edit: HashlineEdit,
	index: number,
	content: string,
	lineIndex: LineIndex,
	noopEdits: NoopEdit[],
): ResolvedEditSpan | null {
	const { fileLines, lineStarts, hasTerminalNewline } = lineIndex;

	switch (edit.op) {
		case "replace": {
			const startLine = edit.pos.line;
			const endLine = edit.end?.line ?? edit.pos.line;
			const originalLines = fileLines.slice(startLine - 1, endLine);
			if (
				originalLines.length === edit.lines.length &&
				originalLines.every((line, lineIndex) => line === edit.lines[lineIndex])
			) {
				noopEdits.push({
					editIndex: index,
					loc: `${edit.pos.line}#${edit.pos.hash}`,
					currentContent: originalLines.join("\n"),
				});
				return null;
			}

			if (edit.lines.length > 0) {
				return {
					kind: "replace",
					index,
					label: describeEdit(edit),
					start: lineStarts[startLine - 1]!,
					end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
					replacement: edit.lines.join("\n"),
				};
			}

			if (startLine === 1 && endLine === fileLines.length) {
				return {
					kind: "replace",
					index,
					label: describeEdit(edit),
					start: 0,
					end: content.length,
					replacement: "",
				};
			}

			if (endLine < fileLines.length) {
				return {
					kind: "replace",
					index,
					label: describeEdit(edit),
					start: lineStarts[startLine - 1]!,
					end: lineStarts[endLine]!,
					replacement: "",
				};
			}

			return {
				kind: "replace",
				index,
				label: describeEdit(edit),
				start: Math.max(0, lineStarts[startLine - 1]! - 1),
				end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
				replacement: "",
			};
		}
		case "append": {
			// Empty `lines` cannot reach here: validateAnchorEdits throws E_BAD_OP
			// for empty append/prepend payloads before spans are resolved.
			const insertedText = edit.lines.join("\n");
			if (content.length === 0) {
				return {
					kind: "insert",
					index,
					label: describeEdit(edit),
					start: 0,
					end: 0,
					replacement: insertedText,
					boundary: computeInsertionBoundary(edit, lineIndex),
					insertMode: "append-empty-origin",
				};
			}

			if (!edit.pos) {
				return {
					kind: "insert",
					index,
					label: describeEdit(edit),
					start: content.length,
					end: content.length,
					replacement: hasTerminalNewline
						? `${insertedText}\n`
						: `\n${insertedText}`,
					boundary: computeInsertionBoundary(edit, lineIndex),
				};
			}

			const isSentinelAppend =
				hasTerminalNewline && edit.pos.line === fileLines.length;
			return {
				kind: "insert",
				index,
				label: describeEdit(edit),
				start: isSentinelAppend
					? content.length
					: lineStarts[edit.pos.line - 1]! +
						fileLines[edit.pos.line - 1]!.length,
				end: isSentinelAppend
					? content.length
					: lineStarts[edit.pos.line - 1]! +
						fileLines[edit.pos.line - 1]!.length,
				replacement: isSentinelAppend
					? `${insertedText}\n`
					: `\n${insertedText}`,
				boundary: computeInsertionBoundary(edit, lineIndex),
			};
		}
		case "prepend": {
			const insertedText = edit.lines.join("\n");
			const start = edit.pos ? lineStarts[edit.pos.line - 1]! : 0;
			return {
				kind: "insert",
				index,
				label: describeEdit(edit),
				start,
				end: start,
				replacement: content.length === 0 ? insertedText : `${insertedText}\n`,
				boundary: computeInsertionBoundary(edit, lineIndex),
				...(content.length === 0
					? { insertMode: "prepend-empty-origin" as const }
					: {}),
			};
		}
		case "replace_text": {
			const match = findExactUniqueTextMatch(content, edit.oldText);
			if (edit.oldText === edit.newText) {
				noopEdits.push({
					editIndex: index,
					loc: `replace_text "${previewText(edit.oldText)}"`,
					currentContent: edit.oldText,
				});
				return null;
			}

			return {
				kind: "replace",
				index,
				label: describeEdit(edit),
				start: match.start,
				end: match.end,
				replacement: edit.newText,
			};
		}
	}
}

function assertNoConflictingSpans(spans: ResolvedEditSpan[]): void {
	for (let leftIndex = 0; leftIndex < spans.length; leftIndex++) {
		const left = spans[leftIndex]!;
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < spans.length;
			rightIndex++
		) {
			const right = spans[rightIndex]!;

			if (left.kind === "insert" && right.kind === "insert") {
				if (left.boundary === right.boundary) {
					throwEditConflict(left, right, "target the same insertion boundary");
				}
				continue;
			}

			if (left.kind === "replace" && right.kind === "replace") {
				if (left.start < right.end && right.start < left.end) {
					throwEditConflict(
						left,
						right,
						"overlap on the same original line range",
					);
				}
				continue;
			}

			const replaceSpan = left.kind === "replace" ? left : right;
			const insertSpan = left.kind === "insert" ? left : right;
			if (
				insertSpan.start >= replaceSpan.start &&
				insertSpan.start < replaceSpan.end
			) {
				throwEditConflict(
					left,
					right,
					"cannot be applied together because one inserts inside a replaced original range",
				);
			}
		}
	}
}

/**
 * Warn when an append or prepend payload exactly matches the lines already
 * adjacent at the insertion point — indicates a duplicate insert after a
 * previous successful call. Never blocks the edit (non-fatal warning).
 */
function warnDuplicateInsert(
	op: "append" | "prepend",
	edit: Extract<HashlineEdit, { op: "append" | "prepend" }>,
	lineIndex: LineIndex,
	warnings: string[],
): void {
	const { fileLines, hasTerminalNewline } = lineIndex;
	const insertLines = edit.lines;
	const n = insertLines.length;
	if (n === 0) return;

	// Exclude the trailing sentinel element produced by split("\n") on a
	// newline-terminated file so adjacency comparisons use visible lines only.
	const visibleLineCount = hasTerminalNewline
		? fileLines.length - 1
		: fileLines.length;

	// Determine the slice of existing file lines to compare against.
	let compareStart: number; // 0-based index into fileLines, inclusive
	let compareEnd: number;   // 0-based index into fileLines, exclusive

	if (op === "append") {
		if (edit.pos) {
			// After pos.line: compare fileLines[pos.line .. pos.line + n - 1].
			compareStart = edit.pos.line;
			compareEnd = compareStart + n;
		} else {
			// EOF append: compare the last n visible lines (sentinel excluded).
			compareStart = visibleLineCount - n;
			compareEnd = visibleLineCount;
		}
	} else {
		// prepend
		if (edit.pos) {
			// Before pos.line: compare fileLines[pos.line - 1 - n .. pos.line - 2].
			compareEnd = edit.pos.line - 1;
			compareStart = compareEnd - n;
		} else {
			// BOF prepend: compare first n lines.
			compareStart = 0;
			compareEnd = n;
		}
	}

	// Out-of-bounds relative to visible lines: cannot determine adjacency, skip.
	// Using visibleLineCount as the ceiling prevents comparing against the sentinel.
	if (compareStart < 0 || compareEnd > visibleLineCount) return;

	const adjacentLines = fileLines.slice(compareStart, compareEnd);
	if (adjacentLines.length !== n) return;

	// All lines must match after trim; at least one must be significant.
	const allMatch = insertLines.every(
		(line, i) => line.trim() === adjacentLines[i]!.trim(),
	);
	if (!allMatch) return;

	const hasSignificant = insertLines.some((line) => RE_SIGNIFICANT.test(line));
	if (!hasSignificant) return;

	warnings.push(
		`Potential duplicate insert at ${describeEdit(edit)}: the inserted lines are identical to the lines already adjacent to the insertion point. If a previous edit call already applied this insert, do not resend it.`,
	);
}

/**
 * Validate anchor hashes against the current file content.
 *
 * Checks every anchor in every edit for hash match (or fuzzy match when
 * textHint is available). Returns mismatches for stale-anchor retry and
 * appends boundary / single-anchor-range warnings to the shared warnings
 * array. On range-OOB, throws immediately.
 */
function validateAnchorEdits(
	edits: HashlineEdit[],
	lineIndex: LineIndex,
	warnings: string[],
	signal: AbortSignal | undefined,
): { mismatches: HashMismatch[]; retryLines: Set<number> } {
	const mismatches: HashMismatch[] = [];
	const retryLines = new Set<number>();
	const acceptedFuzzyRefs = new Set<string>();

	function validate(ref: Anchor): boolean {
		if (ref.line < 1 || ref.line > lineIndex.fileLines.length) {
			throw new Error(
				`[E_RANGE_OOB] Line ${ref.line} does not exist (file has ${lineIndex.fileLines.length} lines)`,
			);
		}
		const line = lineIndex.fileLines[ref.line - 1]!;
		const actual = computeLineHash(lineIndex.fileLines, ref.line - 1);
		if (actual === ref.hash) {
			// QUESTIONING: hash matches but textHint says otherwise → treat as stale (anti-collision guard).
			// Guards the 1/256 collision case: a model that copied "LINE#HASH:content" gets the content
			// cross-checked for free. If the hint clearly differs from the actual line, the anchor is stale.
			if (ref.textHint !== undefined && !isFuzzyEquivalentLine(ref.textHint, line)) {
				mismatches.push({ line: ref.line, expected: ref.hash, actual, textHint: ref.textHint });
				retryLines.add(ref.line);
				return false;
			}
			return true;
		}
		if (ref.textHint !== undefined) {
			// FORGIVENESS: hash mismatched, but recompute using the hint's content in the current file's
			// neighbor context. If that matches ref.hash and the hint fuzzy-matches the actual line, accept.
			const prevLine = normalizeHashInput(ref.line > 1 ? lineIndex.fileLines[ref.line - 2]! : "");
			const nextLine = normalizeHashInput(ref.line < lineIndex.fileLines.length ? lineIndex.fileLines[ref.line]! : "");
			const hintedHash = computeHashFromContext(prevLine, normalizeHashInput(ref.textHint), nextLine);
			if (hintedHash === ref.hash && isFuzzyEquivalentLine(ref.textHint, line)) {
				const key = `${ref.line}:${ref.hash}:${ref.textHint}`;
				if (!acceptedFuzzyRefs.has(key)) {
					acceptedFuzzyRefs.add(key);
					warnings.push(
						`Accepted fuzzy anchor validation at line ${ref.line}: exact hash mismatched, but the copied line content still matched after whitespace/Unicode normalization.`,
					);
				}
				return true;
			}
		}
		mismatches.push({ line: ref.line, expected: ref.hash, actual, textHint: ref.textHint });
		retryLines.add(ref.line);
		return false;
	}

	for (const edit of edits) {
		throwIfAborted(signal);
		switch (edit.op) {
			case "replace": {
				if (edit.end) {
					if (edit.pos.line > edit.end.line) {
						throw new Error(
							`[E_BAD_OP] Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`,
						);
					}
					const startOk = validate(edit.pos);
					const endOk = validate(edit.end);
					if (!startOk && endOk) {
						retryLines.add(edit.end.line);
					}
					if (startOk && !endOk) {
						retryLines.add(edit.pos.line);
					}
					if (!startOk || !endOk) continue;
				} else if (!validate(edit.pos)) {
					continue;
				}
				const endLine = edit.end?.line ?? edit.pos.line;
				if (!edit.end && edit.lines.length > 1) {
					warnings.push(
						`Single-anchor replace at ${describeEdit(edit)} swapped only line ${edit.pos.line}, but you supplied ${edit.lines.length} replacement lines. If you meant to replace a range, add end. If you meant to expand one line into many, ignore this.`,
					);
				}
				const nextLine = lineIndex.fileLines[endLine];
				const replacementLastLine = edit.lines.at(-1)?.trim();
				if (
					nextLine !== undefined &&
					replacementLastLine &&
					RE_SIGNIFICANT.test(replacementLastLine) &&
					replacementLastLine === nextLine.trim()
				) {
					warnings.push(
						`Potential boundary duplication after ${describeEdit(edit)}: the replacement ends with a line that matches the next surviving line after trim.`,
					);
				}
				const prevLine = lineIndex.fileLines[edit.pos.line - 2];
				const replacementFirstLine = edit.lines[0]?.trim();
				if (
					prevLine !== undefined &&
					replacementFirstLine &&
					RE_SIGNIFICANT.test(replacementFirstLine) &&
					replacementFirstLine === prevLine.trim()
				) {
					warnings.push(
						`Potential boundary duplication before ${describeEdit(edit)}: the replacement starts with a line that matches the preceding surviving line after trim.`,
					);
				}
				break;
			}
			case "append": {
				if (edit.pos && !validate(edit.pos)) continue;
				if (edit.lines.length === 0) {
					throw new Error(
						"[E_BAD_OP] Append with empty lines payload. Provide content to insert or remove the edit.",
					);
				}
				// Warn when the inserted lines are identical to the lines already adjacent
				// at the insertion point — symptom of a duplicate insert after a prior success.
				warnDuplicateInsert("append", edit, lineIndex, warnings);
				break;
			}
			case "prepend": {
				if (edit.pos && !validate(edit.pos)) continue;
				if (edit.lines.length === 0) {
					throw new Error(
						"[E_BAD_OP] Prepend with empty lines payload. Provide content to insert or remove the edit.",
					);
				}
				// Same duplicate-insert guard for prepend.
				warnDuplicateInsert("prepend", edit, lineIndex, warnings);
				break;
			}
			case "replace_text":
				break;
		}
	}

	return { mismatches, retryLines };
}

/**
 * Resolve validated edits into ordered, conflict-free character-level spans.
 *
 * Each edit is mapped through resolveEditToSpan (which may produce a noop),
 * duplicate spans are deduplicated, conflicts are rejected, and the remaining
 * spans are sorted back-to-front for safe in-place assembly.
 */
function resolveEditSpans(
	edits: HashlineEdit[],
	content: string,
	lineIndex: LineIndex,
	noopEdits: NoopEdit[],
	signal: AbortSignal | undefined,
): ResolvedEditSpan[] {
	const seenSpanKeys = new Set<string>();
	const resolvedSpans: ResolvedEditSpan[] = [];
	for (const [index, edit] of edits.entries()) {
		throwIfAborted(signal);
		const span = resolveEditToSpan(edit, index, content, lineIndex, noopEdits);
		if (!span) {
			continue;
		}

		const spanKey =
			span.kind === "insert"
				? `insert:${span.boundary}:${span.replacement}`
				: `replace:${span.start}:${span.end}:${span.replacement}`;
		if (seenSpanKeys.has(spanKey)) {
			continue;
		}
		seenSpanKeys.add(spanKey);
		resolvedSpans.push(span);
	}

	assertNoConflictingSpans(resolvedSpans);

	return [...resolvedSpans].sort((left, right) => {
		if (right.end !== left.end) {
			return right.end - left.end;
		}
		if (left.kind !== right.kind) {
			return left.kind === "replace" ? -1 : 1;
		}
		if (left.kind === "insert" && right.kind === "insert") {
			return (
				(right.boundary ?? -1) - (left.boundary ?? -1) ||
				left.index - right.index
			);
		}
		return left.index - right.index;
	});
}

/**
 * Apply ordered spans to content in reverse (back-to-front) order so earlier
 * spans' offsets stay valid.
 */
function assembleEditResult(
	content: string,
	spans: ResolvedEditSpan[],
	signal: AbortSignal | undefined,
): string {
	let result = content;
	for (const span of spans) {
		throwIfAborted(signal);
		const replacement =
			span.insertMode === "append-empty-origin"
				? result.length === 0
					? span.replacement
					: `\n${span.replacement}`
				: span.insertMode === "prepend-empty-origin"
					? result.length === 0
						? span.replacement
						: `${span.replacement}\n`
					: span.replacement;
		result = result.slice(0, span.start) + replacement + result.slice(span.end);
	}
	return result;
}

/**
 * Apply hashline-anchored edits to file content.
 *
 * Three-phase pipeline:
 *   1. validateAnchorEdits — check hash matches, collect warnings + mismatches
 *   2. resolveEditSpans   — map edits to character spans, dedup, conflict-detect, sort
 *   3. assembleEditResult — apply spans back-to-front, compute changed range
 */
export function applyHashlineEdits(
	content: string,
	edits: HashlineEdit[],
	signal?: AbortSignal,
): {
	content: string;
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: NoopEdit[];
} {
	throwIfAborted(signal);
	if (!edits.length)
		return { content, firstChangedLine: undefined, lastChangedLine: undefined };

	const workingEdits = edits;
	const lineIndex = buildLineIndex(content);
	const noopEdits: NoopEdit[] = [];
	const warnings: string[] = [];

	// Phase 1: validate anchors
	const { mismatches, retryLines } = validateAnchorEdits(
		workingEdits,
		lineIndex,
		warnings,
		signal,
	);
	if (mismatches.length) {
		throw new Error(
			formatMismatchError(mismatches, lineIndex.fileLines, retryLines),
		);
	}

	warnBareHashPrefixLines(workingEdits, lineIndex.fileLines, warnings);
	maybeWarnSuspiciousUnicodeEscapePlaceholder(workingEdits, warnings);

	// Phase 2: resolve edits to ordered spans
	const orderedSpans = resolveEditSpans(
		workingEdits,
		content,
		lineIndex,
		noopEdits,
		signal,
	);

	// Phase 3: assemble result
	const result = assembleEditResult(content, orderedSpans, signal);
	assertDoesNotEmptyFile(content, result);
	const changedRange = computeChangedLineRange(content, result);

	return {
		content: result,
		firstChangedLine: changedRange?.firstChangedLine,
		lastChangedLine: changedRange?.lastChangedLine,
		...(warnings.length ? { warnings } : {}),
		...(noopEdits.length ? { noopEdits } : {}),
	};
}
