/**
 * Parsing — prefix regexes, anchor ref parsing, edit item validation, resolveEditAnchors.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 */

import { NIBBLE_STR, HASH_ALPHABET_RE } from "./hash";

// ─── Types ──────────────────────────────────────────────────────────────

export type Anchor = { line: number; hash: string; textHint?: string };
export type HashlineEdit =
	| { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] }
	| { op: "append"; pos?: Anchor; lines: string[] }
	| { op: "prepend"; pos?: Anchor; lines: string[] }
	| { op: "replace_text"; oldText: string; newText: string };

export type HashlineToolEdit = {
	op: string;
	pos?: string;
	end?: string;
	lines?: string[];
	oldText?: string;
	newText?: string;
};

/**
 * Patterns used to detect (and reject) hashline display prefixes inside edit
 * payloads. The runtime no longer strips them — the model must send literal
 * file content. Matching any of these triggers `[E_INVALID_PATCH]`.
 */
const HASHLINE_PREFIX_RE = new RegExp(
	`^\\s*(?:>>>|>>)?\\s*(?:\\d+\\s*#\\s*|#\\s*)[${NIBBLE_STR}]{2}:`,
);
const HASHLINE_PREFIX_PLUS_RE = new RegExp(
	`^\\+\\s*(?:\\d+\\s*#\\s*|#\\s*)[${NIBBLE_STR}]{2}:`,
);
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
export const HASHLINE_BARE_PREFIX_RE = new RegExp(`^\\s*([${NIBBLE_STR}]{2}):`);

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
 * Validate and return replacement lines.
 *
 * Array input is preserved verbatim so explicitly provided blank lines remain
 * intact. Display prefixes (full `LINE#HASH:` and diff `+/-` forms) are
 * rejected by `assertNoDisplayPrefixes` — the model must send literal file
 * content, never rendered read or diff output.
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

export function normalizeExactText(text: string | undefined): string | undefined {
	if (typeof text !== "string") {
		return undefined;
	}

	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

