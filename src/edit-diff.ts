import * as Diff from "diff";
import { getHashLength } from "./config";
import { computeLineHash } from "./hashline";

// ─── Line ending normalization ──────────────────────────────────────────

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(
	text: string,
	ending: "\r\n" | "\n",
): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// Returns true when content mixes line-ending styles \u2014 at least one CRLF and
// at least one bare LF (a \n not preceded by \r), or a lone \r combined with
// any other style. A file uniform in any one style returns false.
export function hasMixedLineEndings(content: string): boolean {
	const hasCrlf = /\r\n/.test(content);
	// Bare LF: a \n not immediately preceded by \r
	const hasBareLf = /(?<!\r)\n/.test(content);
	// Lone CR: a \r not followed by \n
	const hasLoneCr = /\r(?!\n)/.test(content);

	const styleCount = [hasCrlf, hasBareLf, hasLoneCr].filter(Boolean).length;
	return styleCount > 1;
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

// ─── Diff generation ────────────────────────────────────────────────────

function formatDiffPreviewLine(
	prefix: " " | "+" | "-",
	lineNum: number,
	lineNumWidth: number,
	line: string,
	includeHash: boolean,
	allNewLines?: readonly string[],
	newLineIndex?: number,
): string {
	const paddedLineNum = String(lineNum).padStart(lineNumWidth, " ");
	if (!includeHash) {
		// Pad to the width of the `#<hash>:` prefix so columns stay aligned.
		const pad = " ".repeat(getHashLength() + 2);
		return `${prefix}${paddedLineNum}${pad}${line}`;
	}
	const hash = allNewLines !== undefined && newLineIndex !== undefined
		? computeLineHash(allNewLines, newLineIndex)
		: computeLineHash([line], 0);  // fallback: single-element array
	return `${prefix}${paddedLineNum}#${hash}:${line}`;
}

export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string } {
	const parts = Diff.diffLines(oldContent, newContent);
	const newLines = newContent.split("\n");
	const output: string[] = [];
	const maxLineNum = Math.max(
		oldContent.split("\n").length,
		newContent.split("\n").length,
	);
	const lineNumWidth = String(maxLineNum).length;
	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			for (const line of raw) {
				if (part.added) {
					output.push(
						formatDiffPreviewLine("+", newLineNum, lineNumWidth, line, true, newLines, newLineNum - 1),
					);
					newLineNum++;
				} else {
					output.push(
						formatDiffPreviewLine("-", oldLineNum, lineNumWidth, line, false),
					);
					oldLineNum++;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextPartIsChange =
			i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed);
		if (lastWasChange || nextPartIsChange) {
			let linesToShow = raw;
			let skipStart = 0;
			let skipEnd = 0;

			if (!lastWasChange) {
				skipStart = Math.max(0, raw.length - contextLines);
				linesToShow = raw.slice(skipStart);
			}
			if (!nextPartIsChange && linesToShow.length > contextLines) {
				skipEnd = linesToShow.length - contextLines;
				linesToShow = linesToShow.slice(0, contextLines);
			}

			if (skipStart > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipStart;
				newLineNum += skipStart;
			}
			for (const line of linesToShow) {
				output.push(
					formatDiffPreviewLine(" ", newLineNum, lineNumWidth, line, true, newLines, newLineNum - 1),
				);
				oldLineNum++;
				newLineNum++;
			}
			if (skipEnd > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipEnd;
				newLineNum += skipEnd;
			}
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}
		lastWasChange = false;
	}

	return { diff: output.join("\n") };
}
