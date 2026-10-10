import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test/CommunicationsManagement" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "CustomEvent", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const h = React.createElement;
async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent" });
  const module = new Module(`${process.cwd()}/bounces-isolated-test.cjs`);
  module.filename = `${process.cwd()}/bounces-isolated-test.cjs`;
  module.paths = Module._nodeModulePaths(process.cwd());
  module._compile(result.outputFiles[0].text, module.filename);
  return module;
}
const reportModule = await load("client/src/components/communications/HardBouncedAddressesReport.jsx");
const Report = reportModule.exports.default;
const Warning = (await load("client/src/components/communications/MemberBounceWarning.jsx")).exports.default;
const { QueryClient, QueryClientProvider } = reportModule.require("@tanstack/react-query");
const { MemoryRouter } = reportModule.require("react-router-dom");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const item = { id: "bounce-17", email: "rita@example.test", last_bounced_at: "2026-05-16T12:14:18Z", first_bounced_at: "2026-05-15T10:22:00Z", reason: "Mailbox does not exist", smtp_code: "550", campaign_name: "Spring briefing", members: [{ id: "member-17", name: "Rita Malik" }], resolved_at: null };
const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
async function waitFor(predicate, label) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await settle(); }
  assert.fail(`Timed out waiting for ${label}`);
}
async function mount(Component, props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next) => act(async () => root.render(h(QueryClientProvider, { client }, h(MemoryRouter, {}, h(Component, next)))));
  await render(props);
  return { container, render, async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}
const click = async (element) => { assert.ok(element); await act(async () => element.click()); };
async function input(element, value) {
  await act(async () => {
    const proto = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("report pagination resets on search, member links work, resolution requires reason and survives provider 409", async () => {
  const calls = [];
  let allowResolve = false;
  let resolved = false;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") {
      if (!allowResolve) return json({ error: "Provider still suppresses address" }, 409);
      resolved = true;
      return json({ ok: true });
    }
    return json({ items: resolved ? [] : [item], total: resolved ? 0 : 57, page: Number(new URL(url, dom.window.location.origin).searchParams.get("page")), pageSize: 50 });
  };
  const view = await mount(Report);
  try {
    await waitFor(() => view.container.querySelector("tbody"), "report rows");
    assert.equal(view.container.querySelector("tbody a").getAttribute("href"), "/members/member-17");
    await click([...view.container.querySelectorAll("button")].find((button) => button.textContent === "Next"));
    await waitFor(() => calls.some(({ url }) => url.includes("page=2")), "second page");
    await waitFor(() => view.container.textContent.includes("Page 2 of"), "page update");
    await input(view.container.querySelector("#bounce-search"), "rita");
    await waitFor(() => calls.some(({ url }) => url.includes("page=1") && url.includes("search=rita")), "search reset");
    await waitFor(() => view.container.querySelector('[aria-label^="Review resuming"]'), "filtered rows");
    await click(view.container.querySelector('[aria-label^="Review resuming"]'));
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent, /does not send emails/);
    const confirm = [...dialog.querySelectorAll("button")].find((button) => button.type === "submit");
    assert.equal(confirm.disabled, true);
    await input(dialog.querySelector("textarea"), "  Provider reviewed  ");
    assert.equal(confirm.disabled, false);
    await click(confirm);
    await waitFor(() => dialog.querySelector('[role="alert"]'), "409 visible");
    assert.match(dialog.querySelector('[role="alert"]').textContent, /administrator must resolve/);
    assert.equal(dialog.querySelector("textarea").value, "  Provider reviewed  ");
    assert.deepEqual(JSON.parse(calls.find(({ options }) => options.method === "POST").options.body), { id: item.id, expectedLastBouncedAt: item.last_bounced_at, reason: "Provider reviewed" });
    allowResolve = true;
    await click(confirm);
    await waitFor(() => !document.querySelector('[role="dialog"]'), "dialog closes");
    await waitFor(() => view.container.textContent.includes("No active hard bounces") || view.container.textContent.includes("No addresses match"), "list refreshed");
    assert.match(view.container.querySelector('[role="status"]').textContent, /No email was sent/);
    assert.ok(calls.every(({ options }) => options.credentials === "include"));
  } finally { await view.cleanup(); }
});

test("member warning disables absent email and does not retain stale badge after saved email edit; errors are visible and retryable", async () => {
  const calls = [];
  let nextResponse = { item };
  let fail = false;
  globalThis.fetch = async (url) => { calls.push(url); return fail ? json({ error: "CRM permission check failed" }, 403) : json(nextResponse); };
  const view = await mount(Warning, { memberId: "member-17", email: "" });
  try {
    await settle();
    assert.equal(calls.length, 0);
    await view.render({ memberId: "member-17", email: item.email });
    await waitFor(() => view.container.querySelector('[data-testid="member-bounce-warning"]'), "badge");
    assert.ok(calls[0].includes("memberId=member-17"));
    await click(view.container.querySelector("button"));
    assert.match(document.querySelector('[role="dialog"]').textContent, /Mailbox does not exist/);
    nextResponse = { item: null };
    await view.render({ memberId: "member-17", email: "new@example.test" });
    assert.equal(view.container.querySelector('[data-testid="member-bounce-warning"]'), null);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await waitFor(() => calls.length === 2, "new-email refetch");
    await settle();
    assert.equal(view.container.textContent, "");
    fail = true;
    await view.render({ memberId: "member-17", email: "third@example.test" });
    await waitFor(() => view.container.querySelector('[role="alert"]'), "visible failure");
    assert.match(view.container.textContent, /Bounce status unavailable/);
    fail = false;
    nextResponse = { item: { ...item, resolved_at: "2026-05-17T10:33:00Z" } };
    await click(view.container.querySelector("button"));
    await waitFor(() => view.container.textContent === "", "retry resolved");
  } finally { await view.cleanup(); }
});

test("inactive report never requests data", async () => {
  let count = 0;
  globalThis.fetch = async () => { count++; return json({ items: [], total: 0 }); };
  const view = await mount(Report, { active: false });
  try { await settle(); assert.equal(count, 0); assert.equal(view.container.textContent, ""); }
  finally { await view.cleanup(); }
});

test("report exposes loading, error with retry, and composed empty state", async () => {
  let release;
  let failing = false;
  globalThis.fetch = async () => {
    if (failing) return json({ error: "Bounce report unavailable" }, 503);
    return new Promise((resolve) => { release = () => resolve(json({ items: [], total: 0, page: 1, pageSize: 50 })); });
  };
  const view = await mount(Report);
  try {
    assert.ok(view.container.querySelector('[aria-label="Loading bounced addresses"]'));
    failing = true;
    await act(async () => release());
    await waitFor(() => view.container.textContent.includes("No active hard bounces"), "empty state");
    await click([...view.container.querySelectorAll("button")].find((button) => button.textContent === "Refresh"));
    await waitFor(() => view.container.querySelector('[role="alert"]'), "report error");
    assert.match(view.container.textContent, /Bounce report unavailable/);
    failing = false;
    await click([...view.container.querySelectorAll("button")].find((button) => button.textContent === "Try again"));
    await act(async () => release());
    await waitFor(() => !view.container.querySelector('[role="alert"]'), "successful retry");
    assert.match(view.container.textContent, /No active hard bounces/);
  } finally { await view.cleanup(); }
});
