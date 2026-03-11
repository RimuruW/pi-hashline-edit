import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

function getSessionKey(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (sessionFile) {
    return sessionFile;
  }

  const sessionId = (ctx as { sessionId?: string }).sessionId;
  if (sessionId) {
    return sessionId;
  }

  return "__default_session__";
}

export function registerCompatibilityNotifications(pi: ExtensionAPI): void {
  const compatibilityCounts = new Map<string, number>();

  pi.on("turn_start", async (_event, ctx) => {
    compatibilityCounts.set(getSessionKey(ctx), 0);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" || event.isError) {
      return;
    }

    const details = event.details as
      | {
          compatibility?: {
            used?: boolean;
          };
        }
      | undefined;

    if (details?.compatibility?.used) {
      const sessionKey = getSessionKey(ctx);
      compatibilityCounts.set(sessionKey, (compatibilityCounts.get(sessionKey) ?? 0) + 1);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const sessionKey = getSessionKey(ctx);
    const compatibilityCount = compatibilityCounts.get(sessionKey) ?? 0;

    if (!ctx.hasUI || compatibilityCount === 0) {
      compatibilityCounts.delete(sessionKey);
      return;
    }

    ctx.ui.notify(
      `Edit compatibility mode used for ${compatibilityCount} edit(s)`,
      "warning",
    );
    compatibilityCounts.delete(sessionKey);
  });
}
