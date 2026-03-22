import { describe, expect, it } from "bun:test";
import { throwIfAborted } from "../../src/runtime";

describe("throwIfAborted", () => {
  it("does nothing when signal is undefined", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it("does nothing when signal is not aborted", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  it("throws when signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(
      "Operation aborted",
    );
  });
});
