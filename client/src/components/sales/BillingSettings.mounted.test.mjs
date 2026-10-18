import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>", { url: "http://localhost/sales/settings" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)("@tanstack/react-query");
after(() => dom.window.close());
const compiled = await build({
  stdin: { contents: `
    export {default as Settings} from "./BillingPresetSettings.jsx";
    export {default as Groups} from "./BundleBillingGroups.jsx";
    export {default as Schedule} from "./BillingSchedule.jsx";
    export {default as QuoteBilling} from "./QuoteBillingSettings.jsx";
    export {default as Invoices} from "./InvoiceSchedulesPanel.jsx";`,
  resolveDir: `${process.cwd()}/client/src/components/sales`, loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` },
  plugins: [{ name: "billing-discovery-fixture", setup(builder) {
    builder.onResolve({ filter: /useSalesSettings$/ }, () => ({ path: "settings", namespace: "fixture" }));
    builder.onResolve({ filter: /base44Client$/ }, () => ({ path: "tenant", namespace: "fixture" }));
    builder.onResolve({ filter: /viewerProtectedWorkGate$/ }, () => ({ path: "gate", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
      contents: path === "tenant" ? "export const getActiveTenantId=()=>null;"
        : path === "gate" ? "export const getViewerProtectedWorkGeneration=()=>0; export const isViewerProtectedWorkPaused=()=>false;"
          : `import {useQuery,useQueryClient} from "@tanstack/react-query";
          export const salesSettingsRequest=(...args)=>globalThis.billingFixture.request(...args);
          export const useSalesSettingsScope=()=>({scopeKey:globalThis.billingFixture.scope,ready:true,tenant:null,generation:0});
          export function useSalesSettings(request=salesSettingsRequest) {
            const fixture=globalThis.billingFixture, qc=useQueryClient(), key=["sales-settings",fixture.scope];
            const query=useQuery({queryKey:key,queryFn:()=>fixture.load(),retry:false,staleTime:Infinity});
            return {...query,ready:query.isSuccess,scopeKey:fixture.scope,data:query.isError?undefined:query.data,lastConfirmedData:query.data,
              patch:patch=>request("/api/sales/settings",{method:"PATCH",body:JSON.stringify(patch)}),
              accept:async value=>{qc.setQueryData(key,value);}};
          }`, loader: "js", resolveDir: process.cwd(),
    }));
  } }],
});
const mod = new Module(`${process.cwd()}/billing-mounted-test.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, `${process.cwd()}/billing-mounted-test.cjs`);
const { Settings, Groups, Schedule, QuoteBilling, Invoices } = mod.exports;
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const settings = () => ({ version: 4, showSku: false, quoteTaskListName: "Production tasks", billingPresets: {
  issueDelays: [{ id: "delay", name: "After a week", days: 7, isActive: true, isDefault: true }],
  paymentTerms: [{ id: "terms", name: "Two weeks", days: 14, isActive: true, isDefault: true }],
} });
async function mounted(element, fixture = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  globalThis.billingFixture = { scope: "tenant-a", load: async () => settings(), request: async () => ({}), ...fixture };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = async value => { await act(async () => { root.render(React.createElement(QueryClientProvider, { client }, value)); await settle(); }); await act(settle); };
  await render(element);
  return { host, client, render, async close() { await act(async () => root.unmount()); client.clear(); host.remove(); } };
}
const button = (host, text) => [...host.querySelectorAll("button")].find(node => node.textContent.includes(text));
async function click(node) { assert.ok(node); await act(async () => { node.click(); await settle(); }); }
async function change(node, value) {
  assert.ok(node);
  await act(async () => {
    Object.getOwnPropertyDescriptor(node.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}

test("mounted presets send a versioned isolated patch; conflicts preserve local changes and unrelated fields", async () => {
  let server = settings(), conflict = true;
  const calls = [];
  const fixture = await mounted(React.createElement(Settings, { canManage: true }), {
    load: async () => server,
    request: async (_path, options) => {
      const patch = JSON.parse(options.body); calls.push(patch);
      if (conflict) { conflict = false; server = { ...server, version: 5, showSku: true }; throw Object.assign(new Error("Stale settings"), { status: 409 }); }
      server = { ...server, ...patch, version: 6 }; return server;
    },
  });
  try {
    await change(fixture.host.querySelector('[aria-label="Invoice issue delays name 1"]'), "After ten days");
    await change(fixture.host.querySelector('[aria-label="Invoice issue delays days 1"]'), "10");
    await act(async () => { fixture.host.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); await settle(); });
    assert.match(fixture.host.textContent, /draft is preserved/);
    assert.equal(fixture.host.querySelector('input').value, "After ten days");
    await act(async () => { fixture.host.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); await settle(); });
    assert.deepEqual(Object.keys(calls[1]).sort(), ["billingPresets", "expectedVersion"]);
    assert.equal(calls[1].expectedVersion, 5);
    assert.equal(calls[1].billingPresets.issueDelays[0].days, 10);
    assert.equal(server.showSku, true);
    assert.equal(server.quoteTaskListName, "Production tasks");
    assert.match(fixture.host.textContent, /Billing presets saved/);
  } finally { await fixture.close(); }
});

test("both preset lists support removing saved defaults and blank drafts, persisting empty lists", async () => {
  let server = settings();
  const calls = [];
  const fixture = await mounted(React.createElement(Settings, { canManage: true }), {
    load: async () => server,
    request: async (_path, options) => {
      const patch = JSON.parse(options.body); calls.push(patch);
      server = { ...server, billingPresets: patch.billingPresets, version: server.version + 1 };
      return server;
    },
  });
  try {
    await click(button(fixture.host, "Add issue delay"));
    await click(fixture.host.querySelector('[aria-label="Remove invoice issue delay 2"]'));
    assert.equal(fixture.host.querySelector('[aria-label="Invoice issue delays name 2"]'), null);
    await click(button(fixture.host, "Add payment terms"));
    await click(fixture.host.querySelector('[aria-label="Remove payment terms 2"]'));
    assert.equal(fixture.host.querySelector('[aria-label="Payment terms name 2"]'), null);
    await click(fixture.host.querySelector('[aria-label="Remove invoice issue delay After a week"]'));
    assert.ok(fixture.host.querySelector('[aria-label="Payment terms name 1"]'));
    await click(fixture.host.querySelector('[aria-label="Remove payment terms Two weeks"]'));
    assert.equal(calls.length, 0, "removal is a draft until explicitly saved");
    assert.equal(fixture.host.querySelectorAll('input').length, 0);
    await act(async () => { fixture.host.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); await settle(); });
    assert.deepEqual(calls, [{ expectedVersion: 4, billingPresets: { issueDelays: [], paymentTerms: [] } }]);
    assert.equal(server.quoteTaskListName, "Production tasks");
    await act(async () => { await fixture.client.invalidateQueries({ queryKey: ["sales-settings", "tenant-a"] }); });
    assert.equal(fixture.host.querySelectorAll('input').length, 0, "removed options stay removed after reload");
    await fixture.render(React.createElement(Settings, { canManage: false }));
    assert.equal(fixture.host.querySelector('[aria-label^="Remove "]'), null);
  } finally { await fixture.close(); }
});

test("preset removal obeys read-only permissions and pending-save state", async () => {
  let finish;
  const fixture = await mounted(React.createElement(Settings, { canManage: false }), {
    request: () => new Promise(resolve => { finish = resolve; }),
  });
  try {
    assert.equal(fixture.host.querySelector('[aria-label^="Remove "]'), null);
    await fixture.render(React.createElement(Settings, { canManage: true }));
    await click(fixture.host.querySelector('[aria-label="Remove invoice issue delay After a week"]'));
    await act(async () => { fixture.host.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); await settle(); });
    const remove = fixture.host.querySelector('[aria-label="Remove payment terms Two weeks"]');
    assert.ok(remove.matches(":disabled"));
    await click(remove);
    assert.ok(fixture.host.querySelector('[aria-label="Payment terms name 1"]'));
    await act(async () => { finish({ ...settings(), version: 5, billingPresets: { issueDelays: [], paymentTerms: settings().billingPresets.paymentTerms } }); await settle(); });
  } finally { await fixture.close(); }
});

test("preset permission denial disables editing; scoped remount discards a previous tenant draft", async () => {
  const fixture = await mounted(React.createElement(Settings, { canManage: true }));
  try {
    await change(fixture.host.querySelector("input"), "Tenant A draft");
    globalThis.billingFixture.scope = "tenant-b";
    globalThis.billingFixture.load = async () => ({ ...settings(), billingPresets: { issueDelays: [], paymentTerms: [] } });
    await fixture.render(React.createElement(Settings, { canManage: false }));
    assert.doesNotMatch(fixture.host.textContent, /Tenant A draft/);
    assert.equal(button(fixture.host, "Save billing presets"), undefined);
    assert.match(fixture.host.textContent, /No presets configured/);
  } finally { await fixture.close(); }
});

test("bundle group removal requires explicit reassignment and transfers products and allocation together", async () => {
  const term = { id: "terms", name: "Two weeks", days: 14 };
  let latest;
  function Harness() {
    const [form, setForm] = React.useState({ currency: "GBP", sellingPriceMinor: "17.31", items: [{ productId: "p1", quantity: 1 }, { productId: "p2", quantity: 1 }], billingGroups: [
      { id: "g1", name: "Travel", productIds: ["p1"], allocatedAmount: "12.05", timing: { kind: "acceptance", days: 0 }, paymentTerms: term },
      { id: "g2", name: "Space", productIds: ["p2"], allocatedAmount: "5.26", timing: { kind: "acceptance", days: 7 }, paymentTerms: term },
    ] });
    latest = form;
    return React.createElement(Groups, { form, products: [{ id: "p1", name: "Train", standardPriceMinor: 811 }, { id: "p2", name: "Stand", standardPriceMinor: 500 }], update: (key, value) => setForm(old => ({ ...old, [key]: value })) });
  }
  const fixture = await mounted(React.createElement(Harness));
  try {
    await click(button(fixture.host, "Remove group"));
    assert.equal(button(fixture.host, "Confirm removal").disabled, true);
    assert.equal(latest.billingGroups.length, 2);
    await change(fixture.host.querySelector('[aria-label="Reassign removed group to"]'), "g2");
    await click(button(fixture.host, "Confirm removal"));
    assert.equal(latest.billingGroups.length, 1);
    assert.deepEqual(latest.billingGroups[0].productIds, ["p2", "p1"]);
    assert.equal(latest.billingGroups[0].allocatedAmount, "17.31");
    assert.equal(latest.items.length, 2);
    assert.equal(latest.billingGroups[0].position, 0);
    await click(button(fixture.host, "Add billing group"));
    assert.equal(latest.billingGroups[1].paymentTerms.id, "terms");
    assert.equal(latest.billingGroups[1].timing.days, 7);
    assert.deepEqual(latest.billingGroups[1].productIds, []);
    const addedId = latest.billingGroups[1].id;
    await change(fixture.host.querySelector('[aria-label="Billing group 2 name"]'), "Deposit");
    await click(fixture.host.querySelector('[aria-label="Move group 2 up"]'));
    assert.equal(latest.billingGroups[0].id, addedId);
    assert.equal(latest.billingGroups[0].name, "Deposit");
    await change(fixture.host.querySelector('[aria-label="Billing group for product 1"]'), addedId);
    assert.deepEqual(latest.billingGroups[0].productIds, ["p1"]);
    assert.deepEqual(latest.billingGroups[1].productIds, ["p2"]);
    await click(button(fixture.host, "Apply suggested allocations"));
    assert.equal(latest.billingGroups[0].allocatedAmount, "10.71");
    assert.equal(latest.billingGroups[1].allocatedAmount, "6.60");
  } finally { await fixture.close(); }
});

test("quote scheduling is opt-in and suggests an active default only for a new remainder selection", async () => {
  let latest;
  function Harness() {
    const [form, setForm] = React.useState({ scheduledBilling: false, remainderPaymentTermsId: "" });
    latest = form; return React.createElement(QuoteBilling, { form, setForm, readOnly: false });
  }
  const fixture = await mounted(React.createElement(Harness));
  try {
    assert.equal(latest.scheduledBilling, false);
    assert.equal(latest.remainderPaymentTermsId, "");
    await click(fixture.host.querySelector('input[type="checkbox"]'));
    assert.equal(latest.remainderPaymentTermsId, "terms");
    await change(fixture.host.querySelector("select"), "");
    assert.equal(latest.remainderPaymentTermsId, "");
    assert.match(fixture.host.textContent, /Choose remainder payment terms/);
    await fixture.render(React.createElement(Harness));
    assert.equal(latest.remainderPaymentTermsId, "", "Re-rendering must not replace a deliberate empty selection");
  } finally { await fixture.close(); }
});

test("schedule display keeps relative timing, exact totals, zero groups and explicit UTC fallback", async () => {
  const fixture = await mounted(React.createElement(Schedule, { schedule: { timezone: "UTC", timezone_fallback: true, groups: [
    { id: "g1", name: "Travel", line_position: 0, contents: [{ name: "Train", quantity: 2 }], timing: { kind: "acceptance", days: 7 }, payment_terms: { name: "Two weeks", days: 14 }, gross_minor: 1731, net_minor: 1442, tax_minor: 289, currency: "GBP" },
    { id: "g2", name: "Included", linePosition: 1, contents: [], timing: { kind: "fixed", date: "2028-04-17" }, paymentTerms: { name: "Immediate", days: 0 }, grossMinor: 0, currency: "GBP" },
  ] } }));
  try {
    assert.match(fixture.host.textContent, /UTC fallback/);
    assert.match(fixture.host.textContent, /7 calendar days after acceptance/);
    assert.match(fixture.host.textContent, /14 calendar days after invoice issue/);
    assert.match(fixture.host.textContent, /2 × Train/);
    assert.match(fixture.host.textContent, /£17.31/);
    assert.match(fixture.host.textContent, /No invoice required/);
  } finally { await fixture.close(); }
});

test("invoice groups load by sale, retry only definite failures, preserve groups on failed refresh and deny unauthorized reads", async () => {
  const calls = [];
  let fail = false;
  const access = { canViewInvoice: true, canRetryInvoice: true };
  const fixture = await mounted(React.createElement(Invoices, { saleId: "sale-a", access }), {
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (options.method === "POST") return { ok: true };
      if (fail) throw new Error("Read unavailable");
      return { schedules: [
        { id: "s1", status: "failed", delivery_status: "pending", last_error: "Tax code missing", planned_issue_date: "2028-04-17", snapshot: { name: "Travel", grossMinor: 1731, currency: "GBP" } },
        { id: "s2", status: "needs_review", delivery_status: "unknown", snapshot: { name: "Exhibition", grossMinor: 2832, currency: "GBP" } },
        { id: "s3", status: "no_invoice_required", snapshot: { name: "Included", grossMinor: 0, currency: "GBP" } },
      ] };
    },
  });
  try {
    assert.equal(calls[0].path, "/api/sales/accounting/sale-a?action=schedules");
    assert.equal(fixture.host.querySelectorAll("ol > li").length, 3);
    assert.equal([...fixture.host.querySelectorAll("button")].filter(node => node.textContent === "Retry this group").length, 1);
    await click(button(fixture.host, "Retry this group"));
    const post = calls.find(call => call.options.method === "POST");
    assert.deepEqual(JSON.parse(post.options.body), { scheduleId: "s1" });
    assert.equal(post.path, "/api/sales/accounting/sale-a?action=retry-schedule");
    fail = true;
    await click(button(fixture.host, "Reload groups"));
    assert.match(fixture.host.textContent, /Read unavailable/);
    assert.equal(fixture.host.querySelectorAll("ol > li").length, 3);
    const previous = calls.length;
    await fixture.render(React.createElement(Invoices, { saleId: "sale-b", access: { canViewInvoice: false } }));
    assert.equal(fixture.host.textContent, "");
    assert.equal(calls.length, previous);
  } finally { await fixture.close(); }
});

test("existing remainder terms survive preset refresh and failed discovery never permits preset edits or defaults", async () => {
  let fail = false, latest;
  function Harness() {
    const [form, setForm] = React.useState({ scheduledBilling: true, remainderPaymentTermsId: "archived-terms" });
    latest = form; return React.createElement(QuoteBilling, { form, setForm, readOnly: false });
  }
  const fixture = await mounted(React.createElement(Harness), { load: async () => {
    if (fail) throw new Error("Presets unavailable");
    return settings();
  } });
  try {
    assert.equal(fixture.host.querySelector("select").value, "archived-terms");
    fail = true;
    await act(async () => { await fixture.client.refetchQueries({ queryKey: ["sales-settings"] }); await settle(); });
    assert.match(fixture.host.textContent, /Payment terms could not be loaded/);
    assert.equal(fixture.host.querySelector("select").disabled, true);
    assert.equal(fixture.host.querySelector('input[type="checkbox"]').disabled, true);
    assert.equal(latest.remainderPaymentTermsId, "archived-terms");
    fail = false;
    await click(button(fixture.host, "Retry payment terms"));
    assert.equal(fixture.host.querySelector("select").disabled, false);
    assert.equal(latest.remainderPaymentTermsId, "archived-terms");
  } finally { await fixture.close(); }
});

test("failed preset discovery blocks adding/defaulting bundle groups and preserves saved selections", async () => {
  let fail = false;
  const group = { id: "g1", name: "Travel", productIds: ["p1"], allocatedAmount: "12.05", timing: { kind: "acceptance", days: 7 }, paymentTerms: { id: "saved", name: "Saved terms", days: 21 }, issueDelayPreset: { id: "saved-delay", name: "Saved delay", days: 7 } };
  const fixture = await mounted(React.createElement(Groups, { form: { currency: "GBP", sellingPriceMinor: "12.05", items: [{ productId: "p1", quantity: 1 }], billingGroups: [group] }, products: [], update: () => assert.fail("No changes expected") }), {
    load: async () => { if (fail) throw new Error("Presets unavailable"); return settings(); },
  });
  try {
    fail = true;
    await act(async () => { await fixture.client.refetchQueries({ queryKey: ["sales-settings"] }); await settle(); });
    assert.equal(button(fixture.host, "Add billing group").disabled, true);
    assert.equal(fixture.host.querySelector('[aria-label="Group 1 payment terms"]').disabled, true);
    assert.equal(fixture.host.querySelector('[aria-label="Group 1 payment terms"]').value, "saved");
    assert.equal(fixture.host.querySelector('[aria-label="Group 1 issue delay"]').value, "saved-delay");
    assert.match(fixture.host.textContent, /Saved selections are preserved/);
  } finally { await fixture.close(); }
});

test("blocked schedule candidates require explicit group-scoped confirmation; payment refresh calls the provider refresh action", async () => {
  const calls = [];
  let confirmed = false, paid = false, failRead = false;
  const candidate = { provider_customer_id: "customer-b", display_name: "Harbour Events", email: "accounts@example.test" };
  const fixture = await mounted(React.createElement(Invoices, { saleId: "sale-a", access: { canViewInvoice: true, canRetryInvoice: true } }), {
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (options.method === "POST") {
        const command = JSON.parse(options.body);
        if (path.endsWith("retry-schedule")) {
          assert.deepEqual(command, { scheduleId: "s1", providerCustomerId: "customer-b", confirmCustomerMatch: true });
          confirmed = true;
        } else if (path.endsWith("refresh-schedule")) {
          assert.deepEqual(command, { scheduleId: "s1" }); paid = true;
        } else assert.fail(`Unexpected operation ${path}`);
        return { ok: true };
      }
      if (failRead) throw new Error("Read unavailable");
      return { schedules: [
        { id: "s1", status: confirmed ? "invoiced" : "blocked", can_retry: !confirmed, delivery_status: "pending", last_error: confirmed ? null : { code: "AMBIGUOUS_CUSTOMER_MATCH", message: "Several customers matched", details: { candidates: [candidate, { providerCustomerId: "customer-c", name: "Harbour Holdings" }] } }, snapshot: { name: "Travel", grossMinor: 1731, currency: "GBP" }, invoice: confirmed ? { id: "invoice-one", number: "INV-137", status: paid ? "paid" : "unpaid" } : null },
        { id: "s2", status: "blocked", can_retry: true, last_error: { code: "AMBIGUOUS_CUSTOMER_MATCH", candidates: [{ id: "other-customer", name: "Another group customer" }] }, snapshot: { name: "Exhibition", grossMinor: 2832, currency: "GBP" } },
      ] };
    },
  });
  try {
    const rows = fixture.host.querySelectorAll("ol > li");
    assert.equal(rows[0].querySelectorAll('input[type="radio"]:checked').length, 0);
    assert.equal(button(rows[0], "Confirm customer").disabled, true);
    assert.equal(button(rows[0], "Retry this group"), undefined);
    await click(rows[0].querySelector('[value="customer-b"]'));
    assert.equal(button(rows[0], "Confirm customer").disabled, false);
    assert.equal(button(rows[1], "Confirm customer").disabled, true, "Selecting a customer must not affect another group");
    await click(button(rows[0], "Confirm customer"));
    assert.equal(calls.filter(call => call.options.method === "POST").length, 1);
    assert.match(fixture.host.textContent, /INV-137/);
    await click(button(fixture.host, "Refresh payment status"));
    assert.equal(calls.filter(call => call.path.endsWith("refresh-schedule")).length, 1);
    assert.match(fixture.host.textContent, /paid/);
    assert.match(fixture.host.textContent, /£17.31/);
    failRead = true;
    await click(button(fixture.host, "Reload groups"));
    assert.equal(button(fixture.host, "Refresh payment status").disabled, true);
    assert.equal(button(fixture.host.querySelectorAll("ol > li")[1], "Confirm customer").disabled, true);
    assert.match(fixture.host.textContent, /INV-137/);
  } finally { await fixture.close(); }
});

test("transient ambiguity exposes candidates from retry response; read-only users cannot confirm or refresh", async () => {
  let posts = 0;
  const fixture = await mounted(React.createElement(Invoices, { saleId: "sale-a", access: { canViewInvoice: true, canRetryInvoice: true } }), {
    request: async (_path, options = {}) => {
      if (options.method === "POST") {
        posts++;
        throw Object.assign(new Error("Choose a customer"), { status: 409, payload: { code: "AMBIGUOUS_CUSTOMER_MATCH", details: { candidates: [{ id: "account-2", name: "Meridian Events" }] } } });
      }
      return { schedules: [{ id: "s1", status: "blocked", can_retry: true, snapshot: { name: "Travel", grossMinor: 1731 } }] };
    },
  });
  try {
    await click(button(fixture.host, "Retry this group"));
    assert.equal(posts, 1);
    assert.match(fixture.host.textContent, /Meridian Events/);
    assert.equal(button(fixture.host, "Confirm customer").disabled, true);
    await click(fixture.host.querySelector('[value="account-2"]'));
    await fixture.render(React.createElement(Invoices, { saleId: "sale-a", access: { canViewInvoice: true, canRetryInvoice: false } }));
    assert.equal(button(fixture.host, "Confirm customer").disabled, true);
    assert.equal(fixture.host.querySelector('fieldset').disabled, true);
    await click(button(fixture.host, "Confirm customer"));
    assert.equal(posts, 1);
  } finally { await fixture.close(); }
});

test("refresh errors remain local to the selected group and never remove previously loaded invoice data", async () => {
  let calls = 0;
  const fixture = await mounted(React.createElement(Invoices, { saleId: "sale-a", access: { canViewInvoice: true, canRetryInvoice: true } }), {
    request: async (_path, options = {}) => {
      if (options.method === "POST") { calls++; throw new Error("Provider unavailable"); }
      return { schedules: ["s1", "s2"].map(id => ({ id, status: "invoiced", can_retry: false, snapshot: { name: id, grossMinor: 1731 }, invoice: { id: `invoice-${id}`, number: `INV-${id}`, status: "unpaid" } })) };
    },
  });
  try {
    const rows = fixture.host.querySelectorAll("ol > li");
    await click(button(rows[0], "Refresh payment status"));
    assert.equal(calls, 1);
    assert.match(rows[0].textContent, /Provider unavailable/);
    assert.doesNotMatch(rows[1].textContent, /Provider unavailable/);
    assert.match(rows[0].textContent, /INV-s1/);
    assert.match(rows[1].textContent, /INV-s2/);
    await fixture.render(React.createElement(Invoices, { saleId: "sale-a", access: { canViewInvoice: true, canRetryInvoice: false } }));
    assert.equal(button(fixture.host, "Refresh payment status"), undefined);
  } finally { await fixture.close(); }
});

test("tenant/session scope changes discard pending customer selection even for the same displayed sale", async () => {
  const props = { saleId: "sale-a", access: { canViewInvoice: true, canRetryInvoice: true } };
  const fixture = await mounted(React.createElement(Invoices, props), {
    request: async () => ({ schedules: [{
      id: "s1", status: "blocked", can_retry: true, snapshot: { name: "Travel", grossMinor: 1731 },
      last_error: { code: "AMBIGUOUS_CUSTOMER_MATCH", candidates: [{ id: "account-2", name: globalThis.billingFixture.scope === "tenant-a" ? "Previous scope customer" : "Current scope customer" }] },
    }] }),
  });
  try {
    await click(fixture.host.querySelector('input[value="account-2"]'));
    assert.equal(button(fixture.host, "Confirm customer").disabled, false);
    globalThis.billingFixture.scope = "tenant-b";
    await fixture.render(React.createElement(Invoices, props));
    assert.equal(fixture.host.querySelectorAll('input[type="radio"]:checked').length, 0);
    assert.equal(button(fixture.host, "Confirm customer").disabled, true);
    assert.match(fixture.host.textContent, /Current scope customer/);
    assert.doesNotMatch(fixture.host.textContent, /Previous scope customer/);
  } finally { await fixture.close(); }
});
