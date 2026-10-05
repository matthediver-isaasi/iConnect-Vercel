import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { DirectoryContactValue } = await import("./DirectoryContactValue");
const { DirectoryMemberCard } = await import("./DirectoryCards");

test("links retain labels, native focus and navigation, while isolating parent actions", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let parentActions = 0;
  await act(async () => root.render(
    <div onClick={() => parentActions++} onKeyDown={() => parentActions++} onAuxClick={() => parentActions++}>
      <DirectoryContactValue field={{ field_type: "url" }} value="example.test/path?q=1">Formatted label</DirectoryContactValue>
    </div>,
  ));
  const a = container.querySelector("a");
  assert.equal(a.textContent, "Formatted label");
  assert.equal(a.getAttribute("href"), "https://example.test/path?q=1");
  assert.equal(a.target, "_blank");
  assert.equal(a.rel, "noopener noreferrer");
  assert.match(a.className, /underline/);
  a.focus();
  assert.equal(document.activeElement, a);
  // Navigation itself is covered in Chromium; JSDOM only implements fragments.
  a.href = "#contact";
  for (const type of ["click", "auxclick", "keydown"]) {
    const event = type === "keydown"
      ? new window.KeyboardEvent(type, { key: "Enter", bubbles: true, cancelable: true })
      : new window.Event(type, { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(parentActions, 0);
  await act(async () => root.unmount());
  container.remove();
});

test("shared member cards preserve visibility, ordering, ordinary formatting and click isolation", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  let opens = 0;
  await act(async () => root.render(
    <DirectoryMemberCard member={{ id: "one", first_name: "Example" }} isGuest onView={() => opens++}
      directoryCustomFields={[
        { id: "hidden", field_type: "email", _visFront: false },
        { id: "email", label: "Contact", field_type: "text" },
        { id: "choice", label: "Choice", field_type: "dropdown", options: [{ value: "x", label: "example.test" }] },
        { id: "boolean", label: "Active", field_type: "boolean" },
      ]}
      memberValues={{ hidden: "hidden@example.test", email: "a@example.test", choice: "x", boolean: false }}
    />,
  ));
  assert.equal(container.querySelectorAll("a").length, 1);
  assert.doesNotMatch(container.textContent, /hidden@example/);
  assert.match(container.textContent, /Contacta@example.testChoiceexample.testActiveNo/);
  // JSDOM cannot launch mail applications; cancel navigation at the native
  // target listener only for this card-isolation assertion.
  container.querySelector("a").addEventListener("click", event => event.preventDefault());
  container.querySelector("a").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(opens, 0);
  container.querySelector("[data-testid='card-member-one']").click();
  assert.equal(opens, 1);
  await act(async () => root.unmount());
});
