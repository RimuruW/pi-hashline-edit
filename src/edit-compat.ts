export type LegacyTopLevelReplace = {
  oldText: string;
  newText: string;
  strategy: "legacy-top-level-replace";
};

export function extractLegacyTopLevelReplace(
  request: Record<string, unknown>,
): LegacyTopLevelReplace | null {
  if (Array.isArray(request.edits)) {
    return null;
  }

  const oldText =
    typeof request.oldText === "string"
      ? request.oldText
      : typeof request.old_text === "string"
        ? request.old_text
        : null;
  const newText =
    typeof request.newText === "string"
      ? request.newText
      : typeof request.new_text === "string"
        ? request.new_text
        : null;

  if (oldText === null || newText === null) {
    return null;
  }

  return {
    oldText,
    newText,
    strategy: "legacy-top-level-replace",
  };
}

export function applyExactUniqueLegacyReplace(
  content: string,
  oldText: string,
  newText: string,
): {
  content: string;
  matchCount: 1;
} {
  if (oldText.length === 0) {
    throw new Error("Legacy compatibility replace requires non-empty oldText.");
  }

  const matches: number[] = [];
  let from = 0;
  while (from <= content.length - oldText.length) {
    const index = content.indexOf(oldText, from);
    if (index === -1) {
      break;
    }
    matches.push(index);
    from = index + Math.max(1, oldText.length);
  }

  if (matches.length === 0) {
    throw new Error(
      "Legacy compatibility replace found no exact match in the current file.",
    );
  }

  if (matches.length > 1) {
    throw new Error(
      "Legacy compatibility replace found multiple exact matches; re-read and use hashline edits.",
    );
  }

  const index = matches[0]!;
  return {
    content: content.slice(0, index) + newText + content.slice(index + oldText.length),
    matchCount: 1,
  };
}
