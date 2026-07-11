import { describe, expect, it, vi } from "vitest";
import {
	buildAppliedChangedResultText,
	colorDiffLines,
	formatPreviewDiff,
	formatResultDiff,
	type FgTheme,
} from "../../src/edit-render";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	keyHint: () => "ctrl+o to expand",
}));

function makeTokenTheme(): FgTheme {
	return {
		fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
	} as FgTheme;
}

describe("edit diff rendering", () => {
	it("colors added, removed, and context diff lines without treating headers as changes", () => {
		const result = colorDiffLines(
			[
				"+++ b/sample.txt",
				"--- a/sample.txt",
				" unchanged",
				"+added",
				"-removed",
			],
			makeTokenTheme(),
		);

		expect(result).toEqual([
			"<dim>+++ b/sample.txt</dim>",
			"<dim>--- a/sample.txt</dim>",
			"<dim> unchanged</dim>",
			"<success>+added</success>",
			"<error>-removed</error>",
		]);
	});

	it("collapses preview and result diffs to ten lines until expanded", () => {
		const diff = Array.from({ length: 12 }, (_, index) => ` line-${String(index + 1).padStart(2, "0")}`).join(
			"\n",
		);
		const theme = makeTokenTheme();

		const collapsedPreview = formatPreviewDiff(diff, false, theme);
		expect(collapsedPreview).toContain("line-10");
		expect(collapsedPreview).not.toContain("line-11");
		expect(collapsedPreview).toContain("ctrl+o to expand");

		const expandedPreview = formatPreviewDiff(diff, true, theme);
		expect(expandedPreview).toContain("line-12");
		expect(expandedPreview).not.toContain("to expand");

		const collapsedResult = formatResultDiff(diff, false, theme);
		expect(collapsedResult).toBe(collapsedPreview);

		const expandedResult = formatResultDiff(diff, true, theme);
		expect(expandedResult).toBe(expandedPreview);

		const details = {
			classification: "applied",
			diff,
			warnings: [],
		} as NonNullable<Parameters<typeof buildAppliedChangedResultText>[1]>;
		expect(buildAppliedChangedResultText(undefined, details, undefined, false, theme)).toBe(collapsedPreview);
		expect(buildAppliedChangedResultText(undefined, details, undefined, true, theme)).toBe(expandedPreview);

		const collapsedAgain = formatPreviewDiff(diff, false, theme);
		expect(collapsedAgain).not.toContain("line-11");
	});
});
