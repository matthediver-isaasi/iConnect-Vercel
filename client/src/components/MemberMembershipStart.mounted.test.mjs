import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Every transport is replaced before mounting; the isolation runner blocks
// network, databases and child processes. These tests never create real data.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "CustomEvent", "NodeFilter", "HTMLButtonElement", "HTMLFormElement", "sessionStorage"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/MemberMembershipStart.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "isolated-start-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\// }, args => {
        if (args.path === "@/components/ui/dialog") return { path: resolve("client/src/components/ui/dialog.jsx") };
        if (args.path === "@/lib/directDebitConsentSummary") return { path: resolve("client/src/lib/directDebitConsentSummary.js") };
        return { path: args.path, namespace: "fixture" };
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        loader: "js",
        contents: path.endsWith("/utils") ? "export const cn = (...items) => items.filter(Boolean).join(' ');" : path.endsWith("adminFetch")
          ? "export const adminFetch = (url, options = {}, tenantId) => globalThis.fetch(url, {...options, credentials:'include', headers: {...options.headers, 'X-Tenant-Id':tenantId}});"
          : `import React from "react";
            const wrap = tag => ({children, variant, size, ...props}) => React.createElement(tag, props, children);
            export const Card = wrap("div"), CardHeader = wrap("div"), CardTitle = wrap("h2"), CardContent = wrap("div");
            export const Button = wrap("button"), Input = wrap("input"), Label = wrap("label"), Textarea = wrap("textarea");`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/start-mounted-isolated.cjs`);
compiled.filename = `${process.cwd()}/start-mounted-isolated.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const { QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fixture = () => ({
  member: { id: "member-personal" },
  structures: [
    { id: "config-professional", name: "Professional", pricing_model: "tiered", paymentModes: ["invoice", "free"], bands: [{ id: "band-standard", label: "Standard" }, { id: "band-reduced", label: "Reduced" }] },
    { id: "config-flat", name: "Affiliate", pricing_model: "flat", paymentModes: ["invoice", "free"], bands: [] },
  ],
  capabilities: { paymentModes: ["invoice", "free"], paymentLink: false, invoiceAvailable: true }, blockers: [], requests: [],
});
const quote = (paymentMode = "invoice") => ({
  canCreate: true, blockers: [], expectedQuote: "fingerprint-server",
  quote: { configId: "config-professional", bandId: "band-standard", termStart: "2027-01-24", termEnd: "2028-01-23", membershipYear: "2027", annualCost: 182.41, finalCost: paymentMode === "free" ? 0 : 182.41, vatAmount: paymentMode === "free" ? 0 : 36.48, totalWithVat: paymentMode === "free" ? 0 : 218.89, currency: "GBP", tierLabel: "Standard", paymentMode },
});
const created = () => ({
  request: { id: "request-confirmed", status: "completed" },
  record: { id: "record-confirmed", payment_status: "unpaid", total_with_vat: 218.89 },
  accounting_pending: true,
});
const settle = () => act(async () => { await new Promise(done => setTimeout(done, 10)); });
async function waitFor(predicate) {
  for (let i = 0; i < 70; i++) { if (predicate()) return; await settle(); }
  assert.fail("Timed out waiting for mounted UI");
}
const button = label => [...document.querySelectorAll("button")].find(item => item.textContent === label);
const click = async element => { assert.ok(element, "button exists"); assert.equal(element.disabled, false); await act(async () => element.click()); };
async function change(selector, value) {
  const element = document.querySelector(selector);
  assert.ok(element, selector);
  const prototype = element.tagName === "INPUT" ? dom.window.HTMLInputElement.prototype : element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLSelectElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function fill(mode = "invoice", flat = false) {
  await change('select[id^="start-config-"]', flat ? "config-flat" : "config-professional");
  if (!flat) await change('select[id^="start-band-"]', "band-standard");
  await change('input[type="date"]', "2027-01-24");
  await change('select[id^="start-payment-"]', mode);
  await change("textarea", "Membership approved following qualification review");
}
async function preview(mode = "invoice", flat = false) {
  await waitFor(() => button("Preview membership"));
  await fill(mode, flat);
  await click(button("Preview membership"));
  await waitFor(() => button("Review and confirm membership"));
}
async function confirm(retry = false) {
  await click(button(retry ? "Review retry" : "Review and confirm membership"));
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.equal(button(retry ? "Confirm retry" : "Confirm and create membership").disabled, true);
  await click(document.querySelector('input[type="checkbox"]'));
  await click(button(retry ? "Confirm retry" : "Confirm and create membership"));
}
async function mount({ data = fixture(), get, post, preserveStorage = false } = {}) {
  if (!preserveStorage) sessionStorage.clear();
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    assert.ok(["tenant-safe", "tenant-other"].includes(options.headers["X-Tenant-Id"]));
    assert.match(url, /^\/api\/membership\/member-start/);
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, payload, tenantId: options.headers["X-Tenant-Id"] });
    return payload ? post ? post(payload) : json(payload.action === "preview" ? quote(payload.paymentMode) : created()) : get ? get(url) : json(data);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const invalidated = [];
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = options => { invalidated.push(options.queryKey); return invalidate(options); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (memberId = "member-personal", tenantId = "tenant-safe") => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Component, { memberId, tenantId })));
  await act(async () => render());
  return { calls, invalidated, client, container, render, async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}

test("loading skeleton, required inputs, empty structures and unsupported modes are honest", async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const view = await mount({ get: () => gate });
  try {
    assert.ok(document.querySelector('[aria-label="Loading membership start options"]'));
    await act(async () => release(json(fixture())));
    await waitFor(() => button("Preview membership"));
    assert.equal(button("Preview membership").disabled, true);
    assert.match(view.container.textContent, /share the saved authorization link/);
    assert.equal(view.calls.filter(call => call.payload).length, 0);
  } finally { await view.cleanup(); }
  const empty = await mount({ data: { ...fixture(), structures: [] } });
  try {
    await waitFor(() => empty.container.textContent.includes("No eligible individual membership structures"));
    assert.equal(button("Preview membership"), undefined);
    assert.match(empty.container.textContent, /No eligible individual membership structures/);
  } finally { await empty.cleanup(); }
});

test("load errors offer retry without showing a usable form", async () => {
  let count = 0;
  const view = await mount({ get: () => ++count === 1 ? json({ error: "Finance permission unavailable" }, 503) : json(fixture()) });
  try {
    await waitFor(() => button("Retry loading options"));
    assert.match(view.container.textContent, /Finance permission unavailable/);
    assert.equal(button("Preview membership"), undefined);
    await click(button("Retry loading options"));
    await waitFor(() => button("Preview membership"));
  } finally { await view.cleanup(); }
});

test("discovery blockers and absent supported payment modes fail closed", async () => {
  for (const data of [
    { ...fixture(), blockers: ["Existing recurring agreement must be resolved."] },
    { ...fixture(), structures: fixture().structures.map(item => ({ ...item, paymentModes: ["stripe"] })), capabilities: { paymentModes: ["stripe"], paymentLink: true } },
    { ...fixture(), structures: fixture().structures.map(item => ({ ...item, paymentModes: undefined })) },
  ]) {
    const view = await mount({ data });
    try {
      await waitFor(() => view.container.textContent.includes("preview is unavailable"));
      assert.equal(button("Preview membership"), undefined);
      assert.equal(view.calls.filter(call => call.payload).length, 0);
    } finally { await view.cleanup(); }
  }
});

test("preview sends contract fields, displays authoritative decimal totals and invalidates after edits", async () => {
  const view = await mount();
  try {
    await preview();
    assert.deepEqual(view.calls.find(call => call.payload).payload, {
      action: "preview", memberId: "member-personal", configId: "config-professional", bandId: "band-standard", startDate: "2027-01-24", reason: "Membership approved following qualification review", paymentMode: "invoice",
    });
    const text = document.querySelector('[data-testid="member-start-preview"]').textContent;
    assert.match(text, /£218.89/);
    assert.match(text, /£36.48/);
    assert.match(text, /24 Jan 2027/);
    assert.match(text, /23 Jan 2028/);
    assert.equal(view.calls.filter(call => call.payload?.action === "create").length, 0);
    await change('select[id^="start-payment-"]', "free");
    assert.equal(document.querySelector('[data-testid="member-start-preview"]'), null);
    await change('select[id^="start-config-"]', "config-flat");
    assert.equal(document.querySelector('select[id^="start-band-"]').value, "");
    assert.equal(document.querySelector('select[id^="start-band-"]').disabled, true);
  } finally { await view.cleanup(); }
});

test("blocked, malformed, or missing-fingerprint previews cannot create", async () => {
  for (const result of [
    { ...quote(), canCreate: false, blockers: ["Overlapping term"] },
    { ...quote(), expectedQuote: null },
    { ...quote(), quote: null },
    { ...quote(), quote: { ...quote().quote, totalWithVat: null } },
    { ...quote(), quote: { ...quote().quote, paymentMode: "free" } },
    { error: "Invalid server shape" },
  ]) {
    const view = await mount({ post: () => json(result) });
    try {
      await waitFor(() => button("Preview membership"));
      await fill();
      await click(button("Preview membership"));
      await waitFor(() => button("Review and confirm membership") || view.container.textContent.includes("valid preview"));
      if (button("Review and confirm membership")) assert.equal(button("Review and confirm membership").disabled, true);
      assert.equal(view.calls.filter(call => call.payload?.action === "create").length, 0);
    } finally { await view.cleanup(); }
  }
});

test("real accessible dialog requires explicit acknowledgement; cancel creates nothing", async () => {
  const view = await mount();
  try {
    await preview();
    await click(button("Review and confirm membership"));
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog.getAttribute("aria-labelledby"));
    assert.ok(dialog.getAttribute("aria-describedby"));
    assert.match(dialog.textContent, /£218.89/);
    assert.equal(button("Confirm and create membership").disabled, true);
    await click(button("Cancel"));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(view.calls.filter(call => call.payload?.action === "create").length, 0);
  } finally { await view.cleanup(); }
});

test("confirmed invoice creation refreshes history and never claims payment received", async () => {
  const view = await mount();
  try {
    await preview();
    await confirm();
    await waitFor(() => view.container.textContent.includes("Membership record created"));
    const payload = view.calls.find(call => call.payload?.action === "create").payload;
    assert.equal(payload.expectedQuote, "fingerprint-server");
    assert.ok(payload.idempotencyKey.length >= 8);
    assert.equal(payload.paymentMode, "invoice");
    assert.match(view.container.textContent, /Recorded payment status: unpaid/);
    assert.match(view.container.textContent, /Accounting processing is pending/);
    assert.doesNotMatch(view.container.textContent, /Payment received|Payment successful/);
    assert.ok(view.invalidated.some(key => key[0] === "member-membership" && key[1] === "member-personal"));
    assert.equal(sessionStorage.getItem("membership-start:tenant-safe:member-personal"), null);
  } finally { await view.cleanup(); }
});

test("flat zero-value membership sends null band and uses only free mode", async () => {
  const view = await mount({ post: payload => json(payload.action === "preview" ? { ...quote("free"), quote: { ...quote("free").quote, configId: "config-flat", bandId: null } } : { ...created(), record: { id: "free-record", payment_status: "paid", total_with_vat: 0 } }) });
  try {
    await preview("free", true);
    await confirm();
    await waitFor(() => view.container.textContent.includes("Zero-value membership recorded"));
    assert.equal(view.calls.find(call => call.payload?.action === "create").payload.bandId, null);
    assert.equal(view.calls.find(call => call.payload?.action === "create").payload.paymentMode, "free");
  } finally { await view.cleanup(); }
});

test("uncertain response persists exact retry payload through unmount, remount and explicit confirmation", async () => {
  const view = await mount({ post: payload => payload.action === "preview" ? json(quote()) : Promise.reject(new Error("Connection lost")) });
  let original;
  try {
    await preview();
    await confirm();
    await waitFor(() => button("Review retry"));
    original = view.calls.find(call => call.payload?.action === "create").payload;
    assert.deepEqual(JSON.parse(sessionStorage.getItem("membership-start:tenant-safe:member-personal")), original);
    assert.equal(document.querySelector("fieldset").disabled, true);
    assert.equal(view.invalidated.length, 0);
  } finally { await view.cleanup(); }
  const retry = await mount({ preserveStorage: true });
  try {
    await waitFor(() => button("Review retry"));
    assert.equal(retry.calls.filter(call => call.payload).length, 0);
    await click(button("Review retry"));
    assert.match(document.querySelector('[role="dialog"]').textContent, /£218.89/);
    await click(document.querySelector('input[type="checkbox"]'));
    await click(button("Confirm retry"));
    await waitFor(() => retry.container.textContent.includes("Membership record created"));
    assert.deepEqual(retry.calls.find(call => call.payload?.action === "create").payload, original);
  } finally { await retry.cleanup(); }
});

test("unreadable create and HTTP conflicts retain exact key rather than silently starting over", async () => {
  for (const failure of [
    () => new Response("not-json", { status: 200 }),
    () => json({ error: "Request needs reconciliation", code: "REQUEST_IN_PROGRESS" }, 409),
    () => json({ error: { message: "Tenant context changed", code: "TENANT_CONTEXT_CHANGED" } }, 409),
  ]) {
    const view = await mount({ post: payload => payload.action === "preview" ? json(quote()) : failure() });
    try {
      await preview();
      await confirm();
      await waitFor(() => button("Review retry"));
      const first = view.calls.find(call => call.payload?.action === "create").payload;
      await confirm(true);
      await waitFor(() => !button("Submitting membership…"));
      assert.deepEqual(view.calls.filter(call => call.payload?.action === "create").map(call => call.payload), [first, first]);
      assert.equal(view.invalidated.length, 0);
      assert.doesNotMatch(view.container.textContent, /Membership record created/);
    } finally { await view.cleanup(); }
  }
});

test("storage failure prevents the initial financial POST", async () => {
  const view = await mount();
  const original = dom.window.Storage.prototype.setItem;
  try {
    await preview();
    dom.window.Storage.prototype.setItem = () => { throw new Error("Tab storage unavailable"); };
    await confirm();
    await waitFor(() => view.container.textContent.includes("Tab storage unavailable"));
    assert.equal(view.calls.filter(call => call.payload?.action === "create").length, 0);
    assert.equal(view.invalidated.length, 0);
  } finally {
    dom.window.Storage.prototype.setItem = original;
    await view.cleanup();
  }
});

test("rapid repeated confirmation cannot send duplicate POSTs", async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const view = await mount({ post: payload => payload.action === "preview" ? json(quote()) : gate });
  try {
    await preview();
    await click(button("Review and confirm membership"));
    await click(document.querySelector('input[type="checkbox"]'));
    const confirmButton = button("Confirm and create membership");
    await act(async () => { confirmButton.click(); confirmButton.click(); });
    assert.equal(view.calls.filter(call => call.payload?.action === "create").length, 1);
    assert.equal(button("Submitting membership…").disabled, true);
    await act(async () => release(json(created())));
    await waitFor(() => view.container.textContent.includes("Membership record created"));
  } finally { await view.cleanup(); }
});

test("pending, reconciliation and malformed success responses retain the original request", async () => {
  for (const result of [
    { request: { id: "pending-request", status: "pending" }, record: null },
    { ...created(), reconciliation_required: true },
    {},
  ]) {
    const view = await mount({ post: payload => json(payload.action === "preview" ? quote() : result) });
    try {
      await preview();
      await confirm();
      await waitFor(() => button("Review retry"));
      assert.doesNotMatch(view.container.textContent, /Membership record created/);
      assert.equal(view.invalidated.some(key => key[0] === "member-membership"), !!result.record?.id);
      assert.ok(sessionStorage.getItem("membership-start:tenant-safe:member-personal"));
    } finally { await view.cleanup(); }
  }
});

test("pending payment is confirmed creation, never a paid success", async () => {
  const view = await mount({ post: payload => json(payload.action === "preview" ? quote() : { ...created(), request: { id: "request-confirmed", status: "pending_payment" } }) });
  try {
    await preview();
    await confirm();
    await waitFor(() => view.container.textContent.includes("Membership record created"));
    assert.match(view.container.textContent, /Recorded payment status: unpaid/);
    assert.doesNotMatch(view.container.textContent, /Payment successful|Payment received/);
    assert.equal(button("Review retry"), undefined);
    assert.ok(view.invalidated.some(key => key[0] === "member-membership"));
  } finally { await view.cleanup(); }
});

test("saved request recovery remains available despite new-purchase blockers and uses no browser key or new quote", async () => {
  const data = {
    ...fixture(), blockers: ["An existing pending obligation blocks a new purchase."],
    requests: [{ id: "request-confirmed", record_id: "record-confirmed", quote: quote().quote, reason: "Existing immutable request", status: "accounting_pending", payment_status: "unpaid", canResume: true, accounting_pending: true }],
  };
  const view = await mount({ data, post: payload => {
    assert.deepEqual(payload, { action: "resume", memberId: "member-personal", requestId: "request-confirmed" });
    return json({ ...created(), request: { id: "request-confirmed", status: "pending_payment" } });
  } });
  try {
    await waitFor(() => button("Review recovery"));
    assert.equal(button("Preview membership"), undefined);
    assert.equal(view.calls.filter(call => call.payload).length, 0);
    await click(button("Review recovery"));
    assert.match(document.querySelector('[role="dialog"]').textContent, /£218.89/);
    assert.equal(button("Confirm recovery").disabled, true);
    await click(document.querySelector('input[type="checkbox"]'));
    await click(button("Confirm recovery"));
    await waitFor(() => view.container.textContent.includes("Membership record created"));
    assert.equal(view.calls.filter(call => call.payload).length, 1);
    assert.equal(sessionStorage.length, 0);
    assert.ok(view.invalidated.some(key => key[0] === "member-membership"));
  } finally { await view.cleanup(); }
});

test("HTTP 202 saved recovery keeps reconciliation explicit without claiming creation or payment", async () => {
  const data = { ...fixture(), blockers: ["Pending request"], requests: [{ id: "request-pending", canResume: true, status: "reconciliation_required", payment_status: "unpaid", quote: quote().quote, reconciliation_required: true }] };
  const view = await mount({ data, post: () => json({ request: { id: "request-pending", status: "reconciliation_required" }, reconciliation_required: true }, 202) });
  try {
    await waitFor(() => button("Review recovery"));
    await click(button("Review recovery"));
    await click(document.querySelector('input[type="checkbox"]'));
    await click(button("Confirm recovery"));
    await waitFor(() => view.container.textContent.includes("Saved request · reconciliation_required"));
    assert.doesNotMatch(view.container.textContent, /Membership record created|Payment successful/);
    assert.equal(view.invalidated.some(key => key[0] === "member-membership"), false);
    assert.equal(button("Review recovery").disabled, false);
  } finally { await view.cleanup(); }
});

test("invoice queue availability gates creation even if a preview grants canCreate", async () => {
  const view = await mount({ data: { ...fixture(), capabilities: { ...fixture().capabilities, invoiceAvailable: false } } });
  try {
    await waitFor(() => button("Preview membership"));
    await fill();
    assert.match(view.container.textContent, /durable membership accounting queue is not enabled/);
    assert.equal(document.querySelector('option[value="invoice"]').disabled, true);
    assert.equal(button("Preview membership").disabled, true);
    assert.equal(view.calls.filter(call => call.payload?.action === "create").length, 0);
  } finally { await view.cleanup(); }
});

test("structure and band options override global modes, expose unavailable reasons and clear invalid selections", async () => {
  const data = fixture();
  data.capabilities.paymentModes = ["invoice", "free"];
  data.structures[0].paymentOptions = [
    { mode: "stripe_upfront", available: true, reason: null },
    { mode: "stripe_monthly", available: true, reason: null },
    { mode: "direct_debit", available: false, reason: "Provider is not connected" },
  ];
  data.structures[0].bands[1].paymentOptions = [{ mode: "free", available: true, reason: null }];
  data.structures[1].paymentOptions = [{ mode: "invoice", available: true, reason: null }];
  const view = await mount({ data });
  try {
    await waitFor(() => button("Preview membership"));
    await fill("stripe_upfront");
    assert.equal(button("Preview membership").disabled, false);
    assert.equal(document.querySelector('option[value="invoice"]'), null);
    assert.equal(document.querySelector('option[value="direct_debit"]').disabled, true);
    assert.match(view.container.textContent, /Provider is not connected/);
    await change('select[id^="start-band-"]', "band-reduced");
    assert.equal(document.querySelector('select[id^="start-payment-"]').value, "");
    assert.equal(document.querySelector('option[value="stripe_upfront"]'), null);
    await change('select[id^="start-payment-"]', "free");
    await change('select[id^="start-config-"]', "config-flat");
    assert.equal(document.querySelector('select[id^="start-payment-"]').value, "");
    assert.equal(button("Preview membership").disabled, true);
  } finally { await view.cleanup(); }
});

test("monthly preview uses only authoritative server offer and refuses missing terms", async () => {
  for (const offer of [null, { monthlyAmount: 19.73, instalmentCount: 7, planTotal: 138.11, currency: "GBP", activationRule: "first_payment" }]) {
    const data = fixture();
    data.structures[0].paymentOptions = [{ mode: "stripe_monthly", available: true }];
    const view = await mount({ data, post: () => json({ ...quote("stripe_monthly"), quote: { ...quote("stripe_monthly").quote, paymentOffer: offer } }) });
    try {
      await preview("stripe_monthly");
      assert.equal(button("Review and confirm membership").disabled, !offer);
      if (offer) {
        assert.match(view.container.textContent, /7 monthly payments of £19.73/);
        assert.match(view.container.textContent, /Plan total: £138.11/);
        assert.match(view.container.textContent, /Activation rule: first_payment/);
      } else assert.match(view.container.textContent, /not supplied complete monthly payment terms/);
    } finally { await view.cleanup(); }
  }
});

test("dynamic Direct Debit accepts the server offer without a fictional count or guaranteed total", async () => {
  const data = fixture();
  data.structures[0].paymentOptions = [{ mode: "direct_debit", available: true }];
  const paymentOffer = {
    monthlyAmount: 19.73, instalmentCount: null, planTotal: null, currency: "GBP",
    activationRule: "first_payment", firstCollectionRule: "anniversary",
    collectionPolicy: { end_policy: "continue", pricing_policy: "dynamic" },
  };
  const view = await mount({ data, post: payload => json(payload.action === "preview" ? {
    ...quote("direct_debit"),
    quote: { ...quote("direct_debit").quote, finalCost: null, vatAmount: null, totalWithVat: null, paymentOffer },
  } : { request: { id: "dynamic-request", status: "awaiting_member_authorization", paymentMode: "direct_debit", paymentUrl: "/membership-fees/dynamic-token" } }) });
  try {
    await preview("direct_debit");
    const previewText = document.querySelector('[data-testid="member-start-preview"]').textContent;
    assert.equal(button("Review and confirm membership").disabled, false);
    assert.match(previewText, /Current monthly price \(variable\): £19.73/);
    assert.match(previewText, /No guaranteed plan total or fixed instalment count/);
    assert.match(previewText, /Collections continue at the end of the billing period/);
    assert.match(previewText, /Each monthly collection uses the current active membership structure price/);
    assert.doesNotMatch(previewText, /Plan total:|12 monthly|£0.00|payments of/);
    await confirm();
    await waitFor(() => view.container.textContent.includes("Membership request saved"));
    assert.equal(view.calls.find(call => call.payload?.action === "create").payload.paymentMode, "direct_debit");
    assert.match(view.container.textContent, /Dynamic collections follow the saved policy/);
    assert.doesNotMatch(view.container.textContent, /later structure changes do not re-price/);
  } finally { await view.cleanup(); }
});

test("late preview cannot restore a quote after payment selection changes", async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const view = await mount({ post: () => gate });
  try {
    await waitFor(() => button("Preview membership"));
    await fill();
    await click(button("Preview membership"));
    await change('select[id^="start-payment-"]', "free");
    await act(async () => release(json(quote())));
    await waitFor(() => button("Preview membership"));
    assert.equal(document.querySelector('[data-testid="member-start-preview"]'), null);
    assert.equal(document.querySelector("fieldset").disabled, false);
    assert.equal(document.querySelector('select[id^="start-payment-"]').value, "free");
  } finally { await view.cleanup(); }
});

test("authorization request without a record resolves retained attempt and shows stable open/copy link, recovered on reload", async () => {
  const request = { id: "request-authorize", status: "awaiting_member_authorization", paymentMode: "stripe_upfront", paymentUrl: "/membership-fees/saved-token" };
  const data = fixture();
  data.structures[0].paymentOptions = [{ mode: "stripe_upfront", available: true }];
  let copied;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { copied = value; } } });
  const view = await mount({ data, post: payload => json(payload.action === "preview" ? quote("stripe_upfront") : { request, paymentUrl: request.paymentUrl }) });
  try {
    await preview("stripe_upfront");
    await confirm();
    await waitFor(() => button("Copy member authorization link"));
    assert.equal(document.querySelector('a').getAttribute("href"), request.paymentUrl);
    assert.match(view.container.textContent, /Awaiting member authorization — no payment is confirmed/);
    assert.match(view.container.textContent, /immutable authority/);
    assert.doesNotMatch(view.container.textContent, /Membership record created|Payment received|Payment successful/);
    assert.equal(button("Review retry"), undefined);
    assert.equal(sessionStorage.getItem("membership-start:tenant-safe:member-personal"), null);
    await click(button("Copy member authorization link"));
    assert.equal(copied, `https://isolated.example.test${request.paymentUrl}`);
  } finally { await view.cleanup(); }
  const reloaded = await mount({ data: { ...data, requests: [request] } });
  try {
    await waitFor(() => button("Copy member authorization link"));
    assert.equal(document.querySelector('a').getAttribute("href"), request.paymentUrl);
    assert.equal(reloaded.calls.filter(call => call.payload).length, 0);
    assert.match(reloaded.container.textContent, /Awaiting member authorization/);
  } finally { await reloaded.cleanup(); }
});

test("tenant/member switch resets the form and ignores late creation result", async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const view = await mount({ post: payload => payload.action === "preview" ? json(quote()) : gate });
  try {
    await preview();
    await confirm();
    await act(async () => view.render("other-member", "tenant-other"));
    await waitFor(() => button("Preview membership"));
    await act(async () => release(json(created())));
    await settle();
    assert.equal(document.querySelector("textarea").value, "");
    assert.doesNotMatch(view.container.textContent, /Membership record created/);
    assert.equal(view.invalidated.length, 0);
    assert.ok(view.client.getQueryData(["member-start", "tenant-other", "other-member"]));
    assert.ok(sessionStorage.getItem("membership-start:tenant-safe:member-personal"));
  } finally { await view.cleanup(); }
});
