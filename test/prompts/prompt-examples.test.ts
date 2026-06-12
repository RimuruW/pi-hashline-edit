import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { assertEditRequest } from "../../src/edit";
import { normalizeEditRequest } from "../../src/edit-normalize";
import { resolveEditAnchors } from "../../src/hashline";

// Prompt text is protocol-teaching material: every example a model might
// imitate must be accepted by the real validators. This guards against
// prompt/implementation drift (e.g. an example anchor using characters
// outside the hash alphabet).

const HASH_ALPHABET = "ZPMQVRWSNKTXJBYH";
const promptsDir = new URL("../../prompts/", import.meta.url);

function readPrompt(name: string): string {
	return readFileSync(new URL(name, promptsDir), "utf-8");
}

function extractJsonBlocks(markdown: string): string[] {
	return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map(
		(match) => match[1]!,
	);
}

const promptFiles = readdirSync(promptsDir).filter((name) =>
	name.endsWith(".md"),
);

describe("prompt examples", () => {
	it("covers the expected prompt files", () => {
		expect(promptFiles.sort()).toEqual([
			"edit-guidelines.md",
			"edit-snippet.md",
			"edit.md",
			"read-guidelines.md",
			"read-snippet.md",
			"read.md",
		]);
	});

	it("edit.md JSON examples pass normalization, validation, and anchor resolution", () => {
		const blocks = extractJsonBlocks(readPrompt("edit.md"));
		expect(blocks.length).toBeGreaterThan(0);

		for (const block of blocks) {
			const request: unknown = JSON.parse(block);
			const normalized = normalizeEditRequest(request);
			assertEditRequest(normalized);
			expect(() => resolveEditAnchors(normalized.edits)).not.toThrow();
		}
	});

	it("every concrete anchor literal uses the hash alphabet", () => {
		for (const name of promptFiles) {
			const text = readPrompt(name);
			for (const match of text.matchAll(/\b\d+#([A-Z]+)/g)) {
				const hash = match[1]!;
				expect(hash, `${name}: anchor "${match[0]}"`).toHaveLength(2);
				for (const ch of hash) {
					expect(
						HASH_ALPHABET.includes(ch),
						`${name}: anchor "${match[0]}" uses "${ch}" outside ${HASH_ALPHABET}`,
					).toBe(true);
				}
			}
		}
	});

	it("snippets are non-empty single lines", () => {
		for (const name of ["read-snippet.md", "edit-snippet.md"]) {
			const snippet = readPrompt(name).trim();
			expect(snippet.length, name).toBeGreaterThan(0);
			expect(snippet, name).not.toContain("\n");
		}
	});

	it("guidelines files contain only dash bullets", () => {
		for (const name of ["read-guidelines.md", "edit-guidelines.md"]) {
			const lines = readPrompt(name)
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			expect(lines.length, name).toBeGreaterThan(0);
			for (const line of lines) {
				expect(line.startsWith("- "), `${name}: "${line}"`).toBe(true);
			}
		}
	});
});
