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
const HASH_ALPHABET_RE = new RegExp(`^[${NIBBLE_STR}]+$`);

const DICT = Array.from({ length: 256 }, (_, i) => {
  const h = i >>> 4;
  const l = i & 0x0f;
  return `${NIBBLE_STR[h]}${NIBBLE_STR[l]}`;
});

/** Pattern matching hashline display format prefixes: `LINE#ID:CONTENT` and `#ID:CONTENT` */
const HASHLINE_PREFIX_RE =
  /^\s*(?:>>>|>>)?\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;
const HASHLINE_PREFIX_PLUS_RE =
  /^\+\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;
const DIFF_PLUS_RE = /^\+(?!\+)/;
const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

function stripDiffPreviewPrefix(line: string): string | null {
  if (DIFF_MINUS_RE.test(line)) {
    return null;
  }
  if (HASHLINE_PREFIX_PLUS_RE.test(line)) {
    return line.replace(HASHLINE_PREFIX_PLUS_RE, "");
  }
  if (HASHLINE_PREFIX_RE.test(line)) {
    return line.replace(HASHLINE_PREFIX_RE, "");
  }
  return line.replace(DIFF_PLUS_RE, "");
}

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

/** Shared fuzzy-match Unicode replacement regexes (also used by edit-diff.ts). */
export const FUZZY_SINGLE_QUOTES_RE = /[\u2018\u2019\u201A\u201B]/g;
export const FUZZY_DOUBLE_QUOTES_RE = /[\u201C\u201D\u201E\u201F]/g;
export const FUZZY_HYPHENS_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
export const FUZZY_UNICODE_SPACES_RE = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;

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
    return `Invalid line reference "${ref}". Expected "LINE#HASH" (e.g. "5#MQ").`;
  }
  if (/^\d+\s*$/.test(core)) {
    return `Invalid line reference "${ref}": missing hash, use "LINE#HASH" from read output (e.g. "5#MQ").`;
  }
  if (/^\d+\s*:/.test(core)) {
    return `Invalid line reference "${ref}": wrong separator, use "LINE#HASH" instead of "LINE:...".`;
  }

  const hashMatch = core.match(/^(\d+)\s*#\s*([^\s:]+)(?:\s*:.*)?$/);
  if (hashMatch) {
    const line = Number.parseInt(hashMatch[1]!, 10);
    const hash = hashMatch[2]!;
    if (line < 1) {
      return `Line number must be >= 1, got ${line} in "${ref}".`;
    }
    if (hash.length !== 2) {
      return `Invalid line reference "${ref}": hash must be exactly 2 characters from ${NIBBLE_STR}.`;
    }
    if (!HASH_ALPHABET_RE.test(hash)) {
      return `Invalid line reference "${ref}": hash uses invalid characters, hashes use alphabet ${NIBBLE_STR} only.`;
    }
  }

  const missingHashMatch = core.match(/^(\d+)\s*#\s*$/);
  if (missingHashMatch) {
    return `Invalid line reference "${ref}": missing hash after "#", use "LINE#HASH" from read output.`;
  }

  if (/^0+\s*#/.test(core)) {
    return `Line number must be >= 1, got 0 in "${ref}".`;
  }

  return `Invalid line reference "${trimmed || ref}". Expected "LINE#HASH" (e.g. "5#MQ").`;
}

export function parseLineRef(ref: string): { line: number; hash: string } {
  // Match LINE#HASH format, tolerating:
  //  - leading ">+" and whitespace (from mismatch/diff display)
  //  - optional trailing display suffix (":..." content)
  const parsed = parseAnchorRef(ref);
  return { line: parsed.line, hash: parsed.hash };
}

function parseAnchorRef(ref: string): Anchor {
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trimEnd();
  const match = core.match(/^([0-9]+)\s*#\s*([^\s:]+)(?:\s*:(.*))?$/s);
  if (!match) {
    throw new Error(diagnoseLineRef(ref));
  }

  const line = Number.parseInt(match[1]!, 10);
  if (line < 1) {
    throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
  }

  const hash = match[2]!;
  if (hash.length !== 2) {
    throw new Error(`Invalid line reference "${ref}": hash must be exactly 2 characters from ${NIBBLE_STR}.`);
  }

  if (!HASH_ALPHABET_RE.test(hash)) {
    throw new Error(
      `Invalid line reference "${ref}": hash uses invalid characters, hashes use alphabet ${NIBBLE_STR} only.`,
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
  const out: string[] = [
    `${mismatches.length} stale anchor${mismatches.length > 1 ? "s" : ""}. Retry with the >>> LINE#HASH lines below; keep both endpoints for range replaces.`,
    "",
  ];

  let prev = -1;
  for (const num of sorted) {
    if (prev !== -1 && num > prev + 1) out.push("    ...");
    prev = num;
    const content = fileLines[num - 1];
    const hash = computeLineHash(num, content);
    const prefix = `${num}#${hash}`;
    out.push(
      retryLineSet.has(num)
        ? `>>> ${prefix}:${content}`
        : `    ${prefix}:${content}`,
    );
  }

  return out.join("\n");
}

// ─── Content preprocessing ─────────────────────────────────────────────────────

export function stripNewLinePrefixes(lines: string[]): string[] {
  let hashCount = 0;
  let hashPlusCount = 0;
  let minusCount = 0;
  let diffPreviewCount = 0;
  let nonEmpty = 0;

  for (const line of lines) {
    if (!line.length) continue;
    nonEmpty++;

    const isHashLine = HASHLINE_PREFIX_RE.test(line);
    const isHashPlusLine = HASHLINE_PREFIX_PLUS_RE.test(line);
    const isMinusLine = DIFF_MINUS_RE.test(line);

    if (isHashLine) hashCount++;
    if (isHashPlusLine) hashPlusCount++;
    if (isHashLine || isHashPlusLine || isMinusLine) diffPreviewCount++;
    if (isMinusLine) minusCount++;
  }

  if (!nonEmpty) return lines;
  const stripHash = hashCount > 0 && hashCount === nonEmpty;
  const stripDiffPreview =
    !stripHash && (hashPlusCount > 0 || minusCount > 0) && diffPreviewCount === nonEmpty;
  if (!stripHash && !stripDiffPreview) return lines;

  if (stripDiffPreview) {
    const stripped: string[] = [];
    for (const line of lines) {
      const normalized = stripDiffPreviewPrefix(line);
      if (normalized !== null) stripped.push(normalized);
    }
    return stripped;
  }

  return lines.map((line) => line.replace(HASHLINE_PREFIX_RE, ""));
}

/**
 * Parse replacement text into lines with prefix stripping.
 *
 * String input is normalized to LF and drops exactly one trailing newline,
 * matching read-preview style content. Array input is preserved verbatim after
 * prefix stripping so explicitly provided blank lines remain intact.
 */
export function hashlineParseText(edit: string[] | string | null): string[] {
  if (edit === null) return [];
  if (typeof edit === "string") {
    const normalized = edit.endsWith("\n") ? edit.slice(0, -1) : edit;
    return stripNewLinePrefixes(normalized.replaceAll("\r", "").split("\n"));
  }

  return stripNewLinePrefixes(edit);
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
 * - append + pos → append after that anchor
 * - prepend + pos → prepend before that anchor
 * - no anchors → file-level append/prepend (only for those ops)
 *
 * Unknown or missing ops are rejected explicitly.
 */
export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
  const result: HashlineEdit[] = [];
  for (const edit of edits) {
    const lines = hashlineParseText(edit.lines);
    const op = edit.op;
    if (op !== "replace" && op !== "append" && op !== "prepend") {
      throw new Error(
        `Unknown edit op "${op}". Expected "replace", "append", or "prepend".`,
      );
    }

    switch (op) {
      case "replace": {
        if (!edit.pos) {
          throw new Error('Replace requires a "pos" anchor.');
        }

        result.push({
          op: "replace",
          pos: parseAnchorRef(edit.pos),
          ...(edit.end ? { end: parseAnchorRef(edit.end) } : {}),
          lines,
        });
        break;
      }
      case "append": {
        if (edit.end !== undefined) {
          throw new Error('Append does not support "end". Use "pos" or omit it for EOF.');
        }

        result.push({
          op: "append",
          ...(edit.pos ? { pos: parseAnchorRef(edit.pos) } : {}),
          lines,
        });
        break;
      }
      case "prepend": {
        if (edit.end !== undefined) {
          throw new Error('Prepend does not support "end". Use "pos" or omit it for BOF.');
        }

        result.push({
          op: "prepend",
          ...(edit.pos ? { pos: parseAnchorRef(edit.pos) } : {}),
          lines,
        });
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
const LEADING_ESCAPED_TABS_RE = /^((?:\\t)+)/;

function shouldAutocorrect(line: string, otherLine: string): boolean {
  if (!line || line !== otherLine) return false;
  line = line.trim();
  if (line.length < MIN_AUTOCORRECT_LENGTH) {
    // Short lines: only allow brace/paren closers
    return line.endsWith("}") || line.endsWith(")");
  }
  return true;
}

function countLeadingTabs(line: string): number {
  let count = 0;
  while (line[count] === "\t") {
    count++;
  }
  return count;
}

function maybeAutocorrectEscapedTabIndentation(
  edits: HashlineEdit[],
  warnings: string[],
  fileLines: string[],
): void {
  if (process.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS !== "1") {
    return;
  }

  for (const edit of edits) {
    if (edit.op !== "replace" || edit.lines.length === 0) {
      continue;
    }

    const hasEscapedTabs = edit.lines.some((line) => line.includes("\\t"));
    if (!hasEscapedTabs) {
      continue;
    }

    const hasRealTabs = edit.lines.some((line) => line.includes("\t"));
    if (hasRealTabs) {
      continue;
    }

    const targetStart = edit.pos.line - 1;
    const targetCount = edit.end ? edit.end.line - edit.pos.line + 1 : 1;
    if (targetCount !== edit.lines.length) {
      continue;
    }

    let correctedCount = 0;
    edit.lines = edit.lines.map((line, index) => {
      const match = line.match(LEADING_ESCAPED_TABS_RE);
      if (!match) {
        return line;
      }

      const escapedTabs = match[1]!;
      const tabCount = escapedTabs.length / 2;
      const targetLine = fileLines[targetStart + index];
      if (!targetLine) {
        return line;
      }

      // Only recover escaped indentation when the anchored line being replaced
      // already uses the same leading tab depth. If file content itself begins
      // with literal "\t", preserve it verbatim.
      if (countLeadingTabs(targetLine) !== tabCount || targetLine.startsWith(escapedTabs)) {
        return line;
      }

      correctedCount += tabCount;
      return "\t".repeat(tabCount) + line.slice(escapedTabs.length);
    });

    if (correctedCount > 0) {
      warnings.push(
        "Auto-corrected escaped tab indentation in anchored replace edit: converted leading \\t sequence(s) where the replaced file content already used matching real tab indentation",
      );
    }
  }
}

function maybeWarnSuspiciousUnicodeEscapePlaceholder(
  edits: HashlineEdit[],
  warnings: string[],
): void {
  for (const edit of edits) {
    if (edit.lines.some((line) => /\\uDDDD/i.test(line))) {
      warnings.push(
        "Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
      );
    }
  }
}

type NormalizedEditTarget =
  | {
      kind: "replace";
      index: number;
      label: string;
      startLine: number;
      endLine: number;
    }
  | {
      kind: "insert";
      index: number;
      label: string;
      boundary: number;
    };

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
  }
}

function normalizeEditTarget(
  edit: HashlineEdit,
  index: number,
  fileLineCount: number,
): NormalizedEditTarget {
  switch (edit.op) {
    case "replace":
      return {
        kind: "replace",
        index,
        label: describeEdit(edit),
        startLine: edit.pos.line,
        endLine: edit.end?.line ?? edit.pos.line,
      };
    case "append":
      return {
        kind: "insert",
        index,
        label: describeEdit(edit),
        boundary: edit.pos ? edit.pos.line : fileLineCount,
      };
    case "prepend":
      return {
        kind: "insert",
        index,
        label: describeEdit(edit),
        boundary: edit.pos ? edit.pos.line - 1 : 0,
      };
  }
}

function throwEditConflict(
  left: NormalizedEditTarget,
  right: NormalizedEditTarget,
  reason: string,
): never {
  throw new Error(
    `Conflicting edits in a single request: edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}. Merge them into one non-overlapping change or split the request.`,
  );
}

function cloneHashlineEdit(edit: HashlineEdit): HashlineEdit {
  switch (edit.op) {
    case "replace":
      return {
        op: "replace",
        pos: { ...edit.pos },
        ...(edit.end ? { end: { ...edit.end } } : {}),
        lines: [...edit.lines],
      };
    case "append":
      return {
        op: "append",
        ...(edit.pos ? { pos: { ...edit.pos } } : {}),
        lines: [...edit.lines],
      };
    case "prepend":
      return {
        op: "prepend",
        ...(edit.pos ? { pos: { ...edit.pos } } : {}),
        lines: [...edit.lines],
      };
  }
}

function assertNoConflictingEdits(
  edits: HashlineEdit[],
  fileLineCount: number,
): void {
  const targets = edits.map((edit, index) => normalizeEditTarget(edit, index, fileLineCount));

  for (let i = 0; i < targets.length; i++) {
    const left = targets[i]!;
    for (let j = i + 1; j < targets.length; j++) {
      const right = targets[j]!;

      if (left.kind === "replace" && right.kind === "replace") {
        const overlaps = left.startLine <= right.endLine && right.startLine <= left.endLine;
        if (overlaps) {
          throwEditConflict(left, right, "overlap on the same original line range");
        }
        continue;
      }

      if (left.kind === "insert" && right.kind === "insert") {
        if (left.boundary === right.boundary) {
          throwEditConflict(left, right, "target the same insertion boundary");
        }
        continue;
      }

      const [replaceTarget, insertTarget] =
        left.kind === "replace"
          ? [left, right as Extract<NormalizedEditTarget, { kind: "insert" }>]
          : [right as Extract<NormalizedEditTarget, { kind: "replace" }>, left];
      const insertsInsideReplace =
        insertTarget.boundary >= replaceTarget.startLine &&
        // boundary === endLine is intentionally allowed: append-after-endLine
        // lands on the trailing boundary, not inside the replaced range. That is
        // only safe because bottom-up application sorts the boundary insert ahead
        // of the replace anchored to the same original end line; revisit this if
        // edit ordering semantics change.
        insertTarget.boundary < replaceTarget.endLine;
      if (insertsInsideReplace) {
        throwEditConflict(
          left,
          right,
          "cannot be applied together because one inserts inside a replaced original range",
        );
      }
    }
  }
}

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
  if (!edits.length) return { content, firstChangedLine: undefined, lastChangedLine: undefined };

  const workingEdits = edits.map(cloneHashlineEdit);
  const fileLines = content.split("\n");
  const hasTerminalNewline = content.endsWith("\n");
  const origLines = [...fileLines];
  let firstChanged: number | undefined;
  let lastChanged: number | undefined;
  const noopEdits: NoopEdit[] = [];
  const warnings: string[] = [];

  // Validate all refs before mutation
  const mismatches: HashMismatch[] = [];
  const retryLines = new Set<number>();
  const acceptedFuzzyRefs = new Set<string>();
  function validate(ref: Anchor): boolean {
    if (ref.line < 1 || ref.line > fileLines.length) {
      throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
    }
    const line = fileLines[ref.line - 1];
    const actual = computeLineHash(ref.line, line);
    if (actual === ref.hash) return true;
    if (ref.textHint !== undefined) {
      const hintedHash = computeLineHash(ref.line, ref.textHint);
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
    mismatches.push({ line: ref.line, expected: ref.hash, actual });
    retryLines.add(ref.line);
    return false;
  }

  // Pre-validate: collect all hash mismatches before mutating
  for (const edit of workingEdits) {
    throwIfAborted(signal);
    switch (edit.op) {
      case "replace": {
        if (edit.end) {
          if (edit.pos.line > edit.end.line) {
            throw new Error(
              `Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`,
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
        } else {
          if (!validate(edit.pos)) continue;
        }
        break;
      }
      case "append": {
        if (edit.pos && !validate(edit.pos)) continue;
        if (edit.lines.length === 0) {
          throw new Error(
            "Append with empty lines payload. Provide content to insert or remove the edit.",
          );
        }
        break;
      }
      case "prepend": {
        if (edit.pos && !validate(edit.pos)) continue;
        if (edit.lines.length === 0) {
          throw new Error(
            "Prepend with empty lines payload. Provide content to insert or remove the edit.",
          );
        }
        break;
      }
    }
  }
  if (mismatches.length)
    throw new Error(formatMismatchError(mismatches, fileLines, retryLines));

  // Deduplicate identical edits without mutating caller-owned input.
  const seenEditKeys = new Map<string, number>();
  const dedupedEdits: HashlineEdit[] = [];
  for (const edit of workingEdits) {
    throwIfAborted(signal);
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
      continue;
    }
    seenEditKeys.set(dstKey, dedupedEdits.length);
    dedupedEdits.push(edit);
  }

  assertNoConflictingEdits(dedupedEdits, fileLines.length);
  maybeAutocorrectEscapedTabIndentation(dedupedEdits, warnings, fileLines);
  maybeWarnSuspiciousUnicodeEscapePlaceholder(dedupedEdits, warnings);

  // Compute sort key (descending) — bottom-up application
  const annotated = dedupedEdits.map((edit, idx) => {
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

  annotated.sort(
    (a, b) =>
      b.sortLine - a.sortLine || a.precedence - b.precedence || a.idx - b.idx,
  );


  // Apply edits bottom-up
  for (const { edit, idx } of annotated) {
    throwIfAborted(signal);
    switch (edit.op) {
      case "replace": {
        if (!edit.end) {
          const origLine = origLines.slice(edit.pos.line - 1, edit.pos.line);
          const newLines = edit.lines;
          if (
            origLine.length === newLines.length &&
            origLine.every((line, i) => line === newLines[i])
          ) {
            noopEdits.push({
              editIndex: idx,
              loc: `${edit.pos.line}#${edit.pos.hash}`,
              currentContent: origLine.join("\n"),
            });
            break;
          }
          fileLines.splice(edit.pos.line - 1, 1, ...newLines);
          if (newLines.length > 0) {
            trackRange(edit.pos.line, edit.pos.line + newLines.length - 1);
          } else {
            track(edit.pos.line);
          }
        } else {
          const count = edit.end.line - edit.pos.line + 1;
          const orig = origLines.slice(
            edit.pos.line - 1,
            edit.pos.line - 1 + count,
          );

          // Noop check on range replaces
          if (
            orig.length === edit.lines.length &&
            orig.every((line, i) => line === edit.lines[i])
          ) {
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
          const trailingReplacementLine =
            newLines[newLines.length - 1]?.trimEnd();
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
          if (newLines.length > 0) {
            trackRange(edit.pos.line, edit.pos.line + newLines.length - 1);
          } else {
            track(edit.pos.line);
          }
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
          const insertAt =
            hasTerminalNewline && edit.pos.line === fileLines.length
              ? fileLines.length - 1
              : edit.pos.line;
          fileLines.splice(insertAt, 0, ...inserted);
          trackRange(insertAt + 1, insertAt + inserted.length);
        } else {
          if (fileLines.length === 1 && fileLines[0] === "") {
            fileLines.splice(0, 1, ...inserted);
            trackRange(1, inserted.length);
          } else {
            const insertAt = hasTerminalNewline ? fileLines.length - 1 : fileLines.length;
            fileLines.splice(insertAt, 0, ...inserted);
            trackRange(insertAt + 1, insertAt + inserted.length);
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
          trackRange(edit.pos.line, edit.pos.line + inserted.length - 1);
        } else if (fileLines.length === 1 && fileLines[0] === "") {
          fileLines.splice(0, 1, ...inserted);
          trackRange(1, inserted.length);
        } else {
          fileLines.splice(0, 0, ...inserted);
          trackRange(1, inserted.length);
        }
        break;
      }
    }
  }


  return {
    content: fileLines.join("\n"),
    firstChangedLine: firstChanged,
    lastChangedLine: lastChanged,
    ...(warnings.length ? { warnings } : {}),
    ...(noopEdits.length ? { noopEdits } : {}),
  };

  function track(line: number): void {
    if (firstChanged === undefined || line < firstChanged) {
      firstChanged = line;
    }
    if (lastChanged === undefined || line > lastChanged) {
      lastChanged = line;
    }
  }

  function trackRange(start: number, end: number): void {
    track(start);
    track(end);
  }
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

  if (end - start + 1 > maxOutputLines) {
    return null;
  }

  return { start, end };
}
