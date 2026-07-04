import { readFile } from "fs/promises";
import { describe, expect, it, vi } from "vitest";
import { writeFileAtomically } from "../../src/fs-write";

vi.mock("../../src/fs-write", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/fs-write")>();
	return {
		...original,
		writeFileAtomically: vi.fn(original.writeFileAtomically),
	};
});

import { registerEditTool } from "../../src/edit";
import { registerReadTool } from "../../src/read";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, makeToolContext, withTempFile } from "../support/fixtures";

describe("edit tool write failures", () => {
	it("does not mark a payload as applied until the atomic write succeeds", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerReadTool(pi);
			registerEditTool(pi);
			const readTool = getTool("read");
			const editTool = getTool("edit");
			const ctx = makeToolContext(cwd);

			await readTool.execute(
				"r1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				ctx,
			);

			const fileLines = "alpha\nbeta\n".split("\n");
			const payload = {
				path: "sample.txt",
				edits: [
					{
						op: "replace",
						pos: `1#${computeLineHash(fileLines, 0)}`,
						lines: ["ALPHA"],
					},
				],
			};

			const writeMock = vi.mocked(writeFileAtomically);
			writeMock.mockRejectedValueOnce(new Error("disk full"));

			await expect(
				editTool.execute("e1", payload, undefined, undefined, ctx),
			).rejects.toThrow(/disk full/);
			expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");

			await expect(
				editTool.execute("e2", payload, undefined, undefined, ctx),
			).resolves.toMatchObject({
				details: { classification: "applied" },
			});
			expect(await readFile(path, "utf-8")).toBe("ALPHA\nbeta\n");
			expect(writeMock).toHaveBeenCalledTimes(2);
		});
	});
});
