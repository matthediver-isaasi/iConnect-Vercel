import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://tenant.example.test/report" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "DocumentFragment", "Event", "CustomEvent", "MouseEvent", "NodeFilter", "MutationObserver", "Node"]) globalThis[key] = dom.window[key];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = (await import("react")).default;
const React = globalThis.React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/events/PublicInvoicePoRegistrations.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs",
  jsx: "automatic", logLevel: "silent",
  plugins: [{
    name: "billing-fixture",
    setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/adminFetch$/ }, () => ({ path: "fetch", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: "export function adminFetch(url, options) { return globalThis.__billingFetch(url, options); }", loader: "js",
      }));
    },
  }],
});
const bundled = new Module(`${process.cwd()}/billing-test.cjs`);
bundled.filename = `${process.cwd()}/billing-test.cjs`;
bundled.paths = Module._nodeModulePaths(process.cwd());
bundled._compile(bundle.outputFiles[0].text, bundled.filename);
const Registrations = bundled.exports.default;
const { QueryClient, QueryClientProvider } = bundled.require("@tanstack/react-query");
const h = React.createElement;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
async function until(predicate) {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await settle(); }
  assert.fail("Timed out: " + document.body.textContent);
}
const button = text => [...document.querySelectorAll("button")].find(node => node.textContent === text);
const click = async node => { assert.ok(node, "button exists"); await act(async () => node.click()); };
const group = {
  eventId: "event-a", eventTitle: "Annual Assembly", bookingSource: "complex_event_booking",
  isPublicInvoicePo: true, groupRef: "group-a", groupPayment: { purchaseOrderNumber: "PO-731" },
  publicInvoicePurchaser: { first_name: "Leila", last_name: "Hassan", email: "booker@example.test" },
  attendees: [
    { id: "booking-a", attendee_first_name: "Maya", attendee_email: "maya@example.test", linked_member_id: "member-a" },
    { id: "booking-b", attendee_first_name: "Ravi", attendee_email: "ravi@example.test" },
  ],
};
const initial = {
  booker: group.publicInvoicePurchaser, member: { id: "booker-member" }, amount: 173.42, currency: "GBP",
  lines: [{ description: "Two delegates", amount: 173.42, taxType: "OUTPUT2", taxPercentage: 20 }],
  fingerprint: "booking-fingerprint", canGenerate: true, reason: null, invoice: null,
};
async function mount({ payload = initial, permitted = true, fetcher } = {}) {
  const calls = [], targets = [];
  globalThis.__billingFetch = async (url, options) => {
    calls.push({ url, options });
    return fetcher ? fetcher(url, options) : json(payload);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let allGroups = [group];
  const render = async () => act(async () => root.render(h(QueryClientProvider, { client },
    h(Registrations, {
      // The report filter hides Ravi, but details and invoice still cover both.
      groups: [{ ...group, attendees: [group.attendees[0]] }], allGroups, tenantId: "tenant-a", viewerId: "viewer-a",
      canCreateGuestMember: permitted, onCreateMember: target => targets.push(target),
    }))));
  await render();
  return {
    calls, targets, client,
    async refresh() { allGroups = [{ ...group, attendees: group.attendees.map(row => ({ ...row })) }]; await render(); },
    async open() {
      await click([...document.querySelectorAll("button")].find(node => node.textContent.includes("Leila Hassan")));
      await click(button("Manage invoice"));
      await until(() => calls.length && !document.body.textContent.includes("Loading invoice details"));
    },
    async close() { await act(async () => root.unmount()); client.clear(); host.remove(); },
  };
}
after(() => { delete globalThis.__billingFetch; dom.window.close(); });

test("billing loads only on demand and keeps original booker distinct from filtered attendees", async () => {
  const view = await mount({ payload: { ...initial, member: null, canGenerate: false } });
  try {
    assert.equal(view.calls.length, 0);
    await view.open();
    assert.equal(view.calls.length, 1);
    const request = view.calls[0];
    const url = new URL(request.url, "https://tenant.example.test");
    assert.equal(url.pathname, "/api/admin/public-invoice-po-billing");
    assert.equal(url.searchParams.get("bookingId"), "booking-a");
    assert.equal(url.searchParams.get("isComplex"), "true");
    assert.equal(request.options.credentials, "include");
    assert.ok(document.body.textContent.includes("Ravi"));
    assert.ok(document.body.textContent.includes("booker@example.test"));
    assert.ok(document.body.textContent.includes("VAT: 20% (included in the price)"));
    assert.ok(!document.body.textContent.includes("OUTPUT2"));
    assert.ok(!button("Generate invoice"));
    assert.equal(document.querySelectorAll("button").length > 0, true);
    await click(button("Create member"));
    await click(button("Create booker account"));
    assert.deepEqual(view.targets, [
      { bookingId: "booking-b", isComplex: true, identity: "attendee" },
      { bookingId: "booking-a", isComplex: true, identity: "purchaser" },
    ]);
    await view.refresh();
    assert.ok(button("Hide invoice"), "report refresh preserves billing panel");
  } finally { await view.close(); }
});

test("explicit confirmation posts whole-booking identity and fingerprint, then prevents duplicate generation", async () => {
  let generated = false;
  const view = await mount({ fetcher: async (_url, options) => {
    if (options.method === "POST") generated = true;
    return json(generated ? { ...initial, canGenerate: false, invoice: { id: "invoice-a", number: "INV-731", provider: "xero", status: "queued" } } : initial);
  } });
  try {
    view.client.setQueryDefaults(["event-registration-report"], { gcTime: Infinity });
    view.client.setQueryDefaults(["public-invoice-po-report"], { gcTime: Infinity });
    view.client.setQueryData(["event-registration-report", "fixture"], {});
    view.client.setQueryData(["public-invoice-po-report", "fixture"], {});
    await view.open();
    await click(button("Generate invoice"));
    assert.equal(view.calls.filter(call => call.options.method === "POST").length, 0);
    assert.ok(document.body.textContent.includes("No payment will be recorded and no automated email will be sent"));
    await click(button("Cancel"));
    assert.equal(view.calls.filter(call => call.options.method === "POST").length, 0);
    await click(button("Generate invoice"));
    await click(button("Confirm generate invoice"));
    await until(() => document.body.textContent.includes("INV-731"));
    assert.deepEqual(JSON.parse(view.calls.find(call => call.options.method === "POST").options.body),
      { bookingId: "booking-a", isComplex: true, fingerprint: "booking-fingerprint" });
    assert.ok(document.body.textContent.includes("Invoice queued"));
    assert.ok(!button("Generate invoice"));
    assert.equal(view.client.getQueryState(["event-registration-report", "fixture"]).isInvalidated, true);
    assert.equal(view.client.getQueryState(["public-invoice-po-report", "fixture"]).isInvalidated, true);
  } finally { await view.close(); }
});

test("review reasons and existing invoice status suppress generation; member permission hides account actions", async () => {
  for (const payload of [
    { ...initial, status: "needs_review", reason: "Tax mapping requires review" },
    { ...initial, invoice: { id: "invoice-a", number: "INV-731", status: "draft" } },
    { ...initial, member: null },
  ]) {
    const view = await mount({ payload, permitted: false });
    try {
      await view.open();
      assert.ok(!button("Generate invoice"));
      assert.ok(!button("Create booker account"));
      assert.ok(!button("Create member"));
      if (payload.reason) assert.ok(document.body.textContent.includes(payload.reason));
      if (payload.invoice) assert.ok(document.body.textContent.includes("Status: draft"));
    } finally { await view.close(); }
  }
});

test("failed load offers retry, and a failed POST never retries automatically", async () => {
  let loadFailed = true;
  const view = await mount({ fetcher: async (_url, options) => {
    if (options.method === "POST") return json({ error: "Booking changed. Review the refreshed amount." }, 409);
    return loadFailed ? json({ error: "Temporarily unavailable" }, 503) : json(initial);
  } });
  try {
    await view.open();
    assert.ok(document.body.textContent.includes("Temporarily unavailable"));
    loadFailed = false;
    await click(button("Retry invoice details"));
    await until(() => button("Generate invoice"));
    await click(button("Generate invoice"));
    await click(button("Confirm generate invoice"));
    await until(() => document.body.textContent.includes("Booking changed"));
    assert.equal(view.calls.filter(call => call.options.method === "POST").length, 1);
  } finally { await view.close(); }
});

test("booker creation refreshes billing in place without creating an attendee link or generating an invoice", async () => {
  let hasBooker = false;
  const view = await mount({ fetcher: async () => json({ ...initial, member: hasBooker ? initial.member : null, canGenerate: hasBooker }) });
  try {
    await view.open();
    await click(button("Create booker account"));
    assert.equal(view.targets[0].identity, "purchaser");
    hasBooker = true;
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ["public-invoice-po-billing"] });
    });
    await view.refresh();
    await until(() => button("Generate invoice"));
    assert.ok(button("Hide invoice"));
    assert.ok(button("Create member"), "unlinked attendee remains distinct from original booker");
    assert.ok(!button("Create booker account"));
    assert.equal(view.calls.filter(call => call.options.method === "POST").length, 0);
  } finally { await view.close(); }
});

test("VAT labels use the configured rate, not an inferred provider code", async () => {
  const view = await mount({ fetcher: async () => json({ ...initial, lines: [
    { description: "Reduced", amount: 105, taxType: "REDUCED", taxPercentage: 5 },
    { description: "Zero", amount: 100, taxType: "ZERO", taxPercentage: 0 },
    { description: "Missing", amount: 100, taxType: "OUTPUT2", taxPercentage: null },
  ] }) });
  try {
    await view.open();
    await until(() => document.body.textContent.includes("VAT: 5% (included in the price)"));
    assert.ok(document.body.textContent.includes("VAT: 0% (no VAT charged)"));
    assert.ok(document.body.textContent.includes("VAT: rate unavailable"));
    assert.ok(!document.body.textContent.includes("OUTPUT2"));
    assert.equal(view.calls.filter(call => call.options.method === "POST").length, 0);
  } finally { await view.close(); }
});
