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
const HASHLINE_PREFIX_RE =
  /^\s*(?:>>>|>>)?\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;
const DIFF_PLUS_RE = /^\+(?!\+)/;

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

// ─── Parsing ────────────────────────────────────────────────────────────

export function parseLineRef(ref: string): { line: number; hash: string } {
  // Match LINE#HASH format, tolerating:
  //  - leading ">+" and whitespace (from mismatch/diff display)
  //  - optional trailing display suffix (":..." content)
  const match = ref.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/);
  if (!match)
    throw new Error(
      `Invalid line reference "${ref}". Expected "LINE#HASH" (e.g. "5#MQ").`,
    );
  const line = Number.parseInt(match[1], 10);
  if (line < 1)
    throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
  return { line, hash: match[2] };
}

// ─── Mismatch formatting ────────────────────────────────────────────────

function formatMismatchError(
  mismatches: HashMismatch[],
  fileLines: string[],
): string {
  const mismatchSet = new Map<number, HashMismatch>();
  for (const m of mismatches) mismatchSet.set(m.line, m);

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

  const sorted = [...displayLines].sort((a, b) => a - b);
  const out: string[] = [
    `${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Use the updated LINE#HASH references shown below (>>> marks changed lines).`,
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
      mismatchSet.has(num)
        ? `>>> ${prefix}:${content}`
        : `    ${prefix}:${content}`,
    );
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
    stripHash
      ? l.replace(HASHLINE_PREFIX_RE, "")
      : stripPlus
        ? l.replace(DIFF_PLUS_RE, "")
        : l,
  );
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
 * - append + pos or end → append after that anchor
 * - prepend + pos or end → prepend before that anchor
 * - no anchors → file-level append/prepend (only for those ops)
 *
 * Unknown or missing ops are rejected explicitly.
 */
export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
  const result: HashlineEdit[] = [];
  for (const edit of edits) {
    const lines = hashlineParseText(edit.lines);
    const tag = edit.pos ? parseLineRef(edit.pos) : undefined;
    const end = edit.end ? parseLineRef(edit.end) : undefined;

    const op = edit.op;
    if (op !== "replace" && op !== "append" && op !== "prepend") {
      throw new Error(
        `Unknown edit op "${op}". Expected "replace", "append", or "prepend".`,
      );
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
export function applyHashlineEdits(
  content: string,
  edits: HashlineEdit[],
  signal?: AbortSignal,
): {
  content: string;
  firstChangedLine: number | undefined;
  warnings?: string[];
  noopEdits?: NoopEdit[];
} {
  throwIfAborted(signal);
  if (!edits.length) return { content, firstChangedLine: undefined };

  const fileLines = content.split("\n");
  const origLines = [...fileLines];
  let firstChanged: number | undefined;
  const noopEdits: NoopEdit[] = [];
  const warnings: string[] = [];

  // Validate all refs before mutation
  const mismatches: HashMismatch[] = [];
  function validate(ref: Anchor): boolean {
    if (ref.line < 1 || ref.line > fileLines.length) {
      throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
    }
    const actual = computeLineHash(ref.line, fileLines[ref.line - 1]);
    if (actual === ref.hash) return true;
    mismatches.push({ line: ref.line, expected: ref.hash, actual });
    return false;
  }

  // Pre-validate: collect all hash mismatches before mutating
  for (const edit of edits) {
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
    throw new Error(formatMismatchError(mismatches, fileLines));

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
          track(edit.pos.line);
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
    warnings.push(
      `Edit changed ${diff} lines across ${edits.length} operations — verify no unintended reformatting.`,
    );
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
