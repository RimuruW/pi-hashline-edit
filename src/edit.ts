import type { ExtensionAPI, EditToolDetails } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { readFileSync } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { constants } from "fs";
import { deleteFileIfExists, ensureMoveDestinationAvailable, validateFileOperationRequest, writeEditResult } from "./edit-fileops";
import { detectLineEnding, generateDiffString, normalizeToLF, replaceText, restoreLineEndings, stripBom } from "./edit-diff";
import {
	applyHashlineEdits,
	computeLineHash,
	parseLineRef,
	resolveEditAnchors,
	type HashlineToolEdit,
} from "./hashline";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";

// ─── Helpers ────────────────────────────────────────────────────────────

function StringEnum<T extends string[]>(values: [...T]) {
	return Type.Unsafe<T[number]>({ type: "string", enum: values });
}

// ─── Schema ─────────────────────────────────────────────────────────────

const hashlineEditItemSchema = Type.Object(
	{
		op: StringEnum(["replace", "append", "prepend"]),
		pos: Type.Optional(Type.String({ description: "anchor" })),
		end: Type.Optional(Type.String({ description: "limit position" })),
		lines: Type.Union([
			Type.Array(Type.String(), { description: "content (preferred format)" }),
			Type.String(),
			Type.Null(),
		]),
	},
	{ additionalProperties: false },
);

/** Schema for text search-replace edits (fallback mode). */
const textReplaceSchema = Type.Object(
	{
		old_text: Type.String(),
		new_text: Type.String(),
		all: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const hashlineEditSchema = Type.Object(
	{
		path: Type.String({ description: "path" }),
		edits: Type.Optional(Type.Array(hashlineEditItemSchema, { description: "edits over $path" })),
		delete: Type.Optional(Type.Boolean({ description: "If true, delete $path" })),
		move: Type.Optional(Type.String({ description: "If set, move $path to $move" })),
		text_replace: Type.Optional(Type.Array(textReplaceSchema, { description: "text search-replace operations" })),
	},
	{ additionalProperties: true },
);

type HashlineParams = Static<typeof hashlineEditSchema>;

const EDIT_DESC = readFileSync(new URL("../prompts/edit.md", import.meta.url), "utf-8").trim();

// ─── Registration ───────────────────────────────────────────────────────

export function registerEditTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "edit",
		label: "Edit",
		description: EDIT_DESC,
		parameters: hashlineEditSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parsed = params as HashlineParams;
			const rawPath = parsed.path;
			const path = rawPath.replace(/^@/, "");
			const absolutePath = resolveToCwd(path, ctx.cwd);
			const deleteFile = parsed.delete;
			const move = parsed.move;
			const resolvedMove = move ? resolveToCwd(move.replace(/^@/, ""), ctx.cwd) : undefined;
			throwIfAborted(signal);

			// ── Validate conflicting file-level operations ──
			const hasEdits = Array.isArray(parsed.edits) && parsed.edits.length > 0;
			const hasTextReplace = Array.isArray(parsed.text_replace) && parsed.text_replace.length > 0;
			validateFileOperationRequest({ deleteFile, move, hasEdits, hasTextReplace });
			// ── File-level delete ──
			if (deleteFile) {
				await deleteFileIfExists(absolutePath);
				return {
					content: [{ type: "text", text: `Deleted ${path}` }],
					details: { diff: "", firstChangedLine: undefined } as EditToolDetails,
				};
			}
			let toolEdits: HashlineToolEdit[] = (parsed.edits ?? []) as HashlineToolEdit[];
			let textReplaceEdits = parsed.text_replace ?? [];

			if (!toolEdits.length && !textReplaceEdits.length && !move) {
				return {
					content: [{ type: "text", text: "No edits provided." }],
					isError: true,
					details: { diff: "", firstChangedLine: undefined } as EditToolDetails,
				};
			}

			try {
				await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
			} catch {
				throw new Error(`File not found: ${path}`);
			}

			// ── Validate move destination ──
			ensureMoveDestinationAvailable({ absolutePath, resolvedMove, move });
			throwIfAborted(signal);

			const raw = (await fsReadFile(absolutePath)).toString("utf-8");
			throwIfAborted(signal);

			const { bom, text: content } = stripBom(raw);
			const originalEnding = detectLineEnding(content);
			const originalNormalized = normalizeToLF(content);
			let result = originalNormalized;

			// Resolve flat tool edits → typed HashlineEdit objects and apply
			const resolved = resolveEditAnchors(toolEdits);
			const anchorResult = applyHashlineEdits(result, resolved, signal);
			result = anchorResult.content;

			// Apply text search-replace edits
			for (const r of textReplaceEdits) {
				throwIfAborted(signal);
				if (!r.old_text.length) throw new Error("old_text must not be empty.");
				const rep = replaceText(result, r.old_text, r.new_text, { all: r.all ?? false });
				if (!rep.count) throw new Error(`Could not find text to replace in ${path}.`);
				result = rep.content;
			}

			if (originalNormalized === result && !move) {
				let diagnostic = `No changes made to ${path}. The edits produced identical content.`;
				if (anchorResult.noopEdits?.length) {
					diagnostic +=
						"\n" +
						anchorResult.noopEdits
							.map(
								(e) =>
									`Edit ${e.editIndex}: replacement for ${e.loc} is identical to current content:\n  ${e.loc}: ${e.currentContent}`,
							)
							.join("\n");
					diagnostic += "\nYour content must differ from what the file already contains. Re-read the file to see the current state.";
				} else {
					// Edits were not literally identical but heuristics normalized them back
					const lines = result.split("\n");
					const targetLines: string[] = [];
					for (const edit of toolEdits) {
						const refs: string[] = [];
						if (edit.pos) refs.push(edit.pos);
						if (edit.end) refs.push(edit.end);
						for (const ref of refs) {
							try {
								const p = parseLineRef(ref);
								if (p.line >= 1 && p.line <= lines.length) {
									const lineContent = lines[p.line - 1];
									const hash = computeLineHash(p.line, lineContent);
									targetLines.push(`${p.line}#${hash}:${lineContent}`);
								}
							} catch {
								/* skip malformed refs */
							}
						}
					}
					if (targetLines.length > 0) {
						const preview = [...new Set(targetLines)].slice(0, 5).join("\n");
						diagnostic += `\nThe file currently contains:\n${preview}\nYour edits were normalized back to the original content. Ensure your replacement changes actual code, not just formatting.`;
					}
				}
				throw new Error(diagnostic);
			}

			throwIfAborted(signal);

			// ── Write result (possibly to moved path) ──
			await writeEditResult({
				absolutePath,
				resolvedMove,
				content: bom + restoreLineEndings(result, originalEnding),
				encoding: "utf-8",
			});

			const diffResult = generateDiffString(originalNormalized, result);
			const warnings: string[] = [];
			if (anchorResult.warnings?.length) warnings.push(...anchorResult.warnings);
			const warn = warnings.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";

			const resultText = move ? `Moved ${path} to ${move}` : `Updated ${path}`;
			return {
				content: [{ type: "text", text: `${resultText}${warn}` }],
				details: {
					diff: diffResult.diff,
					firstChangedLine: anchorResult.firstChangedLine ?? diffResult.firstChangedLine,
				} as EditToolDetails,
			};
		},
	});
}
