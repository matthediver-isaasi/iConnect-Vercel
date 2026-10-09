import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundlePath = path.resolve(`client/src/components/sales/.collaborator-fixture-${process.pid}.mjs`);
await build({
  entryPoints: ["client/src/components/sales/CollaboratorPicker.jsx"], outfile: bundlePath,
  bundle: true, format: "esm", platform: "node", packages: "external", jsx: "transform",
  alias: { "@": path.resolve("client/src") }, logLevel: "silent",
});
const { default: Picker } = await import(pathToFileURL(bundlePath).href);
after(async () => { dom.window.close(); await unlink(bundlePath); });
const h = React.createElement;
const member = (id, first_name = "Asha", last_name = "Malik") => ({ id, first_name, last_name, email: `${id}@membership.test` });
const page = (items, nextOffset = null) => ({ items, nextOffset });
const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
async function mount(props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(h(Picker, props)));
  return {
    container,
    render: async next => { await act(async () => root.render(h(Picker, next))); },
    close: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}
const addButton = container => [...container.querySelectorAll("button")].find(button => /^(Add|Adding…)$/.test(button.textContent));
async function choose(container, id) {
  await act(async () => {
    const select = container.querySelector("select");
    select.value = id;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
async function search(container, value) {
  await act(async () => {
    const input = container.querySelector("input");
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("automatically loads every page before enabling add; searches names/email locally", async () => {
  const calls = [];
  let complete;
  const request = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? page([member("first")], 100) : new Promise(resolve => { complete = resolve; });
  };
  const mounted = await mount({ opportunityId: "opp/a", request, onAdd: async () => {} });
  try {
    await tick();
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /opp%2Fa\?resource=collaborator-options&offset=0$/);
    assert.match(calls[1].url, /offset=100$/);
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.match(mounted.container.textContent, /Loading team colleagues/);
    assert.ok(addButton(mounted.container).disabled);
    await act(async () => complete(page([member("last", "Priya", "Shah")], 200)));
    // Third page is also fetched automatically.
    await tick();
    assert.equal(calls.length, 3);
    await act(async () => complete(page([member("final", "Tariq", "Khan")])));
    assert.match(mounted.container.textContent, /Asha Malik/);
    assert.match(mounted.container.textContent, /Priya Shah/);
    assert.match(mounted.container.textContent, /Tariq Khan/);
    await search(mounted.container, "pRiYa");
    assert.equal(mounted.container.querySelectorAll("option").length, 2);
    await search(mounted.container, "final@");
    assert.match(mounted.container.querySelector("select").textContent, /Tariq Khan/);
    await search(mounted.container, "not present");
    assert.match(mounted.container.textContent, /No colleagues match your search/);
    assert.equal(calls.length, 3);
  } finally { await mounted.close(); }
  assert.ok(calls[0].options.signal.aborted);
});

test("excludes existing member principal IDs, not row IDs, and preserves legacy principals", async () => {
  const props = {
    opportunityId: "opp", request: async () => page([member("existing"), member("row-id"), member("legacy")]),
    onAdd: async () => {},
    items: [{ id: "row-id", principal_kind: "member", principal_id: "existing" }, { id: "old", principal_kind: "tenant_user", principal_id: "legacy" }],
  };
  const mounted = await mount(props);
  try {
    assert.deepEqual([...mounted.container.querySelectorAll("option")].map(option => option.value), ["", "row-id", "legacy"]);
    await choose(mounted.container, "row-id");
    assert.equal(addButton(mounted.container).disabled, false);
    await mounted.render({ ...props, items: [...props.items, { id: "new-row", principal_kind: "member", principal_id: "row-id" }] });
    assert.equal(mounted.container.querySelector("select").value, "");
    assert.ok(addButton(mounted.container).disabled);
  } finally { await mounted.close(); }
});

test("failed later page is an honest error, not a partial/empty list; retry restarts pagination", async () => {
  let fail = true;
  const calls = [];
  const request = async url => {
    calls.push(url);
    if (url.endsWith("offset=0")) return page([member("first")], 100);
    if (fail) throw new Error("Permission denied");
    return page([member("last")]);
  };
  const mounted = await mount({ opportunityId: "opp", request, onAdd: async () => {} });
  try {
    await tick();
    assert.match(mounted.container.querySelector('[role="alert"]').textContent, /Permission denied/);
    assert.equal(mounted.container.querySelector("select"), null);
    assert.ok(addButton(mounted.container).disabled);
    assert.doesNotMatch(mounted.container.textContent, /No colleagues available/);
    fail = false;
    await act(async () => [...mounted.container.querySelectorAll("button")].find(button => button.textContent === "Retry").click());
    await tick();
    assert.equal(calls.length, 4);
    assert.match(calls[2], /offset=0$/);
    assert.equal(mounted.container.querySelectorAll("option").length, 3);
  } finally { await mounted.close(); }
});

test("context change aborts old request, clears selection/search and ignores stale results", async () => {
  let oldResolve;
  let oldSignal;
  const request = async (url, { signal }) => {
    if (url.includes("/old?")) {
      oldSignal = signal;
      return new Promise(resolve => { oldResolve = resolve; });
    }
    return page([member("new-member")]);
  };
  const props = { opportunityId: "old", request, onAdd: async () => {} };
  const mounted = await mount(props);
  try {
    await mounted.render({ ...props, opportunityId: "new" });
    assert.ok(oldSignal.aborted);
    await choose(mounted.container, "new-member");
    await act(async () => oldResolve(page([member("stale")])));
    assert.equal(mounted.container.querySelector("select").value, "new-member");
    assert.doesNotMatch(mounted.container.querySelector("select").textContent, /stale@/);
    await search(mounted.container, "Asha");
    await mounted.render({ ...props, opportunityId: "third" });
    assert.equal(mounted.container.querySelector("input").value, "");
    assert.equal(mounted.container.querySelector("select").value, "");
    assert.ok(addButton(mounted.container).disabled);
  } finally { await mounted.close(); }
});

test("add is pending-disabled, retains selection on failure and clears it after success", async () => {
  let settle;
  const calls = [];
  const props = {
    opportunityId: "opp", request: async () => page([member("colleague")]),
    onAdd: id => { calls.push(id); return new Promise((resolve, reject) => { settle = { resolve, reject }; }); },
  };
  const mounted = await mount(props);
  try {
    await choose(mounted.container, "colleague");
    await act(async () => addButton(mounted.container).click());
    assert.ok(addButton(mounted.container).disabled);
    assert.equal(addButton(mounted.container).textContent, "Adding…");
    await act(async () => settle.reject(new Error("Could not save")));
    assert.match(mounted.container.querySelector('[role="alert"]').textContent, /Could not save/);
    assert.equal(mounted.container.querySelector("select").value, "colleague");
    await act(async () => addButton(mounted.container).click());
    await act(async () => settle.resolve());
    assert.deepEqual(calls, ["colleague", "colleague"]);
    assert.equal(mounted.container.querySelector("select").value, "");
    assert.ok(addButton(mounted.container).disabled);
    assert.match(mounted.container.textContent, /No colleagues available to add/);
  } finally { await mounted.close(); }
});
