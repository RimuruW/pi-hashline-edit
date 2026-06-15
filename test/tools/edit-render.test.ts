import { describe, expect, it } from "vitest";
import { colorDiffLines, type FgTheme } from "../../src/edit-render";

function makeTokenTheme(): FgTheme {
	return {
		fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
	} as FgTheme;
}

describe("colorDiffLines", () => {
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
});
