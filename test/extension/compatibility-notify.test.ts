import { describe, expect, it, mock } from "bun:test";
import { registerCompatibilityNotifications } from "../../src/compatibility-notify";

describe("registerCompatibilityNotifications", () => {
  it("emits one warning at turn_end when one or more edit fallbacks were used", async () => {
    const handlers = new Map<string, Function>();
    const notify = mock(() => {});
    const pi = {
      on(name: string, handler: Function) {
        handlers.set(name, handler);
      },
    } as any;

    registerCompatibilityNotifications(pi);

    const ctx = { hasUI: true, ui: { notify } } as any;
    await handlers.get("turn_start")!({}, ctx);
    await handlers.get("tool_result")!(
      { toolName: "edit", isError: false, details: { compatibility: { used: true } } },
      ctx,
    );
    await handlers.get("tool_result")!(
      { toolName: "edit", isError: false, details: { compatibility: { used: true } } },
      ctx,
    );
    await handlers.get("turn_end")!({}, ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain(
      "Edit compatibility mode used for 2 edit(s)",
    );
    expect(notify.mock.calls[0]?.[1]).toBe("warning");
  });

  it("does not notify when no compatibility fallback was used", async () => {
    const handlers = new Map<string, Function>();
    const notify = mock(() => {});
    const pi = {
      on(name: string, handler: Function) {
        handlers.set(name, handler);
      },
    } as any;

    registerCompatibilityNotifications(pi);

    const ctx = { hasUI: true, ui: { notify } } as any;
    await handlers.get("turn_start")!({}, ctx);
    await handlers.get("turn_end")!({}, ctx);

    expect(notify).not.toHaveBeenCalled();
  });

  it("does not notify when the UI is unavailable", async () => {
    const handlers = new Map<string, Function>();
    const notify = mock(() => {});
    const pi = {
      on(name: string, handler: Function) {
        handlers.set(name, handler);
      },
    } as any;

    registerCompatibilityNotifications(pi);

    const ctx = { hasUI: false, ui: { notify } } as any;
    await handlers.get("turn_start")!({}, ctx);
    await handlers.get("tool_result")!(
      { toolName: "edit", isError: false, details: { compatibility: { used: true } } },
      ctx,
    );
    await handlers.get("turn_end")!({}, ctx);

    expect(notify).not.toHaveBeenCalled();
  });

  it("ignores error tool results", async () => {
    const handlers = new Map<string, Function>();
    const notify = mock(() => {});
    const pi = {
      on(name: string, handler: Function) {
        handlers.set(name, handler);
      },
    } as any;

    registerCompatibilityNotifications(pi);

    const ctx = { hasUI: true, ui: { notify } } as any;
    await handlers.get("turn_start")!({}, ctx);
    await handlers.get("tool_result")!(
      { toolName: "edit", isError: true, details: { compatibility: { used: true } } },
      ctx,
    );
    await handlers.get("turn_end")!({}, ctx);

    expect(notify).not.toHaveBeenCalled();
  });

  it("resets the accumulator between turns", async () => {
    const handlers = new Map<string, Function>();
    const notify = mock(() => {});
    const pi = {
      on(name: string, handler: Function) {
        handlers.set(name, handler);
      },
    } as any;

    registerCompatibilityNotifications(pi);

    const ctx = { hasUI: true, ui: { notify } } as any;

    await handlers.get("turn_start")!({}, ctx);
    await handlers.get("tool_result")!(
      { toolName: "edit", isError: false, details: { compatibility: { used: true } } },
      ctx,
    );
    await handlers.get("turn_end")!({}, ctx);

    await handlers.get("turn_start")!({}, ctx);
    await handlers.get("turn_end")!({}, ctx);

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("tracks compatibility warnings independently per session", async () => {
    const handlers = new Map<string, Function>();
    const notifyA = mock(() => {});
    const notifyB = mock(() => {});
    const pi = {
      on(name: string, handler: Function) {
        handlers.set(name, handler);
      },
    } as any;

    registerCompatibilityNotifications(pi);

    const ctxA = {
      hasUI: true,
      ui: { notify: notifyA },
      sessionManager: { getSessionFile: () => "/tmp/session-a.json" },
    } as any;
    const ctxB = {
      hasUI: true,
      ui: { notify: notifyB },
      sessionManager: { getSessionFile: () => "/tmp/session-b.json" },
    } as any;

    await handlers.get("turn_start")!({}, ctxA);
    await handlers.get("turn_start")!({}, ctxB);
    await handlers.get("tool_result")!(
      { toolName: "edit", isError: false, details: { compatibility: { used: true } } },
      ctxA,
    );

    await handlers.get("turn_end")!({}, ctxB);
    expect(notifyB).not.toHaveBeenCalled();

    await handlers.get("turn_end")!({}, ctxA);
    expect(notifyA).toHaveBeenCalledTimes(1);
    expect(notifyA.mock.calls[0]?.[0]).toContain(
      "Edit compatibility mode used for 1 edit(s)",
    );
  });
});
