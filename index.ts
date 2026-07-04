import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEditTool } from "./src/edit";
import { registerGrepTool } from "./src/grep";
import { registerReadTool } from "./src/read";
import { getGrepEnabled, getConfigWarnings } from "./src/config";

export default function (pi: ExtensionAPI): void {
	registerReadTool(pi);
	registerEditTool(pi);
	if (getGrepEnabled()) {
		registerGrepTool(pi);
	}

	pi.on("session_start", async (_event, ctx) => {
		const warnings = getConfigWarnings();
		if (warnings.length > 0) {
			ctx.ui.notify(
				`hashline.json config warnings:\n${warnings.join("\n")}`,
				"warning",
			);
		}

		const debugValue = process.env.PI_HASHLINE_DEBUG;
		if (debugValue === "1" || debugValue === "true") {
			ctx.ui.notify("Hashline Edit mode active", "info");
		}
	});
}
