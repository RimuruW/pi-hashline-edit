/**
 * Single normalization layer that maps the dialects a model may emit onto the
 * canonical hashline edit request before validation runs.
 *
 * Why this exists: Pi's built-in `edit` tool uses `{ path, edits: [{ oldText,
 * newText }] }` text matching. This extension overrides that tool with hashline
 * anchors, but a model carrying Pi's native contract (or resuming a session that
 * used it) will still send the native shapes. Rather than rejecting those calls
 * and burning a turn, we converge every known dialect here, in one place, so the
 * rest of the pipeline only ever sees the canonical form:
 *
 *   { path, edits: [{ op, ... }] }
 *
 * This runs as the tool's `prepareArguments` hook, which Pi executes before AJV
 * schema validation and before `execute()`. The output is plain enumerable data
 * (an `edits` array); compatibility state must never be attached as hidden
 * object metadata because Pi may `structuredClone` prepared arguments and drop
 * non-enumerable properties.
 *
 * Scope guard: this layer only rewrites *field shape* (aliases, native field
 * names, missing `op`). It never touches hashline diff semantics — anchors,
 * ranges, boundary content, or `lines` payloads pass through untouched. That
 * keeps the strict-semantics guarantee (the runtime never silently patches a
 * diff) intact while still absorbing dialect noise.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse `edits` when a model serializes it as a JSON string instead of an array
 * (observed with some models, mirrors Pi's built-in edit handling).
 */
function coerceEditsArray(edits: unknown): unknown {
	if (typeof edits !== "string") {
		return edits;
	}
	try {
		const parsed: unknown = JSON.parse(edits);
		return Array.isArray(parsed) ? parsed : edits;
	} catch {
		return edits;
	}
}

const TOP_LEVEL_TEXT_REPLACE_KEYS = [
	"oldText",
	"newText",
	"old_text",
	"new_text",
] as const;

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key);
}

/**
 * Validate top-level native replace aliases before folding them. The normalizer
 * must not hide ambiguous or malformed dialect fields from validation.
 */
function assertTopLevelTextReplaceAliases(
	record: Record<string, unknown>,
): void {
	const presentKeys = TOP_LEVEL_TEXT_REPLACE_KEYS.filter((key) =>
		hasOwn(record, key),
	);
	if (presentKeys.length === 0) {
		return;
	}

	for (const key of presentKeys) {
		if (typeof record[key] !== "string") {
			throw new Error(`Edit request field "${key}" must be a string.`);
		}
	}

	const hasCamel = hasOwn(record, "oldText") || hasOwn(record, "newText");
	const hasSnake = hasOwn(record, "old_text") || hasOwn(record, "new_text");
	if (hasCamel && hasSnake) {
		throw new Error(
			"Edit request cannot mix legacy camelCase and snake_case fields. Use either oldText/newText or old_text/new_text.",
		);
	}

	if (hasCamel && (!hasOwn(record, "oldText") || !hasOwn(record, "newText"))) {
		throw new Error(
			"Legacy top-level replace requires both oldText and newText.",
		);
	}
	if (
		hasSnake &&
		(!hasOwn(record, "old_text") || !hasOwn(record, "new_text"))
	) {
		throw new Error(
			"Legacy top-level replace requires both old_text and new_text.",
		);
	}
}

/**
 * Resolve the top-level native text-replace fields into a single
 * `{ oldText, newText }` pair, honoring both camelCase and snake_case. Returns
 * null when neither complete pair is present.
 */
function extractTopLevelTextReplace(
	record: Record<string, unknown>,
): { oldText: string; newText: string } | null {
	if (
		typeof record.oldText === "string" &&
		typeof record.newText === "string"
	) {
		return { oldText: record.oldText, newText: record.newText };
	}
	if (
		typeof record.old_text === "string" &&
		typeof record.new_text === "string"
	) {
		return { oldText: record.old_text, newText: record.new_text };
	}
	return null;
}

/**
 * Drop every top-level native text-replace key from a record. Used after the
 * pair has been folded into the canonical `edits` array.
 */
function stripTopLevelTextReplaceKeys(
	record: Record<string, unknown>,
): Record<string, unknown> {
	const {
		oldText: _oldText,
		newText: _newText,
		old_text: _oldSnake,
		new_text: _newSnake,
		...rest
	} = record;
	return rest;
}

/**
 * Give an edit item an explicit `op` when the model supplied `oldText`/`newText`
 * without one. The native edit contract has no `op` field, so a model using that
 * contract emits `{ oldText, newText }` bare; we treat that as `replace_text`.
 * Items that already declare an `op`, or that are not text-replace shaped, are
 * returned untouched.
 */
function backfillEditOp(item: unknown): unknown {
	if (!isRecord(item)) {
		return item;
	}
	if (typeof item.op === "string") {
		return item;
	}
	if (typeof item.oldText === "string" && typeof item.newText === "string") {
		return { op: "replace_text", ...item };
	}
	return item;
}

/**
 * Normalize a raw edit-tool request into the canonical hashline shape.
 *
 * Returns the input unchanged when it is not an object, so malformed payloads
 * still reach validation and surface a precise error there.
 */
export function normalizeEditRequest(input: unknown): unknown {
	if (!isRecord(input)) {
		return input;
	}

	const record: Record<string, unknown> = { ...input };

	// file_path → path alias.
	if (typeof record.path !== "string" && typeof record.file_path === "string") {
		record.path = record.file_path;
		delete record.file_path;
	}

	assertTopLevelTextReplaceAliases(record);

	const hasEditsField = hasOwn(record, "edits");

	// edits-as-JSON-string → array.
	if (hasEditsField) {
		record.edits = coerceEditsArray(record.edits);
	}

	const existingEdits = Array.isArray(record.edits) ? record.edits : undefined;

	// Top-level native oldText/newText with no structured edits → fold into edits
	// as a replace_text item. When structured edits already exist, or when an
	// edits field is present but malformed, leave top-level keys for validation
	// to reject instead of hiding ambiguity.
	if (!hasEditsField || existingEdits?.length === 0) {
		const topLevel = extractTopLevelTextReplace(record);
		if (topLevel) {
			const stripped = stripTopLevelTextReplaceKeys(record);
			return {
				...stripped,
				edits: [{ op: "replace_text", ...topLevel }],
			};
		}
	}

	// Backfill missing op on edit items that look like native text replacements.
	if (existingEdits) {
		record.edits = existingEdits.map(backfillEditOp);
	}

	return record;
}
