import { afterEach, describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	computeLineHash,
	resolveEditAnchors,
	type HashlineToolEdit,
} from "../../src/hashline";
import {
	__resetConfigForTests,
	__setHashLengthForTests,
} from "../../src/config";

describe("strict edit input (no autocorrection)", () => {
	it("rejects array lines containing rendered LINE#HASH: prefixes", () => {
		const tag = `1#${computeLineHash(["foo"], 0)}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag, lines: ["1#ZP:foo"] },
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("rejects string lines before patch-prefix validation", () => {
		const tag = `1#${computeLineHash(["foo"], 0)}`;
		const toolEdits: HashlineToolEdit[] = [
			{
				op: "replace",
				pos: tag,
				lines: "+1#ZP:foo",
			} as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(
			/lines" must be a string array/i,
		);
	});

	it("rejects diff deletion rows in array form", () => {
		const tag = `1#${computeLineHash(["foo"], 0)}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag, lines: ["-1    foo"] },
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("accepts plain literal content unchanged", () => {
		const tag = `1#${computeLineHash(["foo"], 0)}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag, lines: ["bar"] },
		];
		const resolved = resolveEditAnchors(toolEdits);
		expect(resolved).toHaveLength(1);
		if (resolved[0]?.op === "replace") {
			expect(resolved[0].lines).toEqual(["bar"]);
		} else {
			throw new Error("expected replace");
		}
	});

	it("preserves '#' comment lines that do not match the strict prefix", () => {
		const tag = `1#${computeLineHash(["foo"], 0)}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag, lines: ["# Note: keep me"] },
		];
		const resolved = resolveEditAnchors(toolEdits);
		if (resolved[0]?.op === "replace") {
			expect(resolved[0].lines).toEqual(["# Note: keep me"]);
		} else {
			throw new Error("expected replace");
		}
	});
});

describe("display prefixes from other hash-length configurations", () => {
	afterEach(() => {
		__resetConfigForTests();
	});

	it("rejects 4-char LINE#HASH: prefixes in a 2-char session", () => {
		const tag = `1#${computeLineHash(["foo"], 0)}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag, lines: ["1#MQQV:foo"] },
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("rejects 3-char diff '+' prefixes in a 2-char session", () => {
		const tag = `1#${computeLineHash(["foo"], 0)}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag, lines: ["+1#MQQ:foo"] },
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("rejects 2-char LINE#HASH: prefixes in a 4-char session", () => {
		__setHashLengthForTests(4);
		const tag = `1#${computeLineHash(["foo"], 0)}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag, lines: ["1#ZP:foo"] },
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("accepts a 5-char run — not a display prefix under any configuration", () => {
		const tag = `1#${computeLineHash(["foo"], 0)}`;
		const toolEdits: HashlineToolEdit[] = [
			{ op: "replace", pos: tag, lines: ["1#MQQVZ:foo"] },
		];
		const resolved = resolveEditAnchors(toolEdits);
		if (resolved[0]?.op === "replace") {
			expect(resolved[0].lines).toEqual(["1#MQQVZ:foo"]);
		} else {
			throw new Error("expected replace");
		}
	});

	it("keeps bare 'HH:' handling at the session length (no cross-length hard reject)", () => {
		// A 4-char bare prefix in a 2-char session can never match the file's
		// hash set, so it is treated as literal content — no reject, no warning.
		const file = "alpha\nbeta";
		const anchor = `1#${computeLineHash(file.split("\n"), 0)}`;
		const result = applyHashlineEdits(
			file,
			resolveEditAnchors([
				{ op: "replace", pos: anchor, lines: ["MQQV:literal"] },
			]),
		);
		expect(result.warnings?.some((w) => /start with a hash/.test(w)) ?? false).toBe(
			false,
		);
		expect(result.content).toContain("MQQV:literal");
	});
});

describe("partial hash prefixes copied into content (issue #24)", () => {
	// Fixture hash set is {KT, JB, KJ, PX}; "ZZ"/"ZP"/"TS" are confirmed misses.
	const file = "alpha\nbeta\ngamma\ndelta";
	const anchor = `1#${computeLineHash(file.split("\n"), 0)}`;

	function applyTool(toolEdits: HashlineToolEdit[]) {
		return applyHashlineEdits(file, resolveEditAnchors(toolEdits));
	}

	it("warns (does not reject) when a bare prefix matches an existing file line hash", () => {
		// "JB" is the hash of line 2 ("beta"), but 2-char hashes can collide with
		// legitimate literal content. Warn only; never silently patch or reject.
		const result = applyTool([
			{ op: "replace", pos: anchor, lines: ["JB:### heading", "real content"] },
		]);
		expect(
			result.warnings?.some((w) => /match existing line hashes/.test(w)),
		).toBe(true);
		expect(result.content).toContain("JB:### heading");
	});

	it("preserves valid literal 'HH:' content even when HH exists in the file hash set", () => {
		const result = applyTool([
			{ op: "replace", pos: anchor, lines: ["JB:text"] },
		]);
		expect(
			result.warnings?.some((w) => /match existing line hashes/.test(w)),
		).toBe(true);
		expect(result.content).toContain("JB:text");
	});

	it("warns (does not reject) when bare prefixes miss the file hash set", () => {
		const result = applyTool([
			{ op: "replace", pos: anchor, lines: ["ZZ:one", "ZP:two"] },
		]);
		expect(result.warnings?.some((w) => /start with a hash/.test(w))).toBe(true);
		// Content is written verbatim — strict semantics, no silent patching.
		expect(result.content).toContain("ZZ:one");
		expect(result.content).toContain("ZP:two");
	});

	it("accepts a single legit 'HH:' line without warning (below threshold)", () => {
		const result = applyTool([
			{ op: "replace", pos: anchor, lines: ["TS: TypeScript"] },
		]);
		expect(result.warnings?.some((w) => /start with a hash/.test(w)) ?? false).toBe(
			false,
		);
		expect(result.content).toContain("TS: TypeScript");
	});
});
