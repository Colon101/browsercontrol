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
});
