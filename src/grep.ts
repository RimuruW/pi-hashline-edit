import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn, spawnSync } from "child_process";
import { normalizeToLF, stripBom } from "./edit-diff";
import { loadFileKindAndText } from "./file-kind";
import { formatHashlineRegion } from "./hashline";
import { resolveToCwd } from "./path-utils";
import { loadPrompt } from "./prompt-loader";
import { throwIfAborted } from "./runtime";

const GREP_DESC = loadPrompt(new URL("../prompts/grep.md", import.meta.url)).trim();

const GREP_PROMPT_SNIPPET = loadPrompt(
	new URL("../prompts/grep-snippet.md", import.meta.url),
).trim();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Exported so tests can inspect or stub the binary name without vi.mock("child_process").
export const RG_BIN = "rg";

/** Detect whether ripgrep is available on PATH. Only called at registration time. */
function isRgAvailable(): boolean {
	try {
		const result = spawnSync(RG_BIN, ["--version"], { encoding: "utf-8" });
		return result.error === undefined && result.status === 0;
	} catch {
		return false;
	}
}

/** rg --json match event. */
interface RgMatchEvent {
	type: "match";
	data: {
		path: { text: string };
		line_number: number;
	};
}

interface RgEvent {
	type: string;
	data: unknown;
}

/** Inclusive range [start, end] of 1-based line numbers. */
interface LineRange {
	start: number;
	end: number;
}

/** Merge a new range into an existing sorted, non-overlapping list. */
function mergeRange(ranges: LineRange[], range: LineRange): void {
	let merged = range;
	const remaining: LineRange[] = [];
	for (const r of ranges) {
		if (r.end < merged.start - 1 || r.start > merged.end + 1) {
			remaining.push(r);
		} else {
			merged = {
				start: Math.min(merged.start, r.start),
				end: Math.max(merged.end, r.end),
			};
		}
	}
	remaining.push(merged);
	remaining.sort((a, b) => a.start - b.start);
	ranges.splice(0, ranges.length, ...remaining);
}

/**
 * Run rg asynchronously, returning its stdout. Honors AbortSignal by killing
 * the child process. Throws on process-level failure (spawn error, ENOBUFS,
 * non-zero exit with status 2) so callers always see a real error instead of
 * a misleading "No matches found".
 *
 * rg exit codes: 0 = matches found, 1 = no matches, 2 = error.
 */
function runRg(args: string[], signal: AbortSignal | undefined): Promise<string> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		const child = spawn(RG_BIN, args);

		const stdoutChunks: string[] = [];
		let stderr = "";

		// setEncoding lets Node's stream decoder handle multi-byte UTF-8 sequences
		// that span chunk boundaries correctly — spawn's options.encoding is an exec
		// parameter and has no effect here, so we set encoding on the streams directly.
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");

		child.stdout.on("data", (chunk: string) => {
			stdoutChunks.push(chunk);
		});

		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		const onAbort = () => {
			child.kill();
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (err: Error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(new Error(`ripgrep spawn error: ${err.message}`));
		});

		child.on("close", (code: number | null) => {
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}
			// code === null means the process was killed (signal) or spawn failed
			if (code === null) {
				reject(new Error("ripgrep process terminated unexpectedly"));
				return;
			}
			// rg exits 2 for actual errors (invalid regex, unreadable path, etc.)
			if (code === 2) {
				reject(new Error(`ripgrep error: ${stderr.trim() || "unknown error"}`));
				return;
			}
			// code 0 (matches) and 1 (no matches) are both success from our perspective
			resolve(stdoutChunks.join(""));
		});
	});
}

export function registerGrepTool(pi: ExtensionAPI): void {
	if (!isRgAvailable()) {
		return;
	}

	pi.registerTool({
		name: "grep",
		label: "Grep",
		description: GREP_DESC,
		promptSnippet: GREP_PROMPT_SNIPPET,
		parameters: Type.Object({
			pattern: Type.String({
				description: "Search pattern (regex unless literal: true)",
			}),
			path: Type.Optional(
				Type.String({
					description: "File or directory to search (defaults to cwd)",
				}),
			),
			glob: Type.Optional(
				Type.String({
					description: 'Filename glob filter, e.g. "**/*.ts"',
				}),
			),
			ignoreCase: Type.Optional(
				Type.Boolean({
					description: "Case-insensitive matching",
				}),
			),
			literal: Type.Optional(
				Type.Boolean({
					description: "Treat pattern as a literal string, not a regex",
				}),
			),
			context: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: 5,
					description: "Number of context lines to show around each match (0–5, default 0)",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_LIMIT,
					description: `Maximum matched lines to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
				}),
			),
		}),

		renderCall(args) {
			const text = new Text("", 0, 0);
			const label = args.path
				? `grep ${args.pattern} ${args.path}`
				: `grep ${args.pattern}`;
			text.setText(label);
			return text;
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			throwIfAborted(signal);

			const searchPath = params.path
				? resolveToCwd(params.path, ctx.cwd)
				: ctx.cwd;

			const limit = params.limit ?? DEFAULT_LIMIT;
			const contextLines = params.context ?? 0;

			// Build rg args
			const rgArgs: string[] = ["--json"];
			if (params.ignoreCase) rgArgs.push("--ignore-case");
			if (params.literal) rgArgs.push("--fixed-strings");
			if (params.glob) rgArgs.push("--glob", params.glob);
			rgArgs.push("--", params.pattern, searchPath);

			// Async spawn: does not block the event loop; honors AbortSignal.
			// runRg throws on process-level failures — never silently returns empty.
			const stdout = await runRg(rgArgs, signal);

			throwIfAborted(signal);

			const matchesByFile = new Map<string, number[]>();
			let totalMatched = 0;
			let truncated = false;

			const lines = stdout.split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;
				let event: RgEvent;
				try {
					event = JSON.parse(line) as RgEvent;
				} catch {
					continue;
				}
				if (event.type !== "match") continue;

				const matchEvent = event as RgMatchEvent;
				const filePath = matchEvent.data.path.text;
				const lineNum = matchEvent.data.line_number;

				if (totalMatched >= limit) {
					truncated = true;
					break;
				}

				if (!matchesByFile.has(filePath)) {
					matchesByFile.set(filePath, []);
				}
				matchesByFile.get(filePath)!.push(lineNum);
				totalMatched++;
			}

			if (totalMatched === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No matches found for ${params.pattern}.`,
						},
					],
					details: {
						matches: 0,
						files: 0,
						truncated: false,
					},
				};
			}

			throwIfAborted(signal);

			const outputParts: string[] = [];
			let fileCount = 0;

			for (const [filePath, matchLines] of matchesByFile) {
				throwIfAborted(signal);

				// Load file to compute context-correct hashes
				let fileLines: string[];
				try {
					const loaded = await loadFileKindAndText(filePath);
					if (
						loaded.kind === "binary" ||
						loaded.kind === "image" ||
						loaded.kind === "directory"
					) {
						continue;
					}
					const normalized = normalizeToLF(stripBom(loaded.text).text);
					fileLines = normalized.split("\n");
					// Strip the trailing empty element from a terminal newline
					if (fileLines.length > 0 && fileLines[fileLines.length - 1] === "") {
						fileLines = fileLines.slice(0, -1);
					}
				} catch {
					continue;
				}

				const totalFileLines = fileLines.length;

				// Guard against a race where the file was truncated between rg reading
				// it and our loadFileKindAndText call. Out-of-bounds line numbers would
				// make formatHashlineRegion push empty strings; filter them out first.
				const validMatchLines = matchLines.filter((n) => n <= totalFileLines);
				if (validMatchLines.length === 0) continue;

				// Build merged context ranges for this file
				const ranges: LineRange[] = [];
				for (const lineNum of validMatchLines) {
					const start = Math.max(1, lineNum - contextLines);
					const end = Math.min(totalFileLines, lineNum + contextLines);
					mergeRange(ranges, { start, end });
				}

				fileCount++;

				// Relative path for display
				const displayPath = filePath.startsWith(ctx.cwd + "/")
					? filePath.slice(ctx.cwd.length + 1)
					: filePath;

				outputParts.push(`${displayPath}:`);

				let prevRangeEnd = -1;
				for (const range of ranges) {
					if (prevRangeEnd !== -1) {
						outputParts.push("    ...");
					}
					outputParts.push(formatHashlineRegion(fileLines, range.start, range.end));
					prevRangeEnd = range.end;
				}

				outputParts.push("---");
			}

			const summary = `${totalMatched} match${totalMatched !== 1 ? "es" : ""} in ${fileCount} file${fileCount !== 1 ? "s" : ""}.${truncated ? ` (truncated at ${limit})` : ""}`;
			outputParts.push(summary);

			return {
				content: [
					{
						type: "text",
						text: outputParts.join("\n"),
					},
				],
				details: {
					matches: totalMatched,
					files: fileCount,
					truncated,
				},
			};
		},
	});
}
