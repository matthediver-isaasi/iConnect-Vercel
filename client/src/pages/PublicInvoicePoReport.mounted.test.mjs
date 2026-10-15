import { after, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test/PublicInvoicePoReport" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/pages/PublicInvoicePoReport.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  loader: { ".css": "empty" }, logLevel: "silent", jsx: "automatic",
  plugins: [{
    name: "report-fixtures",
    setup(builder) {
      builder.onResolve({ filter: /^@\/hooks\/useMemberAccess$/ }, () => ({ path: "access", namespace: "fixture" }));
      builder.onResolve({ filter: /^@\/lib\/adminFetch$/ }, () => ({ path: "fetch", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
        contents: args.path === "access"
          ? "export function useMemberAccess() { return globalThis.__poFixture.access; }"
          : "export function adminFetch(url, options) { return globalThis.__poFixture.fetch(url, options); }",
        loader: "js",
      }));
    },
  }],
});
const bundled = new Module(`${process.cwd()}/po-report-test.cjs`);
bundled.filename = `${process.cwd()}/po-report-test.cjs`;
bundled.paths = Module._nodeModulePaths(process.cwd());
bundled._compile(bundle.outputFiles[0].text, bundled.filename);
const Page = bundled.exports.default;
const { MemoryRouter } = bundled.require("react-router-dom");
const { QueryClient, QueryClientProvider } = bundled.require("@tanstack/react-query");
const h = React.createElement;
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
async function until(predicate) {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await settle(); }
  assert.fail("Timed out: " + document.body.textContent);
}
const events = [
  { id: "event-private-id", title: "Clinical leadership forum", start_date: "2022-04-09" },
  { id: "complex-private-id", title: "Regional practice congress", start_date: "2027-07-12", isComplex: true },
];
const attendee = { id: "a-1", attendee_first_name: "Maya", attendee_last_name: "Raman", attendee_email: "maya@example.test", attendee_job_title: "Clinical lead", organization_id: "org-1", ticket_class_name: "Delegate", dietary_selections: ["Vegetarian"] };
const report = {
  events, organizations: { "org-1": "Westlake Trust" },
  bookingGroups: [{
    eventId: events[0].id, eventTitle: events[0].title, isPublicInvoicePo: true, groupRef: "PO-BOOKING",
    groupPayment: { purchaseOrderNumber: "ORDER-246" },
    publicInvoicePurchaser: { first_name: "Leila", last_name: "Hassan", email: "leila@example.test", phone: "020 7946 0317" },
    attendees: [attendee],
  }],
  formSubmissions: [{
    id: "sub-1", form_id: "form-1", submitted_by_email: "MAYA@example.test",
    submission_data: { access: ["Step-free access"], consent: false, relationship: "secret-record-id", upload: { file_url: "https://example.test/document.pdf" } },
    form: { title: "Access and preferences", related_event_id: events[0].id, fields: [
      { id: "access", label: "Access requirements" }, { id: "consent", label: "Updates consent" },
      { id: "relationship", label: "Linked organisation", type: "relationship_dropdown" },
      { id: "upload", label: "Supporting document" },
    ] },
  }],
  relationshipLabelsByRecordId: { "secret-record-id": "Westlake Trust" },
};
async function mount({ excluded = false, ready = true, session = true, fetcher } = {}) {
  const calls = [];
  globalThis.__poFixture = {
    access: { isAccessReady: ready, sessionValidated: session, memberInfo: { id: "viewer", tenant_id: "tenant-a" }, isFeatureExcluded: key => excluded && key === "events.public-invoice-po-report" },
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher ? fetcher(url, options) : new Response(JSON.stringify(report)); },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ["/PublicInvoicePoReport"] }, h(QueryClientProvider, { client }, h(Page)))));
  return { calls, async close() { await act(async () => root.unmount()); client.clear(); host.remove(); } };
}
const click = async node => act(async () => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const button = text => [...document.querySelectorAll("button")].find(node => node.textContent === text);
after(() => { delete globalThis.__poFixture; dom.window.close(); });

test("all events load automatically; title-only filter selects a past event and All events clears", async () => {
  const view = await mount();
  try {
    await until(() => document.body.textContent.includes("Leila Hassan"));
    assert.equal(view.calls[0].url, "/api/reports/public-invoice-po");
    assert.equal(view.calls[0].options.credentials, "include");
    assert.ok(!document.body.textContent.includes("event-private-id"));
    const input = document.querySelector('[role="combobox"]');
    await act(async () => { input.focus(); });
    await until(() => document.querySelectorAll('[role="option"]').length === 3);
    await click([...document.querySelectorAll('[role="option"]')].find(node => node.textContent.includes("Clinical leadership")));
    await until(() => view.calls.some(call => call.url.includes("eventId=event-private-id")));
    await click(button("All events"));
    await until(() => view.calls.filter(call => call.url === "/api/reports/public-invoice-po").length === 2);
  } finally { await view.close(); }
});

test("details preserve purchaser, attendee and full linked-form answers without financial actions", async () => {
  const view = await mount();
  try {
    await until(() => document.body.textContent.includes("Leila Hassan"));
    await click([...document.querySelectorAll("button")].find(node => node.textContent.includes("Leila Hassan")));
    await until(() => document.querySelector('[role="dialog"]'));
    const text = document.querySelector('[role="dialog"]').textContent;
    for (const expected of ["020 7946 0317", "Clinical lead", "Vegetarian", "Westlake Trust", "Step-free access", "Updates consent", "No", "https://example.test/document.pdf"]) assert.ok(text.includes(expected), expected);
    assert.ok(!text.includes("secret-record-id"));
    assert.ok(!/Create invoice|Send invoice|Take payment/.test(document.body.textContent));
  } finally { await view.close(); }
});

test("permission denied, unready access and unauthenticated viewers never request report data", async () => {
  for (const options of [{ excluded: true }, { ready: false }, { session: false }]) {
    const view = await mount(options);
    try { await settle(); assert.equal(view.calls.length, 0); } finally { await view.close(); }
  }
});

test("error retries and empty report remains a composed read-only report", async () => {
  let failed = true;
  const view = await mount({ fetcher: async () => failed
    ? new Response("Unavailable", { status: 503 })
    : new Response(JSON.stringify({ events, bookingGroups: [], organizations: {}, formSubmissions: [] })) });
  try {
    await until(() => document.querySelector('[role="alert"]'));
    failed = false; await click(button("Retry"));
    await until(() => document.body.textContent.includes("No public Invoice / PO registrations"));
    assert.equal(view.calls.length, 2);
    assert.ok(document.body.textContent.includes("including past events"));
  } finally { await view.close(); }
});

test("route, portal dropdown and shell navigation use the dedicated permission", () => {
  const routes = readFileSync("client/src/pages/index.jsx", "utf8");
  const menu = readFileSync("client/src/pages/PortalMenuManagement.jsx", "utf8");
  const layout = readFileSync("client/src/pages/Layout.jsx", "utf8");
  assert.match(routes, /path="\/PublicInvoicePoReport" element={<PublicInvoicePoReport/);
  assert.match(menu, /PublicInvoicePoReport: "events.public-invoice-po-report"/);
  assert.match(menu, /value: "PublicInvoicePoReport", label: "Public Invoice \/ PO Registrations"/);
  assert.match(layout, /'PublicInvoicePoReport': 'events.public-invoice-po-report'/);
  assert.match(layout, /adminPages.push\("PublicInvoicePoReport"\)/);
});
