import { describe, expect, it, vi } from "vitest";
import {
	buildAppliedChangedResultText,
	colorDiffLines,
	formatDiff,
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

		const collapsedPreview = formatDiff(diff, false, theme);
		expect(collapsedPreview).toContain("line-10");
		expect(collapsedPreview).not.toContain("line-11");
		expect(collapsedPreview).toContain("ctrl+o to expand");

		const expandedPreview = formatDiff(diff, true, theme);
		expect(expandedPreview).toContain("line-12");
		expect(expandedPreview).not.toContain("to expand");

		const details = {
			classification: "applied",
			diff,
			warnings: [],
		} as NonNullable<Parameters<typeof buildAppliedChangedResultText>[1]>;
		expect(buildAppliedChangedResultText(undefined, details, undefined, false, theme)).toBe(collapsedPreview);
		expect(buildAppliedChangedResultText(undefined, details, undefined, true, theme)).toBe(expandedPreview);

		const collapsedAgain = formatDiff(diff, false, theme);
		expect(collapsedAgain).not.toContain("line-11");
	});

	it("ignores the trailing newline sentinel when counting hidden diff lines", () => {
		const theme = makeTokenTheme();
		const makeLines = (count: number) =>
			Array.from({ length: count }, (_, index) => ` line-${String(index + 1).padStart(2, "0")}`).join("\n");

		const collapsedEleven = formatDiff(`${makeLines(11)}\n`, false, theme);
		expect(collapsedEleven).toContain("(1 more diff lines,");

		const collapsedTen = formatDiff(`${makeLines(10)}\n`, false, theme);
		expect(collapsedTen).toContain("line-10");
		expect(collapsedTen).not.toContain("to expand");

		const expandedEleven = formatDiff(`${makeLines(11)}\n`, true, theme);
		expect(expandedEleven.endsWith("<dim></dim>")).toBe(false);
	});
});
