/**
 * Hashline engine — hash-anchored line editing.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 */

import * as XXH from "xxhashjs";
import { throwIfAborted } from "./runtime";

// ─── Types ──────────────────────────────────────────────────────────────

export type Anchor = { line: number; hash: string; textHint?: string };
export type HashlineEdit =
	| { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] }
	| { op: "append"; pos?: Anchor; lines: string[] }
	| { op: "prepend"; pos?: Anchor; lines: string[] }
	| { op: "replace_text"; oldText: string; newText: string };

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
const HASH_ALPHABET_RE = new RegExp(`^[${NIBBLE_STR}]+$`);

const DICT = Array.from({ length: 256 }, (_, i) => {
	const h = i >>> 4;
	const l = i & 0x0f;
	return `${NIBBLE_STR[h]}${NIBBLE_STR[l]}`;
});

/**
 * Patterns used to detect (and reject) hashline display prefixes inside edit
 * payloads. The runtime no longer strips them — the model must send literal
 * file content. Matching any of these triggers `[E_INVALID_PATCH]`.
 */
const HASHLINE_PREFIX_RE =
	/^\s*(?:>>>|>>)?\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;
const HASHLINE_PREFIX_PLUS_RE =
	/^\+\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;
const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

/**
 * Bare hashline prefix: a 2-char hash followed by ":" with no "LINE#" part
 * (e.g. "KK:### heading", "TP:text", "TJ:"). Capture group 1 is the hash.
 *
 * This is the partial-hash failure mode from issue #24: the model copies a hash
 * it saw in `read` output into the line content but drops the "LINE#" part. A
 * single such line is genuinely ambiguous — "TS: foo", "PR: bar", "SK: key" are
 * legitimate YAML keys / abbreviations — so it is never rejected on shape alone.
 * Disambiguation happens against the file's actual hash set in
 * `rejectOrWarnBareHashPrefixLines`.
 */
const HASHLINE_BARE_PREFIX_RE = /^\s*([ZPMQVRWSNKTXJBYH]{2}):/;

/** Lines containing no alphanumeric characters (only punctuation/symbols/whitespace). */
const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

function xxh32(input: string, seed = 0): number {
	return XXH.h32(seed).update(input).digest().toNumber() >>> 0;
}

export function computeLineHash(idx: number, line: string): string {
	line = line.replace(/\r/g, "").trimEnd();
	let seed = 0;
	if (!RE_SIGNIFICANT.test(line)) {
		seed = idx;
	}
	return DICT[xxh32(line, seed) & 0xff];
}

/** Fuzzy-match Unicode replacement regexes for anchor textHint validation. */
const FUZZY_SINGLE_QUOTES_RE = /[\u2018\u2019\u201A\u201B]/g;
const FUZZY_DOUBLE_QUOTES_RE = /[\u201C\u201D\u201E\u201F]/g;
const FUZZY_HYPHENS_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const FUZZY_UNICODE_SPACES_RE = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;

function normalizeFuzzyLine(text: string): string {
	return text
		.trimEnd()
		.replace(FUZZY_SINGLE_QUOTES_RE, "'")
		.replace(FUZZY_DOUBLE_QUOTES_RE, '"')
		.replace(FUZZY_HYPHENS_RE, "-")
		.replace(FUZZY_UNICODE_SPACES_RE, " ");
}

function isFuzzyEquivalentLine(expected: string, actual: string): boolean {
	return normalizeFuzzyLine(expected) === normalizeFuzzyLine(actual);
}

// ─── Parsing ────────────────────────────────────────────────────────────

function diagnoseLineRef(ref: string): string {
	const trimmed = ref.trim();
	const core = ref.replace(/^\s*[>+-]*\s*/, "").trim();

	if (!core.length) {
		return `[E_BAD_REF] Invalid line reference "${ref}". Expected "LINE#HASH" (e.g. "5#MQ").`;
	}
	if (/^\d+\s*$/.test(core)) {
		return `[E_BAD_REF] Invalid line reference "${ref}": missing hash, use "LINE#HASH" from read output (e.g. "5#MQ").`;
	}
	if (/^\d+\s*:/.test(core)) {
		return `[E_BAD_REF] Invalid line reference "${ref}": wrong separator, use "LINE#HASH" instead of "LINE:...".`;
	}

	const hashMatch = core.match(/^(\d+)\s*#\s*([^\s:]+)(?:\s*:.*)?$/);
	if (hashMatch) {
		const line = Number.parseInt(hashMatch[1]!, 10);
		const hash = hashMatch[2]!;
		if (line < 1) {
			return `[E_BAD_REF] Line number must be >= 1, got ${line} in "${ref}".`;
		}
		if (hash.length !== 2) {
			return `[E_BAD_REF] Invalid line reference "${ref}": hash must be exactly 2 characters from ${NIBBLE_STR}.`;
		}
		if (!HASH_ALPHABET_RE.test(hash)) {
			return `[E_BAD_REF] Invalid line reference "${ref}": hash uses invalid characters, hashes use alphabet ${NIBBLE_STR} only.`;
		}
	}

	const missingHashMatch = core.match(/^(\d+)\s*#\s*$/);
	if (missingHashMatch) {
		return `[E_BAD_REF] Invalid line reference "${ref}": missing hash after "#", use "LINE#HASH" from read output.`;
	}

	if (/^0+\s*#/.test(core)) {
		return `[E_BAD_REF] Line number must be >= 1, got 0 in "${ref}".`;
	}

	return `[E_BAD_REF] Invalid line reference "${trimmed || ref}". Expected "LINE#HASH" (e.g. "5#MQ").`;
}

// Parses LINE#HASH format, tolerating leading ">+-" and whitespace (from
// mismatch/diff display) and an optional trailing ":content" display suffix,
// which is preserved as `textHint` for fuzzy anchor validation.
function parseAnchorRef(ref: string): Anchor {
	const core = ref.replace(/^\s*[>+-]*\s*/, "").trimEnd();
	const match = core.match(/^([0-9]+)\s*#\s*([^\s:]+)(?:\s*:(.*))?$/s);
	if (!match) {
		throw new Error(diagnoseLineRef(ref));
	}

	const line = Number.parseInt(match[1]!, 10);
	if (line < 1) {
		throw new Error(
			`[E_BAD_REF] Line number must be >= 1, got ${line} in "${ref}".`,
		);
	}

	const hash = match[2]!;
	if (hash.length !== 2) {
		throw new Error(
			`[E_BAD_REF] Invalid line reference "${ref}": hash must be exactly 2 characters from ${NIBBLE_STR}.`,
		);
	}

	if (!HASH_ALPHABET_RE.test(hash)) {
		throw new Error(
			`[E_BAD_REF] Invalid line reference "${ref}": hash uses invalid characters, hashes use alphabet ${NIBBLE_STR} only.`,
		);
	}

	const textHint = match[3];
	return {
		line,
		hash,
		...(textHint !== undefined ? { textHint } : {}),
	};
}

// ─── Mismatch formatting ────────────────────────────────────────────────

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
		const hash = computeLineHash(num, content);
		const prefix = `${String(num).padStart(lineNumberWidth, " ")}#${hash}`;
		out.push(
			retryLineSet.has(num)
				? `>>> ${prefix}:${content}`
				: `    ${prefix}:${content}`,
		);
	}

	return out.join("\n");
}

// ─── Content preprocessing ─────────────────────────────────────────────────────

/**
 * Reject hashline display prefixes in edit payloads. Strict semantics: the
 * model must send literal file content for `lines`, not the rendered read /
 * diff form. Silent stripping is no longer performed — see CONTEXT.md
 * (Architecture invariants).
 *
 * This covers the unambiguous full `LINE#HASH:` / diff `+/-` forms, rejectable
 * on shape alone. The bare `HH:` variant (issue #24) is context-dependent and
 * lives in `rejectOrWarnBareHashPrefixLines`.
 */
function assertNoDisplayPrefixes(lines: string[]): void {
	for (const line of lines) {
		if (!line.length) continue;
		if (
			HASHLINE_PREFIX_RE.test(line) ||
			HASHLINE_PREFIX_PLUS_RE.test(line) ||
			DIFF_MINUS_RE.test(line)
		) {
			throw new Error(
				`[E_INVALID_PATCH] "lines" must contain literal file content, not rendered "LINE#HASH:" or diff "+/-" prefixes. Offending line: ${JSON.stringify(line)}`,
			);
		}
	}
}

/**
 * Parse replacement text into lines.
 *
 * String input is normalized to LF and drops exactly one trailing newline,
 * matching read-preview style content. Array input is preserved verbatim so
 * explicitly provided blank lines remain intact. Display prefixes are
 * rejected by `assertNoDisplayPrefixes`, never silently stripped.
 */
function hashlineParseText(edit: string[] | undefined): string[] {
	const lines = edit ?? [];
	assertNoDisplayPrefixes(lines);
	return lines;
}

/**
 * Validate + parse flat tool-schema edits into typed internal representations.
 *
 * This is the single source of truth for per-edit structural validation (shape,
 * op constraints, field types) and anchor parsing. `assertEditRequest` validates
 * only the request envelope (path plus edits array presence) and delegates here
 * for edit payload validation.
 *
 * Strict: provided anchors must parse successfully. Missing anchors are
 * fine for append (→ EOF) and prepend (→ BOF), but a malformed anchor
 * that was explicitly supplied is always an error.
 *
 * - replace + pos only → single-line replace
 * - replace + pos + end → range replace
 * - append + pos → append after that anchor
 * - prepend + pos → prepend before that anchor
 * - replace_text + oldText/newText → exact unique text replace
 * - no anchors → file-level append/prepend (only for those ops)
 */

const ITEM_KEYS = new Set(["op", "pos", "end", "lines", "oldText", "newText"]);

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function assertEditItem(edit: Record<string, unknown>, index: number): void {
	const unknownKeys = Object.keys(edit).filter((key) => !ITEM_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(
			`Edit ${index} contains unknown or unsupported fields: ${unknownKeys.join(", ")}.`,
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
			`[E_BAD_OP] Edit ${index} uses unknown op "${edit.op}". Expected "replace", "append", "prepend", or "replace_text".`,
		);
	}

	if ("pos" in edit && typeof edit.pos !== "string") {
		throw new Error(
			`Edit ${index} field "pos" must be a string when provided.`,
		);
	}
	if ("end" in edit && typeof edit.end !== "string") {
		throw new Error(
			`Edit ${index} field "end" must be a string when provided.`,
		);
	}
	if ("oldText" in edit && typeof edit.oldText !== "string") {
		throw new Error(
			`Edit ${index} field "oldText" must be a string when provided.`,
		);
	}
	if ("newText" in edit && typeof edit.newText !== "string") {
		throw new Error(
			`Edit ${index} field "newText" must be a string when provided.`,
		);
	}
	if ("lines" in edit && !isStringArray(edit.lines)) {
		throw new Error(`Edit ${index} field "lines" must be a string array.`);
	}

	if (edit.op === "replace_text") {
		if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
			throw new Error(
				`[E_BAD_OP] Edit ${index} with op "replace_text" requires string "oldText" and "newText" fields.`,
			);
		}
		if ("pos" in edit || "end" in edit || "lines" in edit) {
			throw new Error(
				`Edit ${index} with op "replace_text" only supports "oldText" and "newText".`,
			);
		}
		return;
	}

	if (!("lines" in edit)) {
		throw new Error(`Edit ${index} requires a "lines" field.`);
	}

	if ("oldText" in edit || "newText" in edit) {
		throw new Error(
			`Edit ${index} with op "${edit.op}" does not support "oldText" or "newText".`,
		);
	}

	if (edit.op === "replace" && typeof edit.pos !== "string") {
		throw new Error(
			`[E_BAD_OP] Edit ${index} with op "replace" requires a "pos" anchor string.`,
		);
	}

	if ((edit.op === "append" || edit.op === "prepend") && "end" in edit) {
		throw new Error(
			`[E_BAD_OP] Edit ${index} with op "${edit.op}" does not support "end". Use "pos" or omit it for file boundary insertion.`,
		);
	}
}

export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
	const result: HashlineEdit[] = [];
	for (const [index, edit] of edits.entries()) {
		assertEditItem(edit as Record<string, unknown>, index);

		const op = edit.op;
		switch (op) {
			case "replace": {
				result.push({
					op: "replace",
					pos: parseAnchorRef(edit.pos!),
					...(edit.end ? { end: parseAnchorRef(edit.end) } : {}),
					lines: hashlineParseText(edit.lines),
				});
				break;
			}
			case "append": {
				result.push({
					op: "append",
					...(edit.pos ? { pos: parseAnchorRef(edit.pos) } : {}),
					lines: hashlineParseText(edit.lines),
				});
				break;
			}
			case "prepend": {
				result.push({
					op: "prepend",
					...(edit.pos ? { pos: parseAnchorRef(edit.pos) } : {}),
					lines: hashlineParseText(edit.lines),
				});
				break;
			}
			case "replace_text": {
				result.push({
					op: "replace_text",
					oldText: normalizeExactText(edit.oldText)!,
					newText: normalizeExactText(edit.newText)!,
				});
				break;
			}
		}
	}
	return result;
}

// ─── Main edit engine ───────────────────────────────────────────────────

/** Schema-level edit as received from the tool layer (pos/end are tag strings, lines is canonicalized to an array). */
export type HashlineToolEdit = {
	op: string;
	pos?: string;
	end?: string;
	lines?: string[];
	oldText?: string;
	newText?: string;
};

function normalizeExactText(text: string | undefined): string | undefined {
	if (typeof text !== "string") {
		return undefined;
	}

	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

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
		fileLines.map((line, i) => computeLineHash(i + 1, line)),
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
	switch (edit.op) {
		case "append": {
			const fileLineCount = lineIndex.fileLines.length;
			const eofBoundary =
				lineIndex.hasTerminalNewline && fileLineCount > 0
					? fileLineCount - 1
					: fileLineCount;
			return edit.pos
				? lineIndex.hasTerminalNewline && edit.pos.line === fileLineCount
					? eofBoundary
					: edit.pos.line
				: eofBoundary;
		}
		case "prepend":
			return edit.pos ? edit.pos.line - 1 : 0;
	}
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
		const actual = computeLineHash(ref.line, line);
		if (actual === ref.hash) return true;
		if (ref.textHint !== undefined) {
			const hintedHash = computeLineHash(ref.line, ref.textHint);
			if (
				hintedHash === ref.hash &&
				isFuzzyEquivalentLine(ref.textHint, line)
			) {
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
		mismatches.push({ line: ref.line, expected: ref.hash, actual });
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
				break;
			}
			case "prepend": {
				if (edit.pos && !validate(edit.pos)) continue;
				if (edit.lines.length === 0) {
					throw new Error(
						"[E_BAD_OP] Prepend with empty lines payload. Provide content to insert or remove the edit.",
					);
				}
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
	lines: string[],
	startLine: number,
): string {
	const lineNumberWidth = String(
		startLine + Math.max(0, lines.length - 1),
	).length;
	return lines
		.map((line, index) => {
			const lineNumber = startLine + index;
			const paddedLineNumber = String(lineNumber).padStart(
				lineNumberWidth,
				" ",
			);
			return `${paddedLineNumber}#${computeLineHash(lineNumber, line)}:${line}`;
		})
		.join("\n");
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
