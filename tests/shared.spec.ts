import { describe, expect, it, beforeEach } from "vitest";
import {
  createIncrementingId,
  createSessionId,
  resetIncrementingIds,
  resolveEffectiveModelId
} from "../packages/shared/src/index.js";

describe("shared ids and model defaults", () => {
  beforeEach(() => {
    resetIncrementingIds();
  });

  it("creates incrementing ids instead of uuids", () => {
    expect(createIncrementingId("shot")).toBe("shot-1");
    expect(createIncrementingId("shot")).toBe("shot-2");
    expect(createSessionId()).toBe("run-1");
  });

  it("maps auto to the effort-specific default model", () => {
    expect(resolveEffectiveModelId("auto", "high")).toBe("gpt-5.1-codex-max");
    expect(resolveEffectiveModelId("auto", "medium")).toBe("gpt-5.1-codex");
    expect(resolveEffectiveModelId("auto", "low")).toBe("gpt-5.1-codex-mini");
  });
});
