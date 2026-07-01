import { describe, expect, it } from "vitest";
import { safeSessionPathSegment } from "../apps/agent/src/index.js";

describe("agent server artifact paths", () => {
  it("keeps normal run ids readable", () => {
    expect(safeSessionPathSegment("run-42")).toBe("run-42");
  });

  it("keeps untrusted session ids inside a single safe path segment", () => {
    const segment = safeSessionPathSegment("../../tmp/owned");

    expect(segment).not.toContain("/");
    expect(segment).not.toContain("..");
    expect(segment).toMatch(/^tmp_owned-[a-f0-9]{12}$/);
  });
});
