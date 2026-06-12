import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import register from "../../index";
import { normalizeEditRequest } from "../../src/edit-normalize";
import { computeLineHash } from "../../src/hashline";
import { getText, makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

describe("normalizeEditRequest", () => {
	it("folds top-level camelCase oldText/newText into a replace_text edit", () => {
		expect(
			normalizeEditRequest({
				path: "a.ts",
				oldText: "before",
				newText: "after",
			}),
		).toEqual({
			path: "a.ts",
			edits: [{ op: "replace_text", oldText: "before", newText: "after" }],
		});
	});

	it("folds top-level snake_case old_text/new_text into a replace_text edit", () => {
		expect(
			normalizeEditRequest({
				path: "a.ts",
				old_text: "before",
				new_text: "after",
			}),
		).toEqual({
			path: "a.ts",
			edits: [{ op: "replace_text", oldText: "before", newText: "after" }],
		});
	});

	it("folds top-level fields when edits is present but empty", () => {
		expect(
			normalizeEditRequest({
				path: "a.ts",
				edits: [],
				oldText: "before",
				newText: "after",
			}),
		).toEqual({
			path: "a.ts",
			edits: [{ op: "replace_text", oldText: "before", newText: "after" }],
		});
	});

	it("backfills op replace_text on bare oldText/newText edit items", () => {
		expect(
			normalizeEditRequest({
				path: "a.ts",
				edits: [{ oldText: "before", newText: "after" }],
			}),
		).toEqual({
			path: "a.ts",
			edits: [{ op: "replace_text", oldText: "before", newText: "after" }],
		});
	});

	it("leaves edit items that already declare an op untouched", () => {
		const input = {
			path: "a.ts",
			edits: [{ op: "replace", pos: "1#AB", lines: ["after"] }],
		};
		expect(normalizeEditRequest(input)).toEqual(input);
	});

	it("does not fold top-level fields when structured edits already exist", () => {
		// Mixing structured edits with top-level native fields is ambiguous; the
		// top-level keys are left in place for validation to reject.
		const result = normalizeEditRequest({
			path: "a.ts",
			edits: [{ op: "replace", pos: "1#AB", lines: ["after"] }],
			oldText: "before",
			newText: "after",
		}) as Record<string, unknown>;
		expect(result.oldText).toBe("before");
		expect(result.edits).toEqual([
			{ op: "replace", pos: "1#AB", lines: ["after"] },
		]);
	});

	it("parses edits supplied as a JSON string", () => {
		expect(
			normalizeEditRequest({
				path: "a.ts",
				edits: JSON.stringify([{ op: "replace", pos: "1#AB", lines: ["x"] }]),
			}),
		).toEqual({
			path: "a.ts",
			edits: [{ op: "replace", pos: "1#AB", lines: ["x"] }],
		});
	});

	it("maps file_path alias to path", () => {
		const result = normalizeEditRequest({
			file_path: "a.ts",
			edits: [{ op: "replace", pos: "1#AB", lines: ["x"] }],
		}) as Record<string, unknown>;
		expect(result.path).toBe("a.ts");
		expect("file_path" in result).toBe(false);
	});

	it("rejects mixed top-level camelCase and snake_case replace aliases", () => {
		expect(() =>
			normalizeEditRequest({
				path: "a.ts",
				oldText: "before",
				newText: "after",
				old_text: "other before",
				new_text: "other after",
			}),
		).toThrow(/cannot mix legacy camelCase and snake_case/i);
	});

	it("rejects malformed top-level native replace aliases", () => {
		expect(() =>
			normalizeEditRequest({ path: "a.ts", oldText: "before", newText: 42 }),
		).toThrow(/field "newText" must be a string/i);
	});

	it("rejects incomplete top-level native replace aliases", () => {
		expect(() =>
			normalizeEditRequest({ path: "a.ts", oldText: "before" }),
		).toThrow(/requires both oldText and newText/i);
	});

	it("does not hide malformed edits when top-level aliases are also present", () => {
		expect(
			normalizeEditRequest({
				path: "a.ts",
				edits: "not json",
				oldText: "before",
				newText: "after",
			}),
		).toEqual({
			path: "a.ts",
			edits: "not json",
			oldText: "before",
			newText: "after",
		});
	});

	it("returns non-object input unchanged for validation to reject", () => {
		expect(normalizeEditRequest("not an object")).toBe("not an object");
	});
});

describe("edit tool: native top-level oldText/newText", () => {
	it("normalizes camelCase top-level replace into a strict replace_text edit", async () => {
		await withTempFile(
			"sample.txt",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const editTool = getTool("edit");

				const result = await editTool.execute(
					"e1",
					{ path: "sample.txt", oldText: "bbb", newText: "BBB" },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				expect(getText(result)).toContain("--- Anchors");
				expect(getText(result)).not.toMatch(/compatibility|fallback|legacy/i);
				expect(result.details?.diff).toContain(":BBB");
				expect(result.details?.compatibility).toBeUndefined();
				expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
			},
		);
	});

	it("normalizes snake_case top-level replace", async () => {
		await withTempFile("sample.txt", "hello world", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{ path: "sample.txt", old_text: "world", new_text: "universe" },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).toContain("--- Anchors");
			expect(await readFile(path, "utf-8")).toBe("hello universe");
		});
	});

	it("folds top-level fields when edits is an empty array", async () => {
		await withTempFile(
			"sample.txt",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const editTool = getTool("edit");

				const result = await editTool.execute(
					"e1",
					{ path: "sample.txt", edits: [], oldText: "bbb", newText: "BBB" },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				expect(getText(result)).toContain("--- Anchors");
				expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
			},
		);
	});

	it("matches a multiline top-level replace after CRLF normalization and preserves CRLF", async () => {
		await withTempFile(
			"sample.txt",
			"alpha\r\nbeta\r\ngamma\r\n",
			async ({ cwd, path }) => {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const editTool = getTool("edit");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.txt",
						oldText: "alpha\r\nbeta",
						newText: "ALPHA\r\nBETA",
					},
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				expect(getText(result)).toContain("--- Anchors");
				expect(await readFile(path, "utf-8")).toBe(
					"ALPHA\r\nBETA\r\ngamma\r\n",
				);
			},
		);
	});

	it("rejects a top-level replace that matches multiple times (strict replace_text)", async () => {
		await withTempFile("sample.txt", "dup\nmid\ndup\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{ path: "sample.txt", oldText: "dup", newText: "X" },
					undefined,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(/multiple exact matches|re-read and use hashline/i);
		});
	});

	it("rejects a top-level replace with no exact match (no fuzzy fallback)", async () => {
		await withTempFile("sample.txt", "he said “hi”\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			// Differs only by Unicode punctuation. The retired legacy path used to
			// fuzzy-match this; the unified strict replace_text semantics reject it.
			await expect(
				editTool.execute(
					"e1",
					{ path: "sample.txt", oldText: 'he said "hi"', newText: "HELLO" },
					undefined,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(/no exact unique match|re-read and use hashline/i);
		});
	});

	it("prefers strict hashline edits and rejects mixing them with top-level fields", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");
			const betaRef = `2#${computeLineHash(2, "bbb")}`;

			// edits present → top-level fields are not folded; they surface as unknown
			// root keys and are rejected.
			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						edits: [{ op: "replace", pos: betaRef, lines: ["BBB"] }],
						oldText: "bbb",
						newText: "SHOULD-NOT-APPLY",
					},
					undefined,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(/unknown or unsupported fields/i);
		});
	});

	it("warns when editing a file that was decoded with replacement characters", async () => {
		await withTempFile("legacy.txt", "placeholder\n", async ({ cwd, path }) => {
			await writeFile(path, Buffer.from([0x61, 0xe9, 0x62, 0x0a]));
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{ path: "legacy.txt", oldText: "a", newText: "A" },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).toContain("rewrote the file as UTF-8");
			expect(await readFile(path, "utf-8")).toBe("A�b\n");
		});
	});

	it("does not warn for a valid utf-8 replacement character", async () => {
		await withTempFile("valid.txt", "a�b\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{ path: "valid.txt", oldText: "a", newText: "A" },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).not.toContain("Non-UTF-8");
			expect(await readFile(path, "utf-8")).toBe("A�b\n");
		});
	});

	it("does not warn or rewrite invalid utf-8 bytes for noop edits", async () => {
		await withTempFile("legacy.txt", "placeholder\n", async ({ cwd, path }) => {
			const originalBytes = Buffer.from([0x61, 0xe9, 0x62, 0x0a]);
			await writeFile(path, originalBytes);
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{ path: "legacy.txt", oldText: "a", newText: "a" },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).not.toContain("rewrote the file as UTF-8");
			expect(result.details?.metrics?.warnings).toBe(0);
			expect(await readFile(path)).toEqual(originalBytes);
		});
	});
});

describe("edit tool: bare oldText/newText edit items", () => {
	it("backfills op replace_text so native-style edit items succeed", async () => {
		await withTempFile(
			"sample.txt",
			"aaa\nbbb\nccc\n",
			async ({ cwd, path }) => {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const editTool = getTool("edit");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.txt",
						edits: [{ oldText: "bbb", newText: "BBB" }],
					},
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				expect(getText(result)).toContain("--- Anchors");
				expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
			},
		);
	});
});
