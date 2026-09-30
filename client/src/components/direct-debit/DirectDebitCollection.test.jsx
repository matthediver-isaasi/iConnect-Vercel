import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://tenant.example.test/DirectDebitAdmin" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter",
  "SVGElement", "MutationObserver", "CustomEvent", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const Collection = (await import("./DirectDebitCollection.jsx")).default;
const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

test("collection UI confirms exact evidence, disables duplicate submission and shows uncertainty without retry", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let refreshed = false, resolveRun;
  queries.invalidateQueries = async () => { refreshed = true; };
  const calls = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.action === "preview_collection") return { ok: true, json: async () => ({
      status: "ready", confirmation: { token: "a".repeat(64), ownerLabel: "Ada Member", mandate: "••••1234",
        amountMinor: 1300, currency: "GBP", dueDate: "2026-10-01", date: "2026-10-05", environment: "live" },
    }) };
    return new Promise(resolve => { resolveRun = resolve; });
  };
  try {
    await act(async () => root.render(<QueryClientProvider client={queries}><Collection plan={{ id: "plan" }} /></QueryClientProvider>));
    await act(async () => document.querySelector('[data-testid="button-live-collection-plan"]').click());
    await tick();
    const text = document.body.textContent;
    for (const expected of ["Ada Member", "••••1234", "GBP 13.00", "2026-10-01", "2026-10-05", "live", "real-money", "NOT a dry run", "tomorrow"]) assert.ok(text.includes(expected), expected);
    const confirm = [...document.querySelectorAll("button")].find(button => button.textContent === "Confirm collection now");
    assert.equal(confirm.disabled, true);
    const reason = document.querySelector("textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(reason, "Reviewed October collection");
      reason.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(confirm.disabled, false);
    await act(async () => { confirm.click(); confirm.click(); });
    assert.equal(calls.filter(call => call.action === "run_collection").length, 1);
    assert.equal(confirm.disabled, true);
    assert.deepEqual(Object.keys(calls[1]).sort(), ["action", "confirmationToken", "confirmed", "planId", "reason"]);
    await act(async () => resolveRun({ ok: true, json: async () => ({ status: "uncertain", reason: "Do not retry. Inspect provider evidence.", errors: [] }) }));
    await tick();
    assert.ok(document.body.textContent.includes("uncertain"));
    assert.ok(document.body.textContent.includes("Do not retry"));
    assert.equal(document.querySelector('[data-testid="button-live-collection-plan"]').disabled, true);
    assert.equal(refreshed, true);
    assert.equal(calls.length, 2);
  } finally {
    await act(async () => root.unmount());
    queries.clear();
    globalThis.fetch = originalFetch;
    container.remove();
  }
});