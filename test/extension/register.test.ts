import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import register from "../../index";

describe("extension registration", () => {
	it("registers the read and edit tools", () => {
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

		expect(toolNames.sort()).toEqual(["edit", "read"]);
		// No lifecycle hooks are registered by default; the only optional hook is a
		// debug session_start banner gated behind PI_HASHLINE_DEBUG.
		expect(eventNames).toEqual([]);
	});
});
