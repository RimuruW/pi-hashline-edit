/**
 * Prompt loader with anchor-example rewriting.
 *
 * Prompt files are authored with 2-character hash examples (the default
 * session length). At load time, loadPrompt() rewrites those examples to
 * match the configured hash length so that models always see correctly-sized
 * anchor tokens regardless of the deployment hash length.
 *
 * Rewriting is one-shot at extension load time (top-level const in each tool
 * file); there is no hot-reload because config does not change at runtime.
 */

import { readFileSync } from "node:fs";
import { getHashLength } from "./config";

/**
 * Padding characters used to extend example hash tokens beyond 2 characters.
 * These must stay in sync with the exampleAnchor() source in config.ts:
 *   exampleAnchor source = "MQQV", so padding = "QV" (chars at index 2 and 3).
 */
const EXAMPLE_HASH_PADDING = "QV";

/**
 * Rewrite anchor-shaped example tokens in prompt text to use hashes of the
 * given length.
 *
 * Matches tokens of the form `<digits>#<2-char hash alphabet sequence>` at a
 * word boundary and pads (or leaves as-is for len=2) the hash portion.
 *
 * len=2: identity (no padding needed, the source is 2 chars).
 * len=3: appends "Q"  (first char of EXAMPLE_HASH_PADDING).
 * len=4: appends "QV" (both chars of EXAMPLE_HASH_PADDING).
 */
export function rewriteAnchorExamples(text: string, len: number): string {
	if (len === 2) {
		return text;
	}
	const padding = EXAMPLE_HASH_PADDING.slice(0, len - 2);
	return text.replace(
		/(\d+)#([ZPMQVRWSNKTXJBYH]{2})\b/g,
		(_match, line: string, hash: string) => `${line}#${hash}${padding}`,
	);
}

/**
 * Read a prompt file and rewrite its anchor examples to match the configured
 * hash length. The rewrite is identity when hash length is 2 (the default),
 * so production deployments that never change the config see no difference.
 */
export function loadPrompt(url: URL): string {
	const text = readFileSync(url, "utf8");
	return rewriteAnchorExamples(text, getHashLength());
}
