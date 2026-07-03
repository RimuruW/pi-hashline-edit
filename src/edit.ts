import { Markdown, Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "@sinclair/typebox";
import { constants } from "fs";
import { readFileSync } from "fs";
import { access as fsAccess } from "fs/promises";
import {
	detectLineEnding,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff";
import { normalizeEditRequest } from "./edit-normalize";
import { resolveMutationTargetPath, writeFileAtomically } from "./fs-write";
import {
	applyHashlineEdits,
	resolveEditAnchors,
	type HashlineToolEdit,
} from "./hashline";
import { loadFileKindAndText } from "./file-kind";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";
import {
	buildChangedResponse,
	buildNoopResponse,
	type EditMeta,
	type HashlineEditToolDetails,
} from "./edit-response";
import {
	buildAppliedChangedResultText,
	createRenderedEditMarkdownTheme,
	formatEditCall,
	formatRenderedEditResultMarkdown,
	getRenderablePreviewInput,
	getRenderedEditTextContent,
	isAppliedChangedResult,
	type EditPreview,
	type EditRenderState,
} from "./edit-render";

function literalStringSchema<const Value extends string>(
	value: Value,
	options: { description: string },
) {
	return Type.Unsafe<Value>({
		type: "string",
		enum: [value],
		description: options.description,
	});
}

const hashlineEditLinesSchema = Type.Array(Type.String(), {
	description:
		"replacement content, one array entry per line, no LINE#HASH prefix",
});

const hashlineReplaceEditSchema = Type.Object(
	{
		op: literalStringSchema("replace", {
			description:
				"replace one line at pos, or an inclusive pos..end range, with lines",
		}),
		pos: Type.String({ description: "start anchor (LINE#HASH from read)" }),
		end: Type.Optional(
			Type.String({
				description:
					"inclusive end anchor (LINE#HASH) of the range to replace; omit to replace only the line at pos",
			}),
		),
		lines: hashlineEditLinesSchema,
	},
	{ additionalProperties: false },
);

const hashlineAppendEditSchema = Type.Object(
	{
		op: literalStringSchema("append", {
			description: "insert lines after pos; omit pos to append at EOF",
		}),
		pos: Type.Optional(
			Type.String({ description: "anchor (LINE#HASH from read) to insert after" }),
		),
		lines: hashlineEditLinesSchema,
	},
	{ additionalProperties: false },
);

const hashlinePrependEditSchema = Type.Object(
	{
		op: literalStringSchema("prepend", {
			description: "insert lines before pos; omit pos to prepend at BOF",
		}),
		pos: Type.Optional(
			Type.String({
				description: "anchor (LINE#HASH from read) to insert before",
			}),
		),
		lines: hashlineEditLinesSchema,
	},
	{ additionalProperties: false },
);

const hashlineReplaceTextEditSchema = Type.Object(
	{
		op: literalStringSchema("replace_text", {
			description: "replace an exact unique substring with newText",
		}),
		oldText: Type.String({
			description: "exact text to replace; must be unique in the file",
		}),
		newText: Type.String({ description: "replacement text" }),
	},
	{ additionalProperties: false },
);

const hashlineEditItemSchema = Type.Union(
	[
		hashlineReplaceEditSchema,
		hashlineAppendEditSchema,
		hashlinePrependEditSchema,
		hashlineReplaceTextEditSchema,
	],
	{
		description:
			'discriminated edit item. "replace" uses pos/end/lines; "append" and "prepend" use optional pos + lines; "replace_text" uses oldText/newText.',
	},
);

export const hashlineEditToolSchema = Type.Object(
	{
		path: Type.String({ description: "path" }),
		edits: Type.Array(hashlineEditItemSchema, { description: "edits over $path" }),
		// Native Pi edit dialects (top-level oldText/newText, old_text/new_text,
		// file_path alias, JSON-string edits) are folded into the canonical `edits`
		// shape by normalizeEditRequest in the prepareArguments hook, which runs
		// before this schema is validated. By the time AJV sees the request those
		// fields no longer exist, so the published schema stays minimal and the
		// model is never shown a non-hashline path. See src/edit-normalize.ts.
	},
	{ additionalProperties: false },
);
export type EditRequestParams = {
	path: string;
	edits: HashlineToolEdit[];
};

const EDIT_DESC = readFileSync(
	new URL("../prompts/edit.md", import.meta.url),
	"utf-8",
).trim();

const EDIT_PROMPT_SNIPPET = readFileSync(
	new URL("../prompts/edit-snippet.md", import.meta.url),
	"utf-8",
).trim();

const EDIT_PROMPT_GUIDELINES = readFileSync(
	new URL("../prompts/edit-guidelines.md", import.meta.url),
	"utf-8",
)
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line.startsWith("- "))
	.map((line) => line.slice(2));

const ROOT_KEYS = new Set(["path", "edits"]);
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validates the canonical edit request envelope after normalizeEditRequest has
// converged any model dialects. Per-edit structural validation is delegated to
// resolveEditAnchors (src/hashline.ts), which is the single source of truth for
// edit-item shape + op constraints. This function validates only the root-level
// request fields: path and that edits is an array.
//
// Intentional overlap with the published TypeBox schema: pi normally runs AJV
// validation before execute(), but that can be disabled in environments without
// runtime code generation support, so the semantic checks here are the backstop.
export function assertEditRequest(
	request: unknown,
): asserts request is EditRequestParams {
	if (!isRecord(request)) {
		throw new Error("Edit request must be an object.");
	}

	const unknownRootKeys = Object.keys(request).filter(
		(key) => !ROOT_KEYS.has(key),
	);
	if (unknownRootKeys.length > 0) {
		throw new Error(
			`Edit request contains unknown or unsupported fields: ${unknownRootKeys.join(", ")}.`,
		);
	}

	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error('Edit request requires a non-empty "path" string.');
	}

	if (!Array.isArray(request.edits)) {
		throw new Error('Edit request requires an "edits" array.');
	}

	// Per-edit validation lives in resolveEditAnchors — the single source of
	// truth for edit-item shape, op constraints, and anchor parsing.
}

/**
 * Shared edit pipeline: read file, resolve anchors, and apply edits. Public
 * entrypoints normalize + validate before calling this; access mode controls
 * whether the file must be writable.
 */
async function executeEditPipeline(
	params: EditRequestParams,
	cwd: string,
	accessMode: number,
	signal?: AbortSignal,
	resolvedPath?: string,
): Promise<{
	path: string;
	originalNormalized: string;
	result: string;
	bom: string;
	originalEnding: "\r\n" | "\n";
	hadUtf8DecodeErrors: boolean;
	warnings: string[];
	noopEdits?: { editIndex: number; loc: string; currentContent: string }[];
	firstChangedLine?: number;
	lastChangedLine?: number;
}> {
	const path = params.path;
	const absolutePath = resolvedPath ?? resolveToCwd(path, cwd);
	const toolEdits = params.edits;

	if (toolEdits.length === 0) {
		throw new Error("No edits provided.");
	}

	throwIfAborted(signal);
	try {
		await fsAccess(absolutePath, accessMode);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(`File not found: ${path}. Use the write tool to create new files.`);
		}
		if (code === "EACCES" || code === "EPERM") {
			const accessLabel =
				accessMode & constants.W_OK ? "not writable" : "not readable";
			throw new Error(`File is ${accessLabel}: ${path}`);
		}
		throw new Error(`Cannot access file: ${path}`);
	}

	throwIfAborted(signal);
	const file = await loadFileKindAndText(absolutePath);
	if (file.kind === "directory") {
		throw new Error(
			`Path is a directory: ${path}. Use ls to inspect directories.`,
		);
	}
	if (file.kind === "image") {
		throw new Error(
			`Path is an image file: ${path}. Hashline edit only supports text files.`,
		);
	}
	if (file.kind === "binary") {
		throw new Error(
			`Path is a binary file: ${path} (${file.description}). Hashline edit only supports text files.`,
		);
	}

	throwIfAborted(signal);
	const { bom, text: rawContent } = stripBom(file.text);
	const originalEnding = detectLineEnding(rawContent);
	const originalNormalized = normalizeToLF(rawContent);

	const resolved = resolveEditAnchors(toolEdits);
	const anchorResult = applyHashlineEdits(originalNormalized, resolved, signal);

	return {
		path,
		originalNormalized,
		result: anchorResult.content,
		bom,
		originalEnding,
		hadUtf8DecodeErrors: file.hadUtf8DecodeErrors === true,
		warnings: [...(anchorResult.warnings ?? [])],
		noopEdits: anchorResult.noopEdits,
		firstChangedLine: anchorResult.firstChangedLine,
		lastChangedLine: anchorResult.lastChangedLine,
	};
}

export async function computeEditPreview(
	request: unknown,
	cwd: string,
): Promise<EditPreview> {
	try {
		const normalized = normalizeEditRequest(request);
		assertEditRequest(normalized);
		const { path, originalNormalized, result } = await executeEditPipeline(
			normalized,
			cwd,
			constants.R_OK,
		);

		if (originalNormalized === result) {
			return {
				error: `No changes made to ${path}. The edits produced identical content.`,
			};
		}

		return { diff: generateDiffString(originalNormalized, result).diff };
	} catch (error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

// TParams is intentionally TSchema, not typeof hashlineEditToolSchema. The
// published `parameters` schema stays strict (discriminated anyOf) for the
// model, but the internal prepareArguments/execute surface treats params as
// unknown and defers per-item validation to resolveEditAnchors during
// execute. Typing it as Static<typeof hashlineEditToolSchema> would claim
// per-item conformance that prepareArguments does not actually enforce
// (assertEditRequest only validates the envelope).
type EditToolDefinition = ToolDefinition<
	TSchema,
	HashlineEditToolDetails,
	EditRenderState
> & { renderShell?: "default" | "self" };

function reuseTextComponent(lastComponent: unknown): Text {
	return lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
}

function renderTextResult(
	lastComponent: unknown,
	textContent: string | undefined,
): Text {
	if (!textContent) {
		return new Text("", 0, 0);
	}
	const text = reuseTextComponent(lastComponent);
	text.setText(textContent);
	return text;
}

const editToolDefinition: EditToolDefinition = {
	name: "edit",
	label: "Edit",
	description: EDIT_DESC,
	parameters: hashlineEditToolSchema,
	promptSnippet: EDIT_PROMPT_SNIPPET,
	promptGuidelines: EDIT_PROMPT_GUIDELINES,
	// Converge model dialects (native oldText/newText, JSON-string edits, missing
	// op, file_path alias) onto the canonical hashline shape before Pi validates
	// and before execute(). See src/edit-normalize.ts.
	prepareArguments: (args: unknown) => {
		const normalized = normalizeEditRequest(args);
		assertEditRequest(normalized);
		return normalized;
	},
	// Force the default tool shell (Box with pending/success/error background) so
	// we don't inherit renderShell: "self" from the built-in edit tool of the
	// same name, which would drop the shared background color block.
	renderShell: "default",
	renderCall(args, theme, context) {
		const previewInput = getRenderablePreviewInput(args);
		const resetPreview = () => {
			context.state.argsKey = undefined;
			context.state.preview = undefined;
			context.state.previewGeneration =
				(context.state.previewGeneration ?? 0) + 1;
		};
		if (context.executionStarted) {
			resetPreview();
		} else if (!context.argsComplete || !previewInput) {
			resetPreview();
		} else {
			const argsKey = JSON.stringify(previewInput);
			if (context.state.argsKey !== argsKey) {
				context.state.argsKey = argsKey;
				context.state.preview = undefined;
				const previewGeneration = (context.state.previewGeneration ?? 0) + 1;
				context.state.previewGeneration = previewGeneration;
				computeEditPreview(previewInput, context.cwd)
					.then((preview) => {
						if (
							context.state.argsKey === argsKey &&
							context.state.previewGeneration === previewGeneration
						) {
							context.state.preview = preview;
							context.invalidate();
						}
					})
					.catch((err: unknown) => {
						if (
							context.state.argsKey === argsKey &&
							context.state.previewGeneration === previewGeneration
						) {
							context.state.preview = {
								error: err instanceof Error ? err.message : String(err),
							};
							context.invalidate();
						}
					});
			}
		}
		const text =
			(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatEditCall(
				previewInput ?? undefined,
				context.state as EditRenderState,
				context.expanded,
				theme,
			),
		);
		return text;
	},

	renderResult(result, { isPartial }, theme, context) {
		if (isPartial) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("warning", "Editing..."));
			return text;
		}

		const typedResult = result as {
			content?: Array<{ type: string; text?: string }>;
			details?: HashlineEditToolDetails;
		};
		const renderedText = getRenderedEditTextContent(typedResult);

		const renderState = context.state as EditRenderState | undefined;
		const previewBeforeResult = renderState?.preview;
		if (renderState) {
			renderState.preview = undefined;
			renderState.previewGeneration = (renderState.previewGeneration ?? 0) + 1;
		}

		if (context.isError) {
			return renderTextResult(
				context.lastComponent,
				renderedText ? `\n${theme.fg("error", renderedText)}` : undefined,
			);
		}

		if (isAppliedChangedResult(typedResult.details)) {
			const appliedChangedText = buildAppliedChangedResultText(
				renderedText,
				typedResult.details,
				previewBeforeResult,
				theme,
			);
			return renderTextResult(context.lastComponent, appliedChangedText);
		}

		if (!renderedText) {
			return new Text("", 0, 0);
		}

		const markdown =
			context.lastComponent instanceof Markdown
				? context.lastComponent
				: new Markdown("", 0, 0, createRenderedEditMarkdownTheme(theme));
		markdown.setText(formatRenderedEditResultMarkdown(renderedText));
		return markdown;
	},

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		// normalizeEditRequest is re-applied here so execute does not depend on
		// prepareArguments having run. Idempotent on canonical input.
		const normalized = normalizeEditRequest(params);
		assertEditRequest(normalized);
		const normalizedParams = normalized;
		const path = normalizedParams.path;
		const absolutePath = resolveToCwd(path, ctx.cwd);
		const mutationTargetPath = await resolveMutationTargetPath(absolutePath);
		return withFileMutationQueue(mutationTargetPath, async () => {
			throwIfAborted(signal);

			const {
				originalNormalized,
				result,
				bom,
				originalEnding,
				hadUtf8DecodeErrors,
				warnings,
				noopEdits,
				firstChangedLine,
				lastChangedLine,
			} = await executeEditPipeline(
				normalizedParams,
				ctx.cwd,
				constants.R_OK | constants.W_OK,
				signal,
				mutationTargetPath,
			);

			const editsAttempted = normalizedParams.edits.length;

			if (originalNormalized === result) {
				const noopSnapshotId = (
					await getFileSnapshot(mutationTargetPath, { alreadyResolved: true })
				).snapshotId;
				return buildNoopResponse({
					path,
					noopEdits,
					snapshotId: noopSnapshotId,
					editMeta: {
						editsAttempted,
						noopEditsCount: noopEdits?.length ?? 0,
					},
					warnings,
				});
			}

			if (hadUtf8DecodeErrors) {
				warnings.push(
					"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
				);
			}

			throwIfAborted(signal);
			await writeFileAtomically(
				mutationTargetPath,
				bom + restoreLineEndings(result, originalEnding),
				{ alreadyResolved: true },
			);
			const updatedSnapshotId = (
				await getFileSnapshot(mutationTargetPath, { alreadyResolved: true })
			).snapshotId;

			const editMeta: EditMeta = {
				editsAttempted,
				noopEditsCount: noopEdits?.length ?? 0,
				firstChangedLine,
				lastChangedLine,
			};

			const successInput = {
				originalNormalized,
				result,
				warnings,
				snapshotId: updatedSnapshotId,
				editMeta,
			};

			return buildChangedResponse(successInput);
		});
	},
};

export function registerEditTool(pi: ExtensionAPI): void {
	pi.registerTool(editToolDefinition);
}
