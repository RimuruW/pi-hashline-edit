/**
 * Hash computation — NIBBLE_STR alphabet, xxh32 wrapper, per-line hash.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 */

import * as XXH from "xxhashjs";

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
export const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";
export const HASH_ALPHABET_RE = new RegExp(`^[${NIBBLE_STR}]+$`);

export const DICT = Array.from({ length: 256 }, (_, i) => {
	const h = i >>> 4;
	const l = i & 0x0f;
	return `${NIBBLE_STR[h]}${NIBBLE_STR[l]}`;
});

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
 * Compute a 2-char hash from a line's content and its immediate neighbors.
 * Using prev + "\0" + curr + "\0" + next as the hash input ensures:
 * - Distant edits no longer invalidate anchors (only same/adjacent lines affected).
 * - Adjacent-edit invalidation is intentional: editing near an anchor makes it stale.
 * - Silent 8-bit collisions now require the entire 3-line window to match.
 * All three inputs must already be normalized via normalizeHashInput.
 */
export function computeHashFromContext(prev: string, curr: string, next: string): string {
	return DICT[xxh32(prev + "\0" + curr + "\0" + next) & 0xff];
}

/**
 * Compute the 2-char hash for a line at a given 0-based index within a file.
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
