import { describe, expect, it } from "vitest";
import {
	resolveEditAnchors,
	type Anchor,
	type HashlineToolEdit,
} from "../../src/hashline";

describe("resolveEditAnchors", () => {
	it("resolves replace with pos + end", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", pos: "1#ZZ", end: "3#PP", lines: ["a", "b"] },
		];
		const resolved = resolveEditAnchors(edits);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].op).toBe("replace");
		expect(resolved[0]).toHaveProperty("pos");
		expect(resolved[0]).toHaveProperty("end");
	});

	it("resolves replace with pos only (single-line)", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", pos: "5#MQ", lines: ["new"] },
		];
		const resolved = resolveEditAnchors(edits);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].op).toBe("replace");
		const r = resolved[0] as {
			op: "replace";
			pos: Anchor;
			end?: Anchor;
			lines: string[];
		};
		expect(r.pos.line).toBe(5);
		expect(r.end).toBeUndefined();
	});

	it("rejects replace with end only", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", end: "5#MQ", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/requires a "pos" anchor/i);
	});

	it("throws on replace with no anchors", () => {
		const edits: HashlineToolEdit[] = [{ op: "replace", lines: ["new"] }];
		expect(() => resolveEditAnchors(edits)).toThrow(/requires a "pos" anchor/i);
	});

	it("throws on malformed pos for append (not silently degraded to EOF)", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "append", pos: "garbage", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
	});

	it("throws on malformed pos for prepend (not silently degraded to BOF)", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "prepend", pos: "garbage", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
	});

	it("throws on malformed pos for replace", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", pos: "not-valid", lines: ["x"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
	});

	it("throws on malformed end for replace with valid pos", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", pos: "5#MQ", end: "garbage", lines: ["x"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid line reference/);
	});

	it("resolves append with pos", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "append", pos: "5#MQ", lines: ["new"] },
		];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0].op).toBe("append");
		const append = resolved[0] as {
			op: "append";
			pos?: Anchor;
			lines: string[];
		};
		expect(append.pos?.line).toBe(5);
	});

	it("resolves append without pos (EOF)", () => {
		const edits: HashlineToolEdit[] = [{ op: "append", lines: ["new"] }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0].op).toBe("append");
		const append = resolved[0] as {
			op: "append";
			pos?: Anchor;
			lines: string[];
		};
		expect(append.pos).toBeUndefined();
	});

	it("rejects append with end", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "append", end: "5#MQ", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/\[E_BAD_OP\].*append.*end/i,
		);
	});

	it("resolves prepend with pos", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "prepend", pos: "5#MQ", lines: ["new"] },
		];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0].op).toBe("prepend");
	});

	it("resolves prepend without pos (BOF)", () => {
		const edits: HashlineToolEdit[] = [{ op: "prepend", lines: ["new"] }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0].op).toBe("prepend");
		const prepend = resolved[0] as {
			op: "prepend";
			pos?: Anchor;
			lines: string[];
		};
		expect(prepend.pos).toBeUndefined();
	});

	it("rejects prepend with end", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "prepend", end: "5#MQ", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/\[E_BAD_OP\].*prepend.*end/i,
		);
	});

	it("rejects string lines input", () => {
		const edits: HashlineToolEdit[] = [
			{
				op: "replace",
				pos: "1#ZZ",
				lines: "hello\nworld\n",
			} as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/lines" must be a string array/i,
		);
	});

	it("rejects null lines input", () => {
		const edits: HashlineToolEdit[] = [
			{
				op: "replace",
				pos: "1#ZZ",
				lines: null,
			} as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/lines" must be a string array/i,
		);
	});

	it("throws on unknown op", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "something_weird", pos: "1#ZZ", lines: ["x"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/\[E_BAD_OP\].*unknown op.*something_weird/i,
		);
	});

	it("rejects missing op", () => {
		const edits: HashlineToolEdit[] = [
			// Deliberately protocol-violating input: op is required by the type.
			{ pos: "1#ZZ", lines: ["x"] } as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/requires an "op" string/i);
	});
});
