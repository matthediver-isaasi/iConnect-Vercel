import { after, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  stdin: {
    contents: `export { default as Toolbar } from "./client/src/components/projects/ProjectBoardFilters.jsx";
      export { useProjectBoardFilters } from "./client/src/components/projects/useProjectBoardFilters.js";
      export { default as Calendar } from "./client/src/components/projects/ProjectBoardCalendar.jsx";`,
    resolveDir: process.cwd(), loader: "jsx",
  },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  loader: { ".css": "empty" }, jsx: "automatic", logLevel: "silent",
});
const compiled = new Module(`${process.cwd()}/board-filter-test.cjs`);
compiled.filename = `${process.cwd()}/board-filter-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { Toolbar, Calendar, useProjectBoardFilters } = compiled.exports;
const { QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const h = React.createElement;
const cards = [
  { id: "first", list_id: "list", position: 0, title: "Renewals", project_card_label: [{ label_id: "red" }], project_card_assignee: [{ identity_id: "me" }] },
  { id: "second", list_id: "list", position: 1, title: "Sponsors", is_complete: true },
];
const data = { viewerIdentityId: "me", cards, labels: [{ id: "red", name: "Membership", color: "#765840" }], members: [{ identity_id: "me", first_name: "Asha" }] };
let controller;
function Fixture({ boardId }) {
  controller = useProjectBoardFilters(boardId, data, true);
  return h(React.Fragment, null,
    h(Toolbar, { controller, ...data, totalCount: cards.length }),
    h(Calendar, { cards: controller.filteredCards, labels: data.labels, lists: [{ id: "list", name: "Work" }], onOpenCard: () => {} }),
  );
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function mounted(run) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const render = boardId => act(async () => root.render(h(QueryClientProvider, { client }, h(Fixture, { boardId }))));
  await render("one");
  try { await run({ container, client, render }); }
  finally { await act(async () => root.unmount()); client.clear(); container.remove(); }
}
async function click(element) {
  assert.ok(element, "control exists");
  await act(async () => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
}
const button = text => [...document.querySelectorAll("button")].find(item => item.textContent === text);
async function type(text) {
  await act(async () => {
    const input = document.querySelector('[aria-label="Search cards"]');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, text);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function settle() { await act(async () => { await pause(300); }); await act(async () => { await pause(30); }); }

test("mounted toolbar toggles, multi-selects, clear and board-scoped lifecycle are display-only", async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected request"); };
  await mounted(async ({ container, render }) => {
    assert.equal(controller.filters.hideCompleted, false);
    await click(button("Hide completed"));
    assert.equal(controller.filteredCards.length, 1);
    assert.equal(button("Hide completed").getAttribute("aria-pressed"), "true");
    assert.equal(container.querySelector('[data-testid="calendar-card-second"]'), null);
    const trigger = document.querySelector('[aria-label="Labels"]');
    await act(async () => trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await click(document.querySelector('[role="menuitemcheckbox"]'));
    assert.deepEqual(controller.filters.labels, ["red"]);
    await act(async () => document.querySelector('[role="menu"]').dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.ok(container.querySelector('[aria-label="Remove Membership filter"]'));
    await click(button("Clear Filters"));
    assert.deepEqual(controller.filters, { labels: [], assignees: [], hideCompleted: false, keyword: "" });
    await click(button("Hide completed"));
    await render("two");
    assert.equal(controller.filters.hideCompleted, false);
    assert.equal(controller.filteredCards.length, 2);
    await render("one");
    assert.equal(controller.filters.hideCompleted, false);
    assert.equal(controller.filteredCards.length, 2);
    assert.equal(requests, 0);
    assert.equal(cards[1].is_complete, true);
  });
});

test("mounted assignees combine with labels, completion and keyword without data writes", async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ documents: [{ cardId: "first", text: "Comment: needs membership review" }] }) };
  };
  await mounted(async ({ container }) => {
    const open = async label => {
      await act(async () => document.querySelector(`[aria-label="${label}"]`).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    };
    const select = async text => click([...document.querySelectorAll('[role="menuitemcheckbox"]')].find(item => item.textContent.includes(text)));
    const close = async () => act(async () => document.querySelector('[role="menu"]').dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await open("Assignees");
    await select("Assigned to Me");
    await select("Unassigned");
    await close();
    assert.deepEqual(controller.filters.assignees, ["@me", "@unassigned"]);
    assert.equal(controller.filteredCards.length, 2);
    await open("Labels"); await select("Membership"); await close();
    await click(button("Hide completed"));
    await type("REVIEW"); await settle();
    assert.deepEqual(controller.filteredCards.map(card => card.id), ["first"]);
    assert.ok(container.querySelector('[aria-label="Remove Assigned to Me filter"]'));
    assert.ok(container.querySelector('[aria-label="Remove Unassigned filter"]'));
    assert.equal(requests.length, 1);
    assert.ok(requests.every(request => !request.options.method || request.options.method === "GET"));
    await click(button("Clear Filters"));
    assert.equal(controller.filteredCards.length, 2);
    assert.equal(controller.searchStatus, "idle");
  });
});

test("debounced index is lazy, cached across keywords, child text matches both views, prefix invalidation refreshes", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ documents: [{ cardId: "first", text: "Comment: invoicing question. Activity: sponsor confirmed." }] }) };
  };
  await mounted(async ({ container, client, render }) => {
    assert.equal(calls.length, 0);
    await type("invoice"); await type("invoicing");
    assert.equal(calls.length, 0);
    assert.equal(controller.searchStatus, "loading");
    assert.ok(!container.textContent.includes("No cards match"));
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/projects/boards/one?searchIndex=true");
    assert.equal(calls[0].options.credentials, "include");
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.deepEqual(controller.filteredCards.map(card => card.id), ["first"]);
    assert.ok(container.querySelector('[data-testid="calendar-card-first"]'));
    assert.equal(container.querySelector('[data-testid="calendar-card-second"]'), null);
    await type("confirmed"); await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(controller.filteredCards.map(card => card.id), ["first"]);
    await act(async () => { await client.invalidateQueries({ queryKey: ["project-board", "one"] }); });
    await act(async () => { await pause(30); });
    assert.equal(calls.length, 2);
    await type("absent"); await settle();
    assert.ok(container.textContent.includes("No cards match your filters"));
    await click(button("Clear Filters"));
    assert.equal(controller.filteredCards.length, 2);
    await type("invoicing"); await settle();
    assert.equal(calls.length, 2);
    await render("two");
    await settle();
    assert.equal(controller.filters.keyword, "");
    assert.equal(calls.length, 2);
  });
});

test("search failure is explicit, never shows no-match, and retry restores complete results", async () => {
  let fail = true;
  globalThis.fetch = async () => ({ ok: !fail, json: async () => ({ documents: [{ cardId: "second", text: "Activity: pledge received" }] }) });
  await mounted(async ({ container }) => {
    await type("pledge"); await settle();
    assert.equal(controller.searchStatus, "error");
    assert.ok(container.querySelector('[role="alert"]'));
    assert.ok(!container.textContent.includes("No cards match your filters"));
    assert.equal(controller.filteredCards.length, 2);
    fail = false;
    await click(button("Retry search"));
    await act(async () => { await pause(30); });
    assert.equal(controller.searchStatus, "ready");
    assert.deepEqual(controller.filteredCards.map(card => card.id), ["second"]);
  });
});

test("in-flight index receives abort when board unmounts", async () => {
  let signal;
  globalThis.fetch = (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
  };
  await mounted(async () => { await type("pending"); await settle(); assert.equal(signal.aborted, false); });
  assert.equal(signal.aborted, true);
});
