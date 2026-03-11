import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerEditTool } from "./src/edit";
import { registerReadTool } from "./src/read";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);

  const debugValue = process.env.PI_HASHLINE_DEBUG;
  if (debugValue === "1" || debugValue === "true") {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("Hashline Edit mode active", "info");
    });
  }
}
