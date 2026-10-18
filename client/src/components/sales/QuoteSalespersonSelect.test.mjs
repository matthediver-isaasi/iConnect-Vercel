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
  NodeFilter: dom.window.NodeFilter, HTMLInputElement: dom.window.HTMLInputElement,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  CustomEvent: dom.window.CustomEvent, DocumentFragment: dom.window.DocumentFragment,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundlePath = path.resolve(`client/src/components/sales/.quote-salesperson-fixture-${process.pid}.mjs`);
await build({
  stdin: { contents: 'export { default, loadQuoteSalespeople } from "./client/src/components/sales/QuoteSalespersonSelect.jsx"; export { setActiveTenantId } from "./client/src/api/base44Client.js";', resolveDir: process.cwd(), loader: "js" }, outfile: bundlePath,
  bundle: true, format: "esm", platform: "node", packages: "external", jsx: "transform",
  alias: { "@": path.resolve("client/src") }, logLevel: "silent",
});
const { default: Selector, loadQuoteSalespeople, setActiveTenantId } = await import(pathToFileURL(bundlePath).href);
after(async () => { dom.window.close(); await unlink(bundlePath); });
const h = React.createElement;
const wait = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
async function mount(props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const [value, setValue] = React.useState(props.value || "");
    return h(Selector, { opportunityId: "opportunity", ...props, value, onChange: id => { setValue(id); props.onChange?.(id); } });
  }
  await act(async () => root.render(h(Harness)));
  return async () => { await act(async () => root.unmount()); container.remove(); };
}
async function click(label) {
  const target = [...document.querySelectorAll("button,[cmdk-item]")].find(item => item.getAttribute("aria-label") === label || item.textContent === label);
  assert.ok(target, label);
  await act(async () => target.click());
  await wait();
}
const person = { id: "alex", first_name: "Alex", last_name: "Jones", email: "alex@example.test" };

test("search, select by name, and clear work without raw IDs", async () => {
  const changes = [];
  const cleanup = await mount({ request: async () => ({ items: [person], nextOffset: null }), onChange: id => changes.push(id) });
  try {
    await click("Salesperson");
    const input = document.querySelector('input[aria-label="Search salespeople"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "unmatched");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.match(document.body.textContent, /No matching salespeople/);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "Alex");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click("Alex Jonesalex@example.test");
    assert.deepEqual(changes, ["alex"]);
    assert.match(document.querySelector('[aria-label="Salesperson"]').textContent, /Alex Jones/);
    await click("Salesperson");
    await click("No salesperson");
    assert.deepEqual(changes, ["alex", ""]);
  } finally { await cleanup(); }
});
test("loading, failure, retry and empty retain a saved selection", async () => {
  let reject;
  let calls = 0;
  const changes = [];
  const cleanup = await mount({
    value: "old", snapshot: { id: "old", first_name: "Historical", last_name: "Name" },
    request: () => ++calls === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve({ items: [], nextOffset: null }),
    onChange: id => changes.push(id),
  });
  try {
    await click("Salesperson");
    assert.match(document.body.textContent, /Loading salespeople/);
    await act(async () => reject(new Error("Unavailable")));
    await wait();
    assert.match(document.body.textContent, /Could not load salespeople/);
    await click("Retry salespeople");
    assert.match(document.body.textContent, /No collaborators available/);
    assert.match(document.body.textContent, /Historical Name/);
    assert.deepEqual(changes, []);
  } finally { await cleanup(); }
});
test("read-only historical selection does not discover people", async () => {
  const cleanup = await mount({ value: "old", snapshot: { id: "old", name: "Saved Name" }, disabled: true, request: () => { throw new Error("Unexpected discovery"); } });
  try {
    assert.equal(document.querySelector('[aria-label="Salesperson"]').disabled, true);
    assert.match(document.body.textContent, /Saved Name/);
  } finally { await cleanup(); }
});
test("discovery loads later pages and rejects a failed partial list", async () => {
  const signal = new AbortController().signal;
  const urls = [];
  assert.deepEqual(await loadQuoteSalespeople(async url => {
    urls.push(url);
    return urls.length === 1 ? { items: [person], nextOffset: 100 } : { items: [{ id: "later" }], nextOffset: null };
  }, signal, null, "opportunity"), [person, { id: "later" }]);
  assert.ok(urls.every(url => url.includes("opportunityId=opportunity")));
  assert.match(urls[1], /offset=100/);
  await assert.rejects(loadQuoteSalespeople(async url => {
    if (url.includes("offset=100")) throw new Error("Later page failed");
    return { items: [person], nextOffset: 100 };
  }, signal, null, "opportunity"), /Later page failed/);
});

test("no opportunity means no personnel discovery", async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(await loadQuoteSalespeople(() => { throw new Error("Must not fetch all tenant members"); }, signal, "tenant", null), []);
  const cleanup = await mount({ opportunityId: "", request: () => { throw new Error("Unexpected request"); } });
  try {
    await click("Salesperson");
    assert.match(document.body.textContent, /Select an opportunity first/);
  } finally { await cleanup(); }
});

test("tenant switches discard open results and scope the next request", async () => {
  await act(async () => setActiveTenantId("tenant-a"));
  const scopes = [];
  const cleanup = await mount({ request: async (_url, options) => {
    scopes.push(options.headers["X-Tenant-Id"]);
    return { items: scopes.at(-1) === "tenant-a" ? [person] : [], nextOffset: null };
  } });
  try {
    await click("Salesperson");
    assert.match(document.body.textContent, /Alex Jones/);
    await act(async () => setActiveTenantId("tenant-b"));
    assert.doesNotMatch(document.body.textContent, /Alex Jones/);
    await click("Salesperson");
    assert.match(document.body.textContent, /No collaborators available/);
    assert.deepEqual(scopes, ["tenant-a", "tenant-b"]);
  } finally { await cleanup(); await act(async () => setActiveTenantId(null)); }
});
