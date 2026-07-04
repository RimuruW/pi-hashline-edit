import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	__resetConfigForTests,
	__setHashLengthForTests,
} from "../../src/config";
import { loadPrompt, rewriteAnchorExamples } from "../../src/prompt-loader";

const promptsDir = new URL("../../prompts/", import.meta.url);
const promptFiles = readdirSync(promptsDir).filter((name) =>
	name.endsWith(".md"),
);

afterEach(() => {
	__resetConfigForTests();
});

describe("rewriteAnchorExamples", () => {
	it("is identity for len=2 (default)", () => {
		expect(rewriteAnchorExamples("12#MQ", 2)).toBe("12#MQ");
		expect(rewriteAnchorExamples("5#VR end text", 2)).toBe("5#VR end text");
	});

	it("pads to len=3 with one extra char", () => {
		expect(rewriteAnchorExamples("12#MQ", 3)).toBe("12#MQQ");
	});

	it("pads to len=4 with two extra chars", () => {
		expect(rewriteAnchorExamples("12#MQ", 4)).toBe("12#MQQV");
		expect(rewriteAnchorExamples("5#VR", 4)).toBe("5#VRQV");
	});

	it("does not rewrite template placeholders like LINE#HASH", () => {
		// No leading digits — should not match
		const noMatch = "LINE#HASH and also HH suffix";
		expect(rewriteAnchorExamples(noMatch, 4)).toBe(noMatch);
	});

	it("does not rewrite bare HH without digit prefix", () => {
		const noMatch = "#MQ is not an anchor";
		expect(rewriteAnchorExamples(noMatch, 4)).toBe(noMatch);
	});

	it("only rewrites tokens where the hash is exactly 2 alphabet chars at word boundary", () => {
		// 3-char hash like #MQQ should not be matched (pattern requires exactly 2)
		const noMatch = "12#MQQ extra";
		expect(rewriteAnchorExamples(noMatch, 4)).toBe(noMatch);
	});
});

describe("loadPrompt — identity guard (len=2)", () => {
	it("loadPrompt output matches raw file bytes for all prompts at default length", () => {
		// len=2 is the default; rewriteAnchorExamples is identity, so output must
		// be byte-identical to the file on disk.
		for (const name of promptFiles) {
			const url = new URL(name, promptsDir);
			const raw = readFileSync(url, "utf8");
			expect(loadPrompt(url), `${name} should be byte-identical at len=2`).toBe(
				raw,
			);
		}
	});
});

describe("loadPrompt — rewrite at len=4", () => {
	it("rewriteAnchorExamples produces expected tokens at len=4", () => {
		__setHashLengthForTests(4);
		expect(rewriteAnchorExamples("12#MQ", 4)).toBe("12#MQQV");
		expect(rewriteAnchorExamples("5#VR", 4)).toBe("5#VRQV");
	});

	it("edit.md contains 12#MQQV and 5#VRQV after rewrite at len=4", () => {
		__setHashLengthForTests(4);
		const content = loadPrompt(new URL("edit.md", promptsDir));
		expect(content).toContain("12#MQQV");
		expect(content).toContain("5#VRQV");
	});

	it("edit-snippet.md contains 5#MQQV after rewrite at len=4", () => {
		__setHashLengthForTests(4);
		const content = loadPrompt(new URL("edit-snippet.md", promptsDir));
		expect(content).toContain("5#MQQV");
	});
});

describe("misfire guard — non-anchor patterns never rewritten", () => {
	it("LINE#HASH placeholder is not rewritten at any length", () => {
		for (const len of [2, 3, 4] as const) {
			expect(rewriteAnchorExamples("LINE#HASH", len)).toBe("LINE#HASH");
		}
	});

	it("bare HH pattern without digit prefix is not rewritten at any length", () => {
		for (const len of [2, 3, 4] as const) {
			expect(rewriteAnchorExamples("LINE#HH", len)).toBe("LINE#HH");
		}
	});
});
