/**
 * Hash computation — NIBBLE_STR alphabet, xxh32 wrapper, per-line hash.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 */

import * as XXH from "xxhashjs";
import { getHashLength } from "../config";

// ─── Hash computation ───────────────────────────────────────────────────

/**
 * Custom 16-character hash alphabet. Deliberately excludes:
 * - Hex digits A–F (prevents confusion with hex literals in code)
 * - Visually confusable letters: D, G, I, L, O (look like digits 0, 6, 1, 1, 0)
 * - Common vowels A, E, I, O, U (prevents accidental English words)
 *
 * At hash length 2 these properties hold unconditionally. At lengths 3–4, the
 * alphabet still avoids hex and visually confusing characters, but longer tokens
 * drawn from real uppercase identifiers (HTTP methods, MQTT keywords, etc.) may
 * coincidentally share the same character set. Detectors must not rely on shape
 * alone to distinguish anchors from content — context and position remain the
 * authoritative signals.
 */
export const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";
export const HASH_ALPHABET_RE = new RegExp(`^[${NIBBLE_STR}]+$`);

/** Lines containing no alphanumeric characters (only punctuation/symbols/whitespace). */
export const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

export function xxh32(input: string, seed = 0): number {
	return XXH.h32(seed).update(input).digest().toNumber() >>> 0;
}

/** Normalize a line for hash input: strip \r, trimEnd. */
export function normalizeHashInput(line: string): string {
	return line.replace(/\r/g, "").trimEnd();
}

/**
 * Compute an N-char hash from a line's content and its immediate neighbors.
 * Using prev + "\0" + curr + "\0" + next as the hash input ensures:
 * - Distant edits no longer invalidate anchors (only same/adjacent lines affected).
 * - Adjacent-edit invalidation is intentional: editing near an anchor makes it stale.
 * - Silent collisions now require the entire 3-line window to match.
 * All three inputs must already be normalized via normalizeHashInput.
 *
 * Hash length is taken from config at call time (default 2, configurable to 3–4).
 * At length 2 the output is identical to the former DICT-based path: nibble-by-nibble
 * encoding of the low 8 bits of xxh32 maps directly to DICT[byte].
 */
export function computeHashFromContext(prev: string, curr: string, next: string): string {
	const len = getHashLength();
	const h = xxh32(prev + "\0" + curr + "\0" + next);
	// Extract `len` nibbles from the low 4*len bits of the hash value.
	let result = "";
	for (let i = len - 1; i >= 0; i--) {
		result += NIBBLE_STR[(h >>> (i * 4)) & 0x0f];
	}
	return result;
}

/**
 * Compute the N-char hash for a line at a given 0-based index within a file.
 * Neighbors outside the file boundaries use "" as their normalized value.
 */
export function computeLineHash(fileLines: readonly string[], index: number): string {
	const prev = normalizeHashInput(index > 0 ? fileLines[index - 1]! : "");
	const curr = normalizeHashInput(fileLines[index]!);
	const next = normalizeHashInput(index < fileLines.length - 1 ? fileLines[index + 1]! : "");
	return computeHashFromContext(prev, curr, next);
}

/** Fuzzy-match Unicode replacement regexes for anchor textHint validation. */
const FUZZY_SINGLE_QUOTES_RE = /[\u2018\u2019\u201A\u201B]/g;
const FUZZY_DOUBLE_QUOTES_RE = /[\u201C\u201D\u201E\u201F]/g;
const FUZZY_HYPHENS_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const FUZZY_UNICODE_SPACES_RE = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;

export function normalizeFuzzyLine(text: string): string {
	return text
		.trimEnd()
		.replace(FUZZY_SINGLE_QUOTES_RE, "'")
		.replace(FUZZY_DOUBLE_QUOTES_RE, '"')
		.replace(FUZZY_HYPHENS_RE, "-")
		.replace(FUZZY_UNICODE_SPACES_RE, " ");
}

export function isFuzzyEquivalentLine(expected: string, actual: string): boolean {
	return normalizeFuzzyLine(expected) === normalizeFuzzyLine(actual);
}
