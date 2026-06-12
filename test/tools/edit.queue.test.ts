import { symlink } from "fs/promises";
import { readFile } from "fs/promises";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { computeLineHash } from "../../src/hashline";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const original = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...original,
		withFileMutationQueue: vi.fn(async (path: string, work: () => Promise<unknown>) => {
			return work();
		}),
	};
});

vi.mock("../../src/read", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/read")>();
	return {
		...original,
		formatHashlineReadPreview: (text: string) => ({ text }),
	};
});

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { registerEditTool } from "../../src/edit";
import { makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

function makeFakeRegistry() {
	const { pi, getTool } = makeFakePiRegistry();
	registerEditTool(pi);
	return { tool: getTool("edit") };
}

describe("edit tool file mutation queue", () => {
	beforeEach(() => {
		vi.mocked(withFileMutationQueue).mockClear();
	});

	it("uses the same queue key for repeated edits to the same path", async () => {
		await withTempFile("race.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
			const { tool } = makeFakeRegistry();
			const ctx = makeToolContext(cwd);

			await tool.execute(
				"call-1",
				{
					path: "race.ts",
					edits: [
						{
							op: "replace",
							pos: `1#${computeLineHash(1, "alpha")}`,
							lines: ["ALPHA"],
						},
					],
				},
				undefined,
				undefined,
				ctx,
			);
			await tool.execute(
				"call-2",
				{
					path: "race.ts",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(2, "beta")}`,
							lines: ["BETA"],
						},
					],
				},
				undefined,
				undefined,
				ctx,
			);

			const queueKeys = vi.mocked(withFileMutationQueue).mock.calls.map(([key]) => key);
			const finalContent = await readFile(path, "utf-8");

			expect({ finalContent, queueKeys }).toEqual({
				finalContent: "ALPHA\nBETA\ngamma\n",
				queueKeys: [path, path],
			});
		});
	});

	it("canonicalizes the queue key when a symlink points at the same file", async () => {
		await withTempFile("race.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
			await symlink("race.ts", `${cwd}/linked-race.ts`);

			const { tool } = makeFakeRegistry();
			const ctx = makeToolContext(cwd);

			await tool.execute(
				"call-1",
				{
					path: "race.ts",
					edits: [
						{
							op: "replace",
							pos: `1#${computeLineHash(1, "alpha")}`,
							lines: ["ALPHA"],
						},
					],
				},
				undefined,
				undefined,
				ctx,
			);
			await tool.execute(
				"call-2",
				{
					path: "linked-race.ts",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(2, "beta")}`,
							lines: ["BETA"],
						},
					],
				},
				undefined,
				undefined,
				ctx,
			);

			const queueKeys = vi.mocked(withFileMutationQueue).mock.calls.map(([key]) => key);
			const finalContent = await readFile(path, "utf-8");

			expect({ finalContent, queueKeys }).toEqual({
				finalContent: "ALPHA\nBETA\ngamma\n",
				queueKeys: [path, path],
			});
		});
	});

	it("canonicalizes the queue key when a parent directory is a symlink", async () => {
		await withTempFile("race.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
			await symlink(".", `${cwd}/aliasdir`);

			const { tool } = makeFakeRegistry();
			const ctx = makeToolContext(cwd);

			await tool.execute(
				"call-1",
				{
					path: "race.ts",
					edits: [
						{
							op: "replace",
							pos: `1#${computeLineHash(1, "alpha")}`,
							lines: ["ALPHA"],
						},
					],
				},
				undefined,
				undefined,
				ctx,
			);
			await tool.execute(
				"call-2",
				{
					path: "aliasdir/race.ts",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(2, "beta")}`,
							lines: ["BETA"],
						},
					],
				},
				undefined,
				undefined,
				ctx,
			);

			const queueKeys = vi.mocked(withFileMutationQueue).mock.calls.map(([key]) => key);
			const finalContent = await readFile(path, "utf-8");

			expect({ finalContent, queueKeys }).toEqual({
				finalContent: "ALPHA\nBETA\ngamma\n",
				queueKeys: [path, path],
			});
		});
	});
});
