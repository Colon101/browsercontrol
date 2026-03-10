// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { runPageTool } from "../apps/extension-firefox/src/page-driver.js";

describe("page driver", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <button id="primary">Continue</button>
        <label for="name">Name</label>
        <input id="name" type="text" />
      </main>
    `;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 720
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        if (this.id === "primary") {
          return {
            x: 40,
            y: 24,
            top: 24,
            left: 40,
            right: 160,
            bottom: 64,
            width: 120,
            height: 40,
            toJSON() {
              return {};
            }
          };
        }
        if (this.id === "name") {
          return {
            x: 40,
            y: 90,
            top: 90,
            left: 40,
            right: 260,
            bottom: 126,
            width: 220,
            height: 36,
            toJSON() {
              return {};
            }
          };
        }
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON() {
            return {};
          }
        };
      }
    });
  });

  it("returns visible targets with get_page_snapshot", async () => {
    const result = await runPageTool("get_page_snapshot", {});

    expect(result.ok).toBe(true);
    expect(result.targets?.length).toBeGreaterThanOrEqual(2);
    expect(result.targets?.[0]?.id).toBe("t1");
  });

  it("types into a target and returns action feedback", async () => {
    const snapshot = await runPageTool("get_page_snapshot", {});
    const inputTarget = snapshot.targets?.find((target) => target.kind === "input");
    expect(inputTarget).toBeTruthy();

    const result = await runPageTool("type_target", {
      targetId: inputTarget!.id,
      text: "Kfir",
      append: false
    });

    expect(result.ok).toBe(true);
    expect((document.getElementById("name") as HTMLInputElement).value).toBe("Kfir");
    expect(result.actionFeedback?.toolName).toBe("type_target");
    expect(result.actionFeedback?.targetId).toBe(inputTarget!.id);
  });

  it("splits delegated container controls into distinct visible targets", async () => {
    document.body.innerHTML = `
      <main>
        <div id="settings-nav" tabindex="0">
          <div id="general-item">General</div>
          <div id="connectors-item">Connectors</div>
          <div id="usage-item">Usage</div>
          <div id="data-controls-item">Data controls</div>
        </div>
      </main>
    `;

    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
          "settings-nav": { x: 16, y: 120, width: 220, height: 260 },
          "general-item": { x: 24, y: 132, width: 120, height: 28 },
          "connectors-item": { x: 24, y: 190, width: 120, height: 28 },
          "usage-item": { x: 24, y: 248, width: 120, height: 28 },
          "data-controls-item": { x: 24, y: 306, width: 140, height: 28 }
        };
        const rect = this.id ? rects[this.id] : undefined;
        if (rect) {
          return {
            x: rect.x,
            y: rect.y,
            top: rect.y,
            left: rect.x,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height,
            width: rect.width,
            height: rect.height,
            toJSON() {
              return {};
            }
          };
        }
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON() {
            return {};
          }
        };
      }
    });

    const result = await runPageTool("get_page_snapshot", {});
    const names = (result.targets ?? []).map((target) => target.name);

    expect(names).toContain("Usage");
    expect(names).toContain("Connectors");
    expect(names).toContain("Data controls");
    expect(names).not.toContain("General Connectors Usage Data controls");
  });
});
