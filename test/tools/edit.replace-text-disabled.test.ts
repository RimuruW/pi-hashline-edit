import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import register from "../../index";
import { hashlineEditToolSchema } from "../../src/edit";
import {
	__resetConfigForTests,
	__setReplaceTextEnabledForTests,
} from "../../src/config";
import { loadPrompt, stripReplaceTextFromPrompt } from "../../src/prompt-loader";
import { makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

afterEach(() => {
	__resetConfigForTests();
});

describe("replaceText=false: structured replace_text edit is rejected", () => {
	it("rejects op:replace_text with E_REPLACE_TEXT_DISABLED error", async () => {
		__setReplaceTextEnabledForTests(false);
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						edits: [{ op: "replace_text", oldText: "bbb", newText: "BBB" }],
					},
					undefined,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(/^\[E_REPLACE_TEXT_DISABLED\]/);
		});
	});

	it("error message instructs re-read and use of anchor edits", async () => {
		__setReplaceTextEnabledForTests(false);
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						edits: [{ op: "replace_text", oldText: "bbb", newText: "BBB" }],
					},
					undefined,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(/re-read.*anchor|anchor.*re-read/i);
		});
	});
});

describe("replaceText=false: legacy top-level oldText/newText is also rejected", () => {
	it("rejects top-level camelCase oldText/newText with E_REPLACE_TEXT_DISABLED (not a schema error)", async () => {
		__setReplaceTextEnabledForTests(false);
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{ path: "sample.txt", oldText: "bbb", newText: "BBB" },
					undefined,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(/^\[E_REPLACE_TEXT_DISABLED\]/);
		});
	});

	it("rejects top-level snake_case old_text/new_text with E_REPLACE_TEXT_DISABLED", async () => {
		__setReplaceTextEnabledForTests(false);
		await withTempFile("sample.txt", "hello world", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{ path: "sample.txt", old_text: "hello", new_text: "bye" },
					undefined,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(/^\[E_REPLACE_TEXT_DISABLED\]/);
		});
	});
});

describe("replaceText=false: loaded edit prompt strips replace_text mentions", () => {
	it("edit.md loaded prompt contains no replace_text or oldText/newText when disabled", () => {
		__setReplaceTextEnabledForTests(false);
		const editMdUrl = new URL("../../prompts/edit.md", import.meta.url);
		const content = loadPrompt(editMdUrl);
		expect(content).not.toContain("replace_text");
		expect(content).not.toContain("oldText");
		expect(content).not.toContain("newText");
	});

	it("edit.md loaded prompt is byte-identical to raw file when replaceText=true (default)", () => {
		// replaceText defaults to true after reset — loadPrompt must return raw bytes.
		const editMdUrl = new URL("../../prompts/edit.md", import.meta.url);
		const raw = readFileSync(editMdUrl, "utf8");
		expect(loadPrompt(editMdUrl)).toBe(raw);
	});
});

describe("replaceText=false: tool parameters schema omits replace_text", () => {
	it("registered schema at replaceText=false has 3 edit variants (no replace_text)", () => {
		__setReplaceTextEnabledForTests(false);
		const { pi, getTool } = makeFakePiRegistry();
		register(pi);
		const editTool = getTool("edit");
		const params = editTool.parameters as unknown as {
			properties: { edits: { items: { anyOf?: unknown[] } } };
		};
		expect(params.properties.edits.items.anyOf).toHaveLength(3);
	});

	it("registered schema at replaceText=false rejects op:replace_text via AJV", () => {
		__setReplaceTextEnabledForTests(false);
		const { pi, getTool } = makeFakePiRegistry();
		register(pi);
		const editTool = getTool("edit");
		const ajv = new Ajv({ allErrors: true });
		const validate = ajv.compile<unknown>(editTool.parameters);

		expect(
			validate({
				path: "a.ts",
				edits: [{ op: "replace_text", oldText: "before", newText: "after" }],
			}),
		).toBe(false);
	});

	it("static hashlineEditToolSchema (default/replaceText=true) still has 4 variants", () => {
		// The exported constant always includes replace_text regardless of config.
		const props = hashlineEditToolSchema.properties as {
			edits: { items: { anyOf?: unknown[] } };
		};
		expect(props.edits.items.anyOf).toHaveLength(4);
	});
});

describe("stripReplaceTextFromPrompt", () => {
	it("removes the replace_text bullet line from edit.md content", () => {
		const raw = readFileSync(new URL("../../prompts/edit.md", import.meta.url), "utf8");
		const stripped = stripReplaceTextFromPrompt(raw);
		expect(stripped).not.toContain("replace_text");
		expect(stripped).not.toContain("oldText");
		expect(stripped).not.toContain("newText");
	});

	it("does not alter text that has no replace_text bullet", () => {
		const text = "Some prompt with no replace_text bullet\n";
		expect(stripReplaceTextFromPrompt(text)).toBe(text);
	});
});
