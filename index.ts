/**
 * Hashline Edit Extension for pi-coding-agent
 *
 * Overrides built-in `read`, `grep`, and `edit` tools with hashline workflow:
 * - `read` outputs lines as `LINE#HASH:content`
 * - `grep` outputs matched lines with `LINE#HASH` anchors
 * - `edit` accepts hash-verified anchors (`set_line`, `replace_lines`, `insert_after`, `replace`)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerEditTool } from "./src/edit";
import { registerGrepTool } from "./src/grep";
import { registerReadTool } from "./src/read";

interface StartupToolsPreference {
	grepEnabled: boolean;
}

function parseStartupToolsPreference(argv: string[]): StartupToolsPreference {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--tools") {
			const raw = argv[i + 1] ?? "";
			const tools = raw
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
			return { grepEnabled: tools.includes("grep") };
		}
		if (arg.startsWith("--tools=")) {
			const raw = arg.slice("--tools=".length);
			const tools = raw
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
			return { grepEnabled: tools.includes("grep") };
		}
	}
	return { grepEnabled: false };
}

export default function (pi: ExtensionAPI): void {
	registerReadTool(pi);
	registerGrepTool(pi);
	registerEditTool(pi);

	const startupToolsPreference = parseStartupToolsPreference(process.argv.slice(2));

	pi.on("session_start", async (_event, ctx) => {
		if (!startupToolsPreference.grepEnabled) {
			const activeTools = pi.getActiveTools();
			if (activeTools.includes("grep")) {
				pi.setActiveTools(activeTools.filter((name) => name !== "grep"));
			}
		}

		const debugValue = process.env.PI_HASHLINE_DEBUG;
		const debugNotify = debugValue === "1" || debugValue === "true";
		if (debugNotify) {
			ctx.ui.notify("Hashline Edit mode active", "info");
		}
	});
}
