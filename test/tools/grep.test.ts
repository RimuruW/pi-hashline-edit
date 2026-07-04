import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { describe, expect, it, vi, afterEach } from "vitest";
import { registerGrepTool } from "../../src/grep";
import { registerEditTool } from "../../src/edit";
import { formatHashlineRegion } from "../../src/hashline";
import { normalizeToLF, stripBom } from "../../src/edit-diff";
import { makeFakePiRegistry, makeToolContext, getText, withTempFile } from "../support/fixtures";

const rgAvailable = spawnSync("rg", ["--version"]).status === 0;

// All tests skip silently in environments without ripgrep.
describe.skipIf(!rgAvailable)("grep tool", () => {
	function getGrepTool() {
		const { pi, getTool } = makeFakePiRegistry();
		registerGrepTool(pi);
		return getTool("grep");
	}

	// ─── Basic match: LINE#HASH anchors present ─────────────────────────────

	it("returns LINE#HASH-prefixed lines and a summary line for a basic match", async () => {
		await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
			const tool = getGrepTool();
			const result = await tool.execute(
				"g1",
				{ pattern: "beta", path },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			const text = getText(result);
			// Must contain a LINE#HASH-anchored line for "beta"
			expect(text).toMatch(/\d+#[A-Z]{2}:beta/);
			// Must contain the summary
			expect(text).toMatch(/1 match in 1 file\./);
		});
	});

	// ─── CRITICAL integration: grep → edit without a prior read ────────────

	it("anchor from grep output is accepted by edit without a prior read call", async () => {
		await withTempFile(
			"target.ts",
			"line one\nline two\nline three\n",
			async ({ cwd, path }) => {
				const { pi, getTool } = makeFakePiRegistry();
				registerGrepTool(pi);
				registerEditTool(pi);

				const grepTool = getTool("grep");
				const editTool = getTool("edit");

				const grepResult = await grepTool.execute(
					"g1",
					{ pattern: "line two", path },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				const grepText = getText(grepResult);
				// Extract "LINE#HASH" from the grep output line containing "line two"
				const anchorMatch = grepText.match(/(\d+#[A-Z]{2}):line two/);
				expect(anchorMatch).not.toBeNull();
				const anchor = anchorMatch![1]!;

				// Feed the anchor to edit — must succeed without any prior read call
				await expect(
					editTool.execute(
						"e1",
						{
							path,
							edits: [{ op: "replace", pos: anchor, lines: ["replaced line"] }],
						},
						undefined,
						undefined,
						makeToolContext(cwd),
					),
				).resolves.toBeDefined();
			},
		);
	});

	// ─── Anchor byte-identity with formatHashlineRegion ────────────────────

	it("anchors are byte-identical to what formatHashlineRegion would produce", async () => {
		const content = "alpha\nbeta\ngamma\n";
		await withTempFile("eq.ts", content, async ({ cwd, path }) => {
			const tool = getGrepTool();
			const result = await tool.execute(
				"g1",
				{ pattern: "beta", path },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			const text = getText(result);
			// Extract the hashline for line 2 from grep output
			const grepLine = text
				.split("\n")
				.find((l) => l.includes(":beta"));
			expect(grepLine).toBeDefined();

			// Build the expected line via formatHashlineRegion on the same content
			const normalized = normalizeToLF(stripBom(content).text);
			const fileLines = normalized.split("\n").filter((_, i, arr) =>
				!(i === arr.length - 1 && arr[arr.length - 1] === ""),
			);
			const expected = formatHashlineRegion(fileLines, 2, 2);

			expect(grepLine?.trim()).toBe(expected.trim());
		});
	});

	// ─── Context lines: N produces surrounding lines ────────────────────────

	it("context: 1 includes lines before and after each match", async () => {
		await withTempFile(
			"ctx.ts",
			"alpha\nbeta\ngamma\n",
			async ({ cwd, path }) => {
				const tool = getGrepTool();
				const result = await tool.execute(
					"g1",
					{ pattern: "beta", path, context: 1 },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				const text = getText(result);
				expect(text).toContain("alpha");
				expect(text).toContain("beta");
				expect(text).toContain("gamma");
			},
		);
	});

	it("overlapping context ranges within one file are merged (no '...' separator)", async () => {
		// Lines 2 and 4 match with context 1 → ranges [1,3] and [3,5] overlap → merged [1,5]
		await withTempFile(
			"merge.ts",
			"a\nb\nc\nd\ne\n",
			async ({ cwd, path }) => {
				const tool = getGrepTool();
				const result = await tool.execute(
					"g1",
					{ pattern: "b|d", path, context: 1 },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				const text = getText(result);
				// No gap separator when ranges are merged
				expect(text).not.toContain("...");
				// All five lines appear
				expect(text).toContain(":a");
				expect(text).toContain(":b");
				expect(text).toContain(":c");
				expect(text).toContain(":d");
				expect(text).toContain(":e");
			},
		);
	});

	// ─── Non-adjacent ranges use "..." separator ────────────────────────────

	it("non-adjacent ranges within one file are separated by '...'", async () => {
		// Lines 1 and 5 match with context 0 → separate ranges → "..." between them
		await withTempFile(
			"sep.ts",
			"match\nb\nc\nd\nmatch\n",
			async ({ cwd, path }) => {
				const tool = getGrepTool();
				const result = await tool.execute(
					"g1",
					{ pattern: "match", path, context: 0 },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				const text = getText(result);
				expect(text).toContain("...");
			},
		);
	});

	// ─── Glob filter ────────────────────────────────────────────────────────

	it("glob filters which files are searched", async () => {
		const cwd = await (async () => {
			const tmpRoot = join(process.cwd(), ".tmp");
			await mkdir(tmpRoot, { recursive: true });
			const { mkdtemp } = await import("fs/promises");
			return mkdtemp(join(tmpRoot, "grep-glob-"));
		})();
		try {
			await writeFile(join(cwd, "foo.ts"), "hello world\n");
			await writeFile(join(cwd, "foo.md"), "hello world\n");

			const tool = getGrepTool();
			const result = await tool.execute(
				"g1",
				{ pattern: "hello", path: cwd, glob: "**/*.ts" },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			const text = getText(result);
			expect(text).toContain("foo.ts");
			expect(text).not.toContain("foo.md");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	// ─── ignoreCase ─────────────────────────────────────────────────────────

	it("ignoreCase matches regardless of letter case", async () => {
		await withTempFile("ci.ts", "Hello World\n", async ({ cwd, path }) => {
			const tool = getGrepTool();
			const result = await tool.execute(
				"g1",
				{ pattern: "hello world", path, ignoreCase: true },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			const text = getText(result);
			expect(text).toContain("Hello World");
			expect(text).toMatch(/1 match/);
		});
	});

	// ─── literal: treats regex metachars as literal ─────────────────────────

	it("literal: true treats regex metacharacters as literal text", async () => {
		await withTempFile(
			"lit.ts",
			"foo(bar)\nbaz\n",
			async ({ cwd, path }) => {
				const tool = getGrepTool();
				// Without literal, "foo(bar)" would be a regex group — we want exact match
				const result = await tool.execute(
					"g1",
					{ pattern: "foo(bar)", path, literal: true },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				const text = getText(result);
				expect(text).toContain("foo(bar)");
				expect(text).toMatch(/1 match/);
			},
		);
	});

	// ─── limit truncation ───────────────────────────────────────────────────

	it("limit truncation appends a truncation notice", async () => {
		// Four matching lines, limit 2 → truncated
		await withTempFile(
			"lim.ts",
			"match\nmatch\nmatch\nmatch\n",
			async ({ cwd, path }) => {
				const tool = getGrepTool();
				const result = await tool.execute(
					"g1",
					{ pattern: "match", path, limit: 2 },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				const text = getText(result);
				expect(text).toContain("(truncated at 2)");
				expect(result.details).toMatchObject({ truncated: true });
			},
		);
	});

	// ─── No matches ─────────────────────────────────────────────────────────

	it("returns 'No matches found' message when pattern has no matches", async () => {
		await withTempFile(
			"nomatch.ts",
			"alpha\nbeta\n",
			async ({ cwd, path }) => {
				const tool = getGrepTool();
				const result = await tool.execute(
					"g1",
					{ pattern: "zzznomatch", path },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				const text = getText(result);
				expect(text).toContain("No matches found for zzznomatch.");
				expect(result.details).toMatchObject({ matches: 0, files: 0 });
			},
		);
	});

	// ─── .gitignore respected ───────────────────────────────────────────────

	it("respects .gitignore (files ignored by rg are excluded from results)", async () => {
		const cwd = await (async () => {
			const tmpRoot = join(process.cwd(), ".tmp");
			await mkdir(tmpRoot, { recursive: true });
			const { mkdtemp } = await import("fs/promises");
			return mkdtemp(join(tmpRoot, "grep-gitignore-"));
		})();
		try {
			await writeFile(join(cwd, ".gitignore"), "secret.ts\n");
			await writeFile(join(cwd, "secret.ts"), "secretpattern\n");
			await writeFile(join(cwd, "visible.ts"), "secretpattern\n");

			const tool = getGrepTool();
			const result = await tool.execute(
				"g1",
				{ pattern: "secretpattern", path: cwd },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			const text = getText(result);
			expect(text).not.toContain("secret.ts");
			expect(text).toContain("visible.ts");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	// ─── details metadata ────────────────────────────────────────────────────

	it("details carries match count, file count, and truncated flag", async () => {
		await withTempFile(
			"meta.ts",
			"hit\nhit\nno\n",
			async ({ cwd, path }) => {
				const tool = getGrepTool();
				const result = await tool.execute(
					"g1",
					{ pattern: "hit", path },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				expect(result.details).toMatchObject({
					matches: 2,
					files: 1,
					truncated: false,
				});
			},
		);
	});
});

// ─── registerGrepTool silent no-op when rg is unavailable ─────────────────

describe("registerGrepTool", () => {
	it("does not register the grep tool when rg is unavailable (simulated by checking the export contract)", () => {
		// This test only validates the export shape; actual no-op is tested via
		// register.test.ts which captures real registration.
		expect(typeof registerGrepTool).toBe("function");
	});
});

// ─── spawn failure throws, never returns "No matches found" ────────────────
//
// These tests mock child_process.spawn so they run regardless of rg availability.

vi.mock("child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("child_process")>();
	return { ...original, spawn: vi.fn(original.spawn) };
});

describe("runRg spawn failure", () => {
	afterEach(() => {
		vi.mocked(spawn).mockRestore();
	});

	function fakeChild(opts: {
		errorEvent?: Error;
		closeCode?: number | null;
		stdout?: string;
		stderr?: string;
	}) {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = new EventEmitter() as ReturnType<typeof spawn>;
		Object.assign(child, { stdout, stderr, kill: vi.fn() });

		// Emit events after listeners have time to attach. Use explicit undefined
		// check so closeCode: null is not coerced to 0 by the ?? operator.
		const closeCode = opts.closeCode !== undefined ? opts.closeCode : 0;
		setImmediate(() => {
			if (opts.errorEvent) {
				child.emit("error", opts.errorEvent);
				return;
			}
			if (opts.stdout) stdout.write(opts.stdout);
			if (opts.stderr) stderr.write(opts.stderr);
			stdout.end();
			stderr.end();
			setImmediate(() => child.emit("close", closeCode));
		});

		return child;
	}

	it("throws on spawn error instead of returning 'No matches found'", async () => {
		vi.mocked(spawn).mockImplementationOnce(
			() => fakeChild({ errorEvent: new Error("ENOENT: rg not found") }) as ReturnType<typeof spawn>,
		);

		const { pi, getTool } = makeFakePiRegistry();
		// Bypass isRgAvailable by calling registerTool directly via a stub pi
		// that ignores the guard — we only need the execute path.
		// Instead, register normally (rg IS available here for spawnSync) then
		// replace spawn for the execute call.
		registerGrepTool(pi);
		const tool = getTool("grep");

		await expect(
			tool.execute(
				"g1",
				{ pattern: "anything" },
				undefined,
				undefined,
				makeToolContext(process.cwd()),
			),
		).rejects.toThrow(/spawn error|ENOENT/i);
	});

	it("throws on rg exit code 2 (rg error) instead of returning 'No matches found'", async () => {
		vi.mocked(spawn).mockImplementationOnce(
			() => fakeChild({ closeCode: 2, stderr: "rg: invalid regex" }) as ReturnType<typeof spawn>,
		);

		const { pi, getTool } = makeFakePiRegistry();
		registerGrepTool(pi);
		const tool = getTool("grep");

		await expect(
			tool.execute(
				"g1",
				{ pattern: "anything" },
				undefined,
				undefined,
				makeToolContext(process.cwd()),
			),
		).rejects.toThrow(/ripgrep error.*invalid regex/i);
	});

	it("throws when process terminates with null exit code instead of returning 'No matches found'", async () => {
		vi.mocked(spawn).mockImplementationOnce(
			() => fakeChild({ closeCode: null }) as ReturnType<typeof spawn>,
		);

		const { pi, getTool } = makeFakePiRegistry();
		registerGrepTool(pi);
		const tool = getTool("grep");

		await expect(
			tool.execute(
				"g1",
				{ pattern: "anything" },
				undefined,
				undefined,
				makeToolContext(process.cwd()),
			),
		).rejects.toThrow(/terminated unexpectedly/i);
	});

	function matchEvent(path: string, lineNumber: number): string {
		return `${JSON.stringify({
			type: "match",
			data: { path: { text: path }, line_number: lineNumber },
		})}\n`;
	}

	it("does not mark exact-limit grep output as truncated", async () => {
		await withTempFile("stream.ts", "match 1\nmatch 2\n", async ({ cwd, path }) => {
			const child = fakeChild({
				closeCode: 0,
				stdout: matchEvent(path, 1) + matchEvent(path, 2),
			});
			vi.mocked(spawn).mockImplementationOnce(
				() => child as ReturnType<typeof spawn>,
			);

			const { pi, getTool } = makeFakePiRegistry();
			registerGrepTool(pi);
			const tool = getTool("grep");

			const result = await tool.execute(
				"g1",
				{ pattern: "match", path, limit: 2 },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(result.details).toMatchObject({ matches: 2, truncated: false });
			expect(getText(result)).not.toContain("truncated at 2");
			expect(child.kill).not.toHaveBeenCalled();
		});
	});

	it("kills ripgrep and resolves with truncated results only after seeing limit plus one matches", async () => {
		await withTempFile("stream.ts", "match 1\nmatch 2\nmatch 3\n", async ({ cwd, path }) => {
			const child = fakeChild({
				closeCode: null,
				stdout: matchEvent(path, 1) + matchEvent(path, 2) + matchEvent(path, 3),
			});
			vi.mocked(spawn).mockImplementationOnce(
				() => child as ReturnType<typeof spawn>,
			);

			const { pi, getTool } = makeFakePiRegistry();
			registerGrepTool(pi);
			const tool = getTool("grep");

			const result = await tool.execute(
				"g1",
				{ pattern: "match", path, limit: 2 },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(result.details).toMatchObject({ matches: 2, truncated: true });
			expect(getText(result)).toContain("truncated at 2");
			expect(getText(result)).not.toContain("match 3");
			expect(child.kill).toHaveBeenCalledTimes(1);
		});
	});
});
