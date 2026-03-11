import { describe, expect, it } from "bun:test";
import { assertStrictHashlineRequest } from "../../src/edit";

describe("assertStrictHashlineRequest", () => {
  it("rejects unknown or unsupported root fields", () => {
    expect(() =>
      assertStrictHashlineRequest({ path: "a.ts", legacy_field: [] } as any),
    ).toThrow(/unknown or unsupported fields/i);
  });
});
