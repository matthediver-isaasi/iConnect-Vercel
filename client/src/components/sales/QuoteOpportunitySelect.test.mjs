import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { applyQuoteOpportunity, clearOpportunityContacts, opportunityContacts, opportunitySearchParams, useQuoteOpportunity } from "./useQuoteOpportunity.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
  Element: dom.window.Element, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  CustomEvent: dom.window.CustomEvent, DocumentFragment: dom.window.DocumentFragment,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const bundlePath = path.resolve(`client/src/components/sales/.quote-opportunity-fixture-${process.pid}.mjs`);
await build({
  entryPoints: ["client/src/components/sales/QuoteOpportunitySelect.jsx"], outfile: bundlePath,
  bundle: true, format: "esm", platform: "node", packages: "external", jsx: "transform",
  alias: { "@": path.resolve("client/src") }, logLevel: "silent",
});
const { default: Selector } = await import(pathToFileURL(bundlePath).href);
after(async () => { dom.window.close(); await unlink(bundlePath); });
const h = React.createElement;
const wait = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const detail = (id, extra = {}) => ({
  id, name: `Opportunity ${id}`, organization_id: `org-${id}`, currency: "EUR",
  organization: { id: `org-${id}`, name: "Westbridge Learning" },
  primaryContact: { id: `person-${id}`, name: "Asha Malik" },
  "contact-roles": [{ id: `role-${id}`, member_id: `person-${id}`, is_primary: true, contact: { id: `person-${id}`, name: "Asha Malik" } }],
  ...extra,
});
async function mount(component) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(h(QueryClientProvider, { client }, component)));
  return async () => { await act(async () => root.unmount()); client.clear(); container.remove(); };
}
function button(label) {
  return [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
}
async function click(label) {
  const target = button(label);
  assert.ok(target, label);
  await act(async () => target.click());
  await wait();
}
async function typeSearch(value) {
  const input = document.querySelector('input[aria-label="Search opportunities"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("detail DTO uses person IDs, enriched primary contact and preserves lines/dates", () => {
  const form = { opportunityId: "old", customerContactId: "old-contact", billingContactId: "old-billing", organizationId: "old-org", lines: [{ description: "Training" }], issueDate: "2026-05-18", validUntil: "2026-06-11", currency: "GBP" };
  const cleared = clearOpportunityContacts(form, "new");
  assert.equal(cleared.customerContactId, "");
  assert.equal(cleared.billingContactId, "");
  assert.equal(cleared.organizationId, "");
  const applied = applyQuoteOpportunity(cleared, detail("new"));
  assert.equal(applied.organizationId, "org-new");
  assert.equal(applied.currency, "EUR");
  assert.equal(applied.customerContactId, "person-new");
  assert.equal(applied.billingContactId, "person-new");
  assert.equal(opportunityContacts(detail("new"))[0].id, "person-new");
  assert.equal(opportunityContacts({ "contact-roles": [{ id: "role-only", member_id: "actual-member", is_primary: true }] })[0].id, "actual-member");
  assert.equal(applied.lines, form.lines);
  assert.equal(applied.issueDate, form.issueDate);
  assert.equal(applied.validUntil, form.validUntil);
  assert.equal(applyQuoteOpportunity(applied, detail("none", { primaryContact: null, "contact-roles": [] })).customerContactId, "");
  assert.equal(opportunitySearchParams("R&D", 2).toString(), "active=true&search=R%26D&page=2&pageSize=25");
});

test("real cmdk/popover supports remote debounce, pagination and keyboard selection", async () => {
  const calls = [], chosen = [];
  const request = async (url) => {
    calls.push(url);
    const params = new URL(url, "https://fixture.invalid").searchParams;
    return { items: [{ id: params.get("page") === "2" ? "b" : "a", name: params.get("page") === "2" ? "Leadership workshop" : "Annual learning", organization: { name: "Westbridge Learning" } }], total: 28, page: Number(params.get("page")), pageSize: 25 };
  };
  const cleanup = await mount(h(Selector, { value: "", request, onChange: (id) => chosen.push(id) }));
  try {
    await click("Opportunity");
    assert.match(document.body.textContent, /Annual learning/);
    assert.equal(button("Previous opportunities").disabled, true);
    await click("Next opportunities");
    assert.match(calls.at(-1), /page=2/);
    assert.match(document.body.textContent, /Leadership workshop/);
    await typeSearch("annual");
    await wait(80);
    assert.equal(calls.length, 2, "typing does not immediately call the server");
    assert.match(document.body.textContent, /Loading opportunities/);
    await wait(260);
    assert.match(calls.at(-1), /search=annual&page=1&pageSize=25/);
    const input = document.querySelector('input[aria-label="Search opportunities"]');
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await wait();
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.deepEqual(chosen, ["a"]);
    assert.equal(button("Opportunity").getAttribute("aria-expanded"), "false");
  } finally { await cleanup(); }
});

test("remote options render error/retry, empty and loading states", async () => {
  let attempts = 0, resolve;
  const request = async () => {
    attempts++;
    if (attempts === 1) throw new Error("Access temporarily unavailable");
    return new Promise((done) => { resolve = done; });
  };
  const cleanup = await mount(h(Selector, { value: "", request, onChange: () => {} }));
  try {
    await click("Opportunity");
    assert.match(document.querySelector('[role="alert"]').textContent, /Access temporarily unavailable/);
    await click("Retry opportunities");
    assert.ok(document.querySelector('[role="status"]'));
    await act(async () => resolve({ items: [], total: 0, page: 1, pageSize: 25 }));
    await wait();
    assert.match(document.body.textContent, /No active opportunities match/);
    assert.equal(button("Next opportunities").disabled, true);
  } finally { await cleanup(); }
});

test("form-bound detail query prevents stale overwrite and gates save readiness until success", async () => {
  const pending = new Map(), calls = [];
  let state, select, retry;
  const request = (url) => {
    calls.push(url);
    return new Promise((resolve, reject) => pending.set(url.split("/").at(-1), { resolve, reject }));
  };
  function Harness() {
    const [form, setForm] = React.useState({ opportunityId: "url-linked", customerContactId: "", billingContactId: "", issueDate: "2026-05-18", lines: [{ description: "Retain me" }] });
    const query = useQuoteOpportunity({ opportunityId: form.opportunityId, isNew: true, setForm, request });
    state = { form, query };
    select = (id) => setForm((old) => clearOpportunityContacts(old, id));
    retry = query.refetch;
    return h("button", { disabled: !query.ready }, "Save");
  }
  const cleanup = await mount(h(Harness));
  try {
    assert.equal(state.query.ready, false);
    assert.deepEqual(calls, ["/api/opportunities/url-linked"]);
    await act(async () => pending.get("url-linked").resolve(detail("url-linked")));
    await wait();
    assert.equal(state.query.ready, true);
    assert.equal(state.form.customerContactId, "person-url-linked");
    await act(async () => select("slow"));
    assert.equal(state.form.customerContactId, "");
    assert.equal(state.form.billingContactId, "");
    assert.equal(state.query.contacts.length, 0);
    assert.equal(button("Save").disabled, true);
    await act(async () => select("fast"));
    await act(async () => pending.get("fast").resolve(detail("fast")));
    await wait();
    await act(async () => pending.get("slow").resolve(detail("slow")));
    await wait();
    assert.equal(state.form.opportunityId, "fast");
    assert.equal(state.form.customerContactId, "person-fast");
    assert.equal(state.form.lines[0].description, "Retain me");
    assert.equal(state.form.issueDate, "2026-05-18");
    await act(async () => select("failed"));
    await act(async () => pending.get("failed").reject(new Error("Not allowed")));
    await wait();
    assert.equal(state.query.ready, false);
    assert.equal(button("Save").disabled, true);
    await act(async () => { retry(); });
    await act(async () => pending.get("failed").resolve(detail("failed")));
    await wait();
    assert.equal(state.query.ready, true);
    assert.equal(state.form.customerContactId, "person-failed");
  } finally { await cleanup(); }
});

test("existing quote detail resolves name without changing saved quote fields", async () => {
  let state;
  function Harness() {
    const [form, setForm] = React.useState({ opportunityId: "historical", currency: "GBP", customerContactId: "saved-person", lines: [] });
    const query = useQuoteOpportunity({ opportunityId: form.opportunityId, isNew: false, setForm, request: async () => detail("historical") });
    state = { form, query };
    return h("p", null, query.data?.name);
  }
  const cleanup = await mount(h(Harness));
  try {
    await wait();
    assert.match(document.body.textContent, /Opportunity historical/);
    assert.equal(state.form.currency, "GBP");
    assert.equal(state.form.customerContactId, "saved-person");
  } finally { await cleanup(); }
});
