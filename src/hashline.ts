/**
 * Hashline engine — hash-anchored line editing.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 */

import * as XXH from "xxhashjs";
import { throwIfAborted } from "./runtime";

// ─── Types ──────────────────────────────────────────────────────────────

export type HashlineEditItem =
	| { set_line: { anchor: string; new_text: string } }
	| { replace_lines: { start_anchor: string; end_anchor: string; new_text: string } }
	| { insert_after: { anchor: string; text: string } }
	| { replace: { old_text: string; new_text: string; all?: boolean } };

interface HashMismatch {
	line: number;
	expected: string;
	actual: string;
}

type ParsedRef = { line: number; hash: string };

type ParsedSpec =
	| { kind: "single"; ref: ParsedRef }
	| { kind: "range"; start: ParsedRef; end: ParsedRef }
	| { kind: "insertAfter"; after: ParsedRef };

interface ParsedEdit {
	spec: ParsedSpec;
	dstLines: string[];
}

interface NoopEdit {
	editIndex: number;
	loc: string;
	currentContent: string;
}

// ─── Hash computation ───────────────────────────────────────────────────

const HASH_LEN = 2;
const RADIX = 16;
const HASH_MOD = RADIX ** HASH_LEN;
const DICT = Array.from({ length: HASH_MOD }, (_, i) => i.toString(RADIX).padStart(HASH_LEN, "0"));

const HASHLINE_PREFIX_RE = /^\d+:[0-9a-zA-Z]{1,16}\|/;
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
	return DICT[xxh32(line, seed) % HASH_MOD];
}

// ─── Parsing ────────────────────────────────────────────────────────────

export function parseLineRef(ref: string): { line: number; hash: string } {
	const cleaned = ref.replace(/\|.*$/, "").replace(/ {2}.*$/, "").trim();
	const normalized = cleaned.replace(/\s*:\s*/, ":");
	const match = normalized.match(new RegExp(`^(\\d+):([0-9a-fA-F]{${HASH_LEN}})$`));
	if (!match) throw new Error(`Invalid line reference "${ref}". Expected "LINE:HASH" (e.g. "5:ab").`);
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
		`${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Auto-relocation checks only within ±${HASH_RELOCATION_WINDOW} lines of each anchor. Use the updated LINE:HASH references shown below (>>> marks changed lines).`,
		"",
	];

	let prev = -1;
	for (const num of sorted) {
		if (prev !== -1 && num > prev + 1) out.push("    ...");
		prev = num;
		const content = fileLines[num - 1];
		const hash = computeLineHash(num, content);
		const prefix = `${num}:${hash}`;
		out.push(mismatchSet.has(num) ? `>>> ${prefix}|${content}` : `    ${prefix}|${content}`);
	}

	return out.join("\n");
}

// ─── DST preprocessing helpers ──────────────────────────────────────────

function splitDst(dst: string): string[] {
	return dst === "" ? [] : dst.split("\n");
}

function stripNewLinePrefixes(lines: string[]): string[] {
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

// ─── Edit parser ────────────────────────────────────────────────────────

function parseHashlineEditItem(edit: HashlineEditItem): ParsedEdit {
	if ("set_line" in edit) {
		return {
			spec: { kind: "single", ref: parseLineRef(edit.set_line.anchor) },
			dstLines: stripNewLinePrefixes(splitDst(edit.set_line.new_text)),
		};
	}
	if ("replace_lines" in edit) {
		const start = parseLineRef(edit.replace_lines.start_anchor);
		const end = parseLineRef(edit.replace_lines.end_anchor);
		return {
			spec: start.line === end.line ? { kind: "single", ref: start } : { kind: "range", start, end },
			dstLines: stripNewLinePrefixes(splitDst(edit.replace_lines.new_text)),
		};
	}
	if ("insert_after" in edit) {
		return {
			spec: { kind: "insertAfter", after: parseLineRef(edit.insert_after.anchor) },
			dstLines: stripNewLinePrefixes(splitDst(edit.insert_after.text ?? "")),
		};
	}
	throw new Error("replace edits are applied separately");
}

// ─── Main edit engine ───────────────────────────────────────────────────

export function applyHashlineEdits(
	content: string,
	edits: HashlineEditItem[],
	signal?: AbortSignal,
): { content: string; firstChangedLine: number | undefined; warnings?: string[]; noopEdits?: NoopEdit[] } {
	throwIfAborted(signal);
	if (!edits.length) return { content, firstChangedLine: undefined };

	const fileLines = content.split("\n");
	const origLines = [...fileLines];
	let firstChanged: number | undefined;
	const noopEdits: NoopEdit[] = [];

	const parsed: (ParsedEdit & { idx: number })[] = edits.map((edit, idx) => ({
		...parseHashlineEditItem(edit),
		idx,
	}));

	// Build hash index for local-window relocation
	const lineHashes: string[] = [];
	const hashToLines = new Map<string, number[]>();
	for (let i = 0; i < fileLines.length; i++) {
		throwIfAborted(signal);
		const lineNumber = i + 1;
		const h = computeLineHash(lineNumber, fileLines[i]);
		lineHashes.push(h);
		const lines = hashToLines.get(h);
		if (lines) lines.push(lineNumber);
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

	function validate(ref: ParsedRef): boolean {
		if (ref.line < 1 || ref.line > fileLines.length)
			throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
		const expected = ref.hash.toLowerCase();
		const originalLine = ref.line;
		const actual = lineHashes[originalLine - 1];
		if (actual === expected) return true;
		const relocated = findRelocationLine(expected, originalLine);
		if (relocated !== undefined) {
			ref.line = relocated;
			relocationNotes.add(
				`Auto-relocated anchor ${originalLine}:${ref.hash} -> ${relocated}:${ref.hash} (window ±${HASH_RELOCATION_WINDOW}).`,
			);
			return true;
		}
		mismatches.push({ line: originalLine, expected: ref.hash, actual });
		return false;
	}

	for (const { spec } of parsed) {
		throwIfAborted(signal);
		if (spec.kind === "single") {
			validate(spec.ref);
		} else if (spec.kind === "insertAfter") {
			validate(spec.after);
		} else {
			// Range: validate start > end before relocation
			if (spec.start.line > spec.end.line) {
				throw new Error(`Range start line ${spec.start.line} must be <= end line ${spec.end.line}`);
			}

			const originalStart = spec.start.line;
			const originalEnd = spec.end.line;
			const originalCount = originalEnd - originalStart + 1;

			const startOk = validate(spec.start);
			const endOk = validate(spec.end);

			// If both validated but relocation invalidated the range, revert and report mismatch
			if (startOk && endOk) {
				const relocatedCount = spec.end.line - spec.start.line + 1;
				const invalidRange = spec.start.line > spec.end.line;
				const scopeChanged = relocatedCount !== originalCount;
				if (invalidRange || scopeChanged) {
					spec.start.line = originalStart;
					spec.end.line = originalEnd;
					mismatches.push(
						{ line: originalStart, expected: spec.start.hash, actual: lineHashes[originalStart - 1] },
						{ line: originalEnd, expected: spec.end.hash, actual: lineHashes[originalEnd - 1] },
					);
				}
			}
		}
	}
	if (mismatches.length) throw new Error(formatMismatchError(mismatches, fileLines));

	// Deduplicate identical edits
	const seen = new Map<string, number>();
	const dupes = new Set<number>();
	for (let i = 0; i < parsed.length; i++) {
		throwIfAborted(signal);
		const p = parsed[i];
		const lk =
			p.spec.kind === "single"
				? `s:${p.spec.ref.line}`
				: p.spec.kind === "range"
					? `r:${p.spec.start.line}:${p.spec.end.line}`
					: `i:${p.spec.after.line}`;
		const key = `${lk}|${p.dstLines.join("\n")}`;
		if (seen.has(key)) dupes.add(i);
		else seen.set(key, i);
	}
	const deduped = parsed.filter((_, i) => !dupes.has(i));

	// Sort bottom-up for stable splice
	const sorted = deduped
		.map((p) => {
			const sl = p.spec.kind === "single" ? p.spec.ref.line : p.spec.kind === "range" ? p.spec.end.line : p.spec.after.line;
			const pr = p.spec.kind === "insertAfter" ? 1 : 0;
			return { ...p, sl, pr };
		})
		.sort((a, b) => b.sl - a.sl || a.pr - b.pr || a.idx - b.idx);

	function track(line: number) {
		if (firstChanged === undefined || line < firstChanged) firstChanged = line;
	}

	const warnings: string[] = [...relocationNotes];

	// Apply edits bottom-up
	for (const { spec, dstLines, idx } of sorted) {
		throwIfAborted(signal);
		if (spec.kind === "single") {
			const orig = origLines.slice(spec.ref.line - 1, spec.ref.line);

			// Noop check: compare dstLines directly against original before any normalization.
			// This prevents heuristics from normalizing a legitimate edit back to original content.
			if (orig.length === dstLines.length && orig.every((line, i) => line === dstLines[i])) {
				noopEdits.push({ editIndex: idx, loc: `${spec.ref.line}:${spec.ref.hash}`, currentContent: orig.join("\n") });
				continue;
			}

			fileLines.splice(spec.ref.line - 1, 1, ...dstLines);
			track(spec.ref.line);
		} else if (spec.kind === "range") {
			const count = spec.end.line - spec.start.line + 1;
			const orig = origLines.slice(spec.start.line - 1, spec.start.line - 1 + count);

			// Noop check: compare dstLines directly against original before any normalization.
			if (orig.length === dstLines.length && orig.every((line, i) => line === dstLines[i])) {
				noopEdits.push({ editIndex: idx, loc: `${spec.start.line}:${spec.start.hash}`, currentContent: orig.join("\n") });
				continue;
			}

			let newL = [...dstLines];
			// Auto-correct trailing duplicate: if the last replacement line duplicates
			// the next surviving line after the range, the model likely echoed the
			// boundary. Strip the duplicate to avoid doubled lines (matches parent).
			if (newL.length > 0) {
				const trailingLine = newL[newL.length - 1];
				const nextSurvivingLine = fileLines[spec.end.line]; // 0-indexed: line after end
				if (
					trailingLine !== undefined &&
					trailingLine.trim().length > 0 &&
					nextSurvivingLine !== undefined &&
					trailingLine.trim() === nextSurvivingLine.trim() &&
					// Safety: only correct when end-line content differs from the duplicate.
					// If end already points to the boundary, matching next line is coincidence.
					fileLines[spec.end.line - 1].trim() !== trailingLine.trim()
				) {
					newL = newL.slice(0, -1);
					warnings.push(
						`Auto-corrected range replace ${spec.start.line}:${spec.start.hash}-${spec.end.line}:${spec.end.hash}: removed trailing replacement line "${trailingLine.trim()}" that duplicated next surviving line`,
					);
				}
			}
			fileLines.splice(spec.start.line - 1, count, ...newL);
			track(spec.start.line);
		} else {
			if (!dstLines.length) {
				noopEdits.push({ editIndex: idx, loc: `${spec.after.line}:${spec.after.hash}`, currentContent: origLines[spec.after.line - 1] });
				continue;
			}
			fileLines.splice(spec.after.line, 0, ...dstLines);
			track(spec.after.line + 1);
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
}
