import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import Ajv from "ajv";
import {
	assertEditRequest,
	hashlineEditToolSchema,
	registerEditTool,
} from "../../src/edit";
import { computeLineHash } from "../../src/hashline";
import {
	makeFakePiRegistry,
	makeTestTheme,
	makeToolContext,
	withTempFile,
	type ToolRenderContext,
} from "../support/fixtures";

describe("assertEditRequest", () => {
	it("rejects unknown or unsupported root fields", () => {
		expect(() =>
			assertEditRequest({ path: "a.ts", legacy_field: [] }),
		).toThrow(/unknown or unsupported fields/i);
	});

	it("rejects top-level oldText/newText (folded by normalize, not accepted raw)", () => {
		// After normalization these become edits[]; reaching assertEditRequest with
		// them still present means they were not folded, so they are unknown fields.
		expect(() =>
			assertEditRequest({
				path: "a.ts",
				oldText: "before",
				newText: "after",
			}),
		).toThrow(/unknown or unsupported fields/i);
	});

	// Per-edit structural validation now lives in resolveEditAnchors
	// (hashline.ts). assertEditRequest validates only the request envelope.

	it("rejects returnMode and returnRanges after return payload modes were deleted", () => {
		expect(() =>
			assertEditRequest({
				path: "a.ts",
				returnMode: "full",
				edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
			}),
		).toThrow(/unknown or unsupported fields/i);

		expect(() =>
			assertEditRequest({
				path: "a.ts",
				returnRanges: [{ start: 1, end: 2 }],
				edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
			}),
		).toThrow(/unknown or unsupported fields/i);
	});

});

describe("registerEditTool", () => {
	it("publishes a schema that validates strict hashline payloads", () => {
		const ajv = new Ajv({ allErrors: true });
		const validate = ajv.compile<unknown>(hashlineEditToolSchema);

		expect(
			validate({
				path: "a.ts",
				edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
			}),
		).toBe(true);
	});

	it("publishes a schema with no top-level native text-replace fields", () => {
		const ajv = new Ajv({ allErrors: true });
		const validate = ajv.compile<unknown>(hashlineEditToolSchema);

		// Native top-level fields are normalized away before validation; the
		// published schema does not declare them, so AJV rejects them as additional
		// properties.
		expect(
			validate({ path: "a.ts", oldText: "before", newText: "after" }),
		).toBe(false);

		// Widened on purpose: these keys are absent from the schema type, so the
		// direct property reads below would not compile; the runtime assertions
		// stay as regression guards against the fields being re-added.
		const props: Record<string, unknown> = hashlineEditToolSchema.properties;
		expect(props.oldText).toBeUndefined();
		expect(props.newText).toBeUndefined();
		expect(props.old_text).toBeUndefined();
		expect(props.new_text).toBeUndefined();
		expect(props.returnMode).toBeUndefined();
		expect(props.returnRanges).toBeUndefined();
	});

	it("publishes a top-level object schema for pi tool registration", () => {
		expect(hashlineEditToolSchema.type).toBe("object");
		expect("anyOf" in hashlineEditToolSchema).toBe(false);
	});

	it("registers the edit tool with a normalization prepareArguments hook", () => {
		const { pi, getTool } = makeFakePiRegistry();

		registerEditTool(pi);
		const registered = getTool("edit");

		expect(registered.parameters).toEqual(hashlineEditToolSchema);
		expect(typeof registered.prepareArguments).toBe("function");
		// The hook folds top-level native fields into edits[].
		expect(
			registered.prepareArguments?.({
				path: "a.ts",
				oldText: "x",
				newText: "y",
			}),
		).toEqual({
			path: "a.ts",
			edits: [{ op: "replace_text", oldText: "x", newText: "y" }],
		});
	});

	it("rejects an empty edits array without touching the file", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{ path: "sample.txt", edits: [] },
					undefined,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(/No edits provided/);

			expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
		});
	});

	it("aborts before mutating the file when the signal is already aborted", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");
			const controller = new AbortController();
			controller.abort();

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						edits: [
							{
								op: "replace",
								pos: `1#${computeLineHash(1, "aaa")}`,
								lines: ["AAA"],
							},
						],
					},
					controller.signal,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(/aborted/i);

			expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
		});
	});

	it("rejects malformed null lines during direct execute without modifying the file", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						edits: [
							{
								op: "replace",
								pos: `1#${computeLineHash(1, "aaa")}:aaa`,
								lines: null,
							},
						],
					},
					undefined,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(/lines" must be a string array/i);

			expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
		});
	});

	it("validates direct execute path before resolving mutation target", async () => {
		const { pi, getTool } = makeFakePiRegistry();
		registerEditTool(pi);
		const editTool = getTool("edit");

		await expect(
			editTool.execute(
				"e1",
				{ edits: [{ op: "append", lines: ["x"] }] },
				undefined,
				undefined,
				makeToolContext(process.cwd()),
			),
		).rejects.toThrow(/requires a non-empty "path" string/i);
	});

	it("renders details diff while keeping diff out of LLM-visible text", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");
			const editArgs = {
				path: "sample.txt",
				edits: [
					{
						op: "replace",
						pos: `2#${computeLineHash(2, "bbb")}:bbb`,
						lines: ["BBB"],
					},
				],
			};

			const result = await editTool.execute(
				"e1",
				editArgs,
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(typeof editTool.renderResult).toBe("function");

			const component = editTool.renderResult!(
				result,
				{ expanded: false, isPartial: false },
				makeTestTheme({
					fg: (token: string, text: string) => `[${token}]${text}[/${token}]`,
				}),
				// Partial render context: the result renderer reads only these fields.
				{
					args: editArgs,
					isError: false,
					lastComponent: undefined,
				} as unknown as ToolRenderContext,
			) as { render: (width: number) => string[] };

			const rendered = component.render(200).join("\n");

			expect(rendered).not.toContain("Changes: +1 -1");
			expect(rendered).not.toContain("Diff preview:");
			expect(rendered).not.toContain("```diff");
			expect(rendered).toContain(`+2#${computeLineHash(2, "BBB")}:BBB`);
			expect(rendered).not.toContain("Updated sample.txt");
			expect(rendered).not.toContain("```text");
			expect(result.details?.diff).toContain("+2");
		});
	});
});
