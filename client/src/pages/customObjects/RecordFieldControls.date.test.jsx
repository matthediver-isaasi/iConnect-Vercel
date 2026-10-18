import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.test" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RecordFieldControl } = await import("./RecordFieldControls.jsx");

test("date editor displays UK dates and emits ISO values independently of browser locale", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let value;
  const render = (current, disabled = false) => root.render(
    <RecordFieldControl field={{ name: "start_date", label: "Start date", field_type: "date" }}
      value={current} disabled={disabled} onChange={(next) => { value = next; }} />,
  );
  try {
    await act(async () => render("2023-06-02"));
    const input = container.querySelector("input");
    assert.equal(input.type, "text");
    assert.equal(input.value, "02/06/2023");
    assert.equal(input.placeholder, "dd/mm/yyyy");
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    await act(async () => {
      set.call(input, "19/03/2024");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(value, "2024-03-19");
    await act(async () => render(value));
    assert.equal(input.value, "19/03/2024");
    await act(async () => {
      set.call(input, "");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(value, "");
    await act(async () => render(null, true));
    assert.equal(input.value, "");
    assert.equal(input.disabled, true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
