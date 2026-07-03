/**
 * TUI rendering helpers for the edit tool.
 *
 * Extracted from `src/edit.ts` to separate presentation (color themes, diff
 * formatting, Markdown rendering) from tool execution logic.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { normalizeEditRequest } from "./edit-normalize";
import type { EditRequestParams } from "./edit";
import type { HashlineEditToolDetails } from "./edit-response";

// ─── Theme type aliases ─────────────────────────────────────────────────

export type FgTheme = Pick<Theme, "fg">;
export type CallTheme = Pick<Theme, "fg" | "bold">;
export type RenderedMarkdownTheme = Pick<
	Theme,
	"fg" | "bold" | "italic" | "underline" | "strikethrough"
>;

// ─── Render state ───────────────────────────────────────────────────────

export type EditPreview = { diff: string } | { error: string };

export type EditRenderState = {
	argsKey?: string;
	preview?: EditPreview;
	previewGeneration?: number;
};

// ─── Preview input extraction ───────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getRenderablePreviewInput(
	args: unknown,
): EditRequestParams | null {
	let normalized: unknown;
	try {
		normalized = normalizeEditRequest(args);
	} catch {
		return null;
	}
	if (
		!isRecord(normalized) ||
		typeof normalized.path !== "string" ||
		!Array.isArray(normalized.edits)
	) {
		return null;
	}

	return {
		path: normalized.path,
		edits: normalized.edits,
	} as EditRequestParams;
}

// ─── Diff formatting ────────────────────────────────────────────────────

export function colorDiffLines(lines: string[], theme: FgTheme): string[] {
	return lines.map((line) => {
		if (line.startsWith("+") && !line.startsWith("+++")) {
			return theme.fg("success", line);
		}
		if (line.startsWith("-") && !line.startsWith("---")) {
			return theme.fg("error", line);
		}
		return theme.fg("dim", line);
	});
}

export function formatPreviewDiff(
	diff: string,
	expanded: boolean,
	theme: FgTheme,
): string {
	const lines = diff.split("\n");
	const maxLines = expanded ? 40 : 16;
	const shown = colorDiffLines(lines.slice(0, maxLines), theme);

	if (lines.length > maxLines) {
		shown.push(
			theme.fg("muted", `... ${lines.length - maxLines} more diff lines`),
		);
	}
	return shown.join("\n");
}

export function formatResultDiff(diff: string, theme: FgTheme): string {
	return colorDiffLines(diff.split("\n"), theme).join("\n");
}

// ─── Edit call formatting ───────────────────────────────────────────────

export function formatEditCall(
	args: EditRequestParams | undefined,
	state: EditRenderState,
	expanded: boolean,
	theme: CallTheme,
): string {
	const path = args?.path;
	const pathDisplay =
		typeof path === "string" && path.length > 0
			? theme.fg("accent", path)
			: theme.fg("toolOutput", "...");
	let text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

	if (!state.preview) {
		return text;
	}

	if ("error" in state.preview) {
		text += `\n\n${theme.fg("error", state.preview.error)}`;
		return text;
	}

	if (state.preview.diff) {
		text += `\n\n${formatPreviewDiff(state.preview.diff, expanded, theme)}`;
	}
	return text;
}

// ─── Result text extraction ─────────────────────────────────────────────

export function getRenderedEditTextContent(result: {
	content?: Array<{ type: string; text?: string }>;
}): string | undefined {
	const textContent = result.content?.find(
		(entry): entry is { type: "text"; text: string } =>
			entry.type === "text" && typeof entry.text === "string",
	);
	return textContent?.text;
}

// ─── Result classification ──────────────────────────────────────────────

export function isAppliedChangedResult(
	details: HashlineEditToolDetails | undefined,
): boolean {
	return details?.classification === "applied";
}

export function buildAppliedChangedResultText(
	_text: string | undefined,
	details: HashlineEditToolDetails | undefined,
	preview: EditPreview | undefined,
	theme: FgTheme,
): string | undefined {
	const previewDiff =
		preview && !("error" in preview) ? preview.diff : undefined;
	const sections: string[] = [];

	if (details?.diff && details.diff !== previewDiff) {
		sections.push(formatResultDiff(details.diff, theme));
	}

	if (details?.warnings.length) {
		sections.push(["Warnings:", ...details.warnings].join("\n"));
	}

	return sections.length > 0 ? sections.join("\n\n") : undefined;
}

// ─── Markdown rendering ─────────────────────────────────────────────────

function trimEdgeEmptyLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;

	while (start < end && lines[start] === "") {
		start++;
	}
	while (end > start && lines[end - 1] === "") {
		end--;
	}

	return lines.slice(start, end);
}

function isRenderedEditSectionBoundary(line: string): boolean {
	return line.startsWith("--- Anchors ") || line === "Warnings:";
}

export function formatRenderedEditResultMarkdown(text: string): string {
	const lines = text.split("\n");
	const sections: string[] = [];
	let plainLines: string[] = [];

	const flushPlainLines = () => {
		const trimmed = trimEdgeEmptyLines(plainLines);
		if (trimmed.length > 0) {
			sections.push(trimmed.join("\n"));
		}
		plainLines = [];
	};

	let index = 0;
	while (index < lines.length) {
		const line = lines[index]!;

		if (line.startsWith("--- Anchors ")) {
			flushPlainLines();
			const title = line.replace(/^---\s*/, "").replace(/\s*---$/, "");
			index++;
			const bodyLines: string[] = [];
			while (
				index < lines.length &&
				!isRenderedEditSectionBoundary(lines[index]!)
			) {
				bodyLines.push(lines[index]!);
				index++;
			}
			sections.push(
				[
					`#### ${title}`,
					"```text",
					...trimEdgeEmptyLines(bodyLines),
					"```",
				].join("\n"),
			);
			continue;
		}

		plainLines.push(line);
		index++;
	}

	flushPlainLines();

	return sections.join("\n\n");
}

export function createRenderedEditMarkdownTheme(theme: RenderedMarkdownTheme) {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => (theme.italic ? theme.italic(text) : text),
		underline: (text: string) =>
			theme.underline ? theme.underline(text) : text,
		strikethrough: (text: string) =>
			theme.strikethrough ? theme.strikethrough(text) : text,
		highlightCode: (code: string, lang?: string) =>
			code.split("\n").map((line) => {
				if (lang === "diff") {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						return theme.fg("toolDiffAdded", line);
					}
					if (line.startsWith("-") && !line.startsWith("---")) {
						return theme.fg("toolDiffRemoved", line);
					}
					return theme.fg("toolDiffContext", line);
				}

				return theme.fg("mdCodeBlock", line);
			}),
	};
}
