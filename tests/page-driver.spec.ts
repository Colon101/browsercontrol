// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { collectPageSnapshot, runPageTool } from "../apps/extension-firefox/src/page-driver.js";

describe("page driver", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <h1>Questionnaire</h1>
        <label for="name">Name</label>
        <input id="name" type="text" />
        <label>
          <input id="terms" type="checkbox" />
          Accept terms
        </label>
        <select id="color">
          <option value="">Choose</option>
          <option value="blue">Blue</option>
          <option value="green">Green</option>
        </select>
        <button id="submit">Send</button>
      </main>
    `;
  });

  it("collects a stable page snapshot", () => {
    const snapshot = collectPageSnapshot();
    expect(snapshot.title).toBe(document.title);
    expect(snapshot.forms.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.interactiveElements.length).toBeGreaterThanOrEqual(4);
  });

  it("updates inputs and checkboxes", async () => {
    const snapshot = collectPageSnapshot();
    const nameField = snapshot.forms.find((field) => field.label === "Name");
    const termsField = snapshot.forms.find((field) => field.type === "checkbox");

    const typeResult = await runPageTool("type_into", {
      elementId: nameField?.elementId,
      text: "Kfir",
      append: false
    });
    const checkboxResult = await runPageTool("set_checkbox", {
      elementId: termsField?.elementId,
      checked: true
    });

    expect(typeResult.ok).toBe(true);
    expect((document.getElementById("name") as HTMLInputElement).value).toBe("Kfir");
    expect(checkboxResult.ok).toBe(true);
    expect((document.getElementById("terms") as HTMLInputElement).checked).toBe(true);
  });

  it("selects a dropdown option", async () => {
    const snapshot = collectPageSnapshot();
    const selectField = snapshot.forms.find((field) => field.type === "select");
    const result = await runPageTool("select_option", {
      elementId: selectField?.elementId,
      valueOrLabel: "Blue"
    });

    expect(result.ok).toBe(true);
    expect((document.getElementById("color") as HTMLSelectElement).value).toBe("blue");
  });
});
