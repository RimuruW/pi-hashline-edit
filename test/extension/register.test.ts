import { spawnSync } from "child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import register from "../../index";

const rgAvailable = spawnSync("rg", ["--version"]).status === 0;

describe("extension registration", () => {
	it("registers the read and edit tools; grep when rg is available", () => {
		const toolNames: string[] = [];
		const eventNames: string[] = [];
		// Records registrations instead of using the shared fixture registry; the
		// cast names the gap: only registerTool/on are implemented.
		const pi = {
			registerTool(tool: { name: string }) {
				toolNames.push(tool.name);
			},
			on(name: string) {
				eventNames.push(name);
			},
		} as unknown as ExtensionAPI;

		register(pi);

		const expectedTools = rgAvailable
			? ["edit", "grep", "read"]
			: ["edit", "read"];
		expect(toolNames.sort()).toEqual(expectedTools);
		// No lifecycle hooks are registered by default; the only optional hook is a
		// debug session_start banner gated behind PI_HASHLINE_DEBUG.
		expect(eventNames).toEqual([]);
	});
});
