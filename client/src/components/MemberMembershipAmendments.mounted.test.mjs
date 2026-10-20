import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Mounted React tests, with all transport replaced before the component loads.
// Run: node scripts/run-isolated-tests.mjs node --test client/src/components/MemberMembershipAmendments.mounted.test.mjs
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/MemberMembershipAmendments.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "isolated-amendment-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\// }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        loader: "js",
        contents: path.endsWith("adminFetch")
          ? "export const adminFetch = (url, options = {}, tenantId) => globalThis.fetch(url, {...options, credentials:'include', headers: {...options.headers, 'X-Tenant-Id':tenantId}});"
          : `import React from "react";
            const wrap = tag => ({children, variant, size, ...props}) => React.createElement(tag, props, children);
            export const Card = wrap("div"), CardHeader = wrap("div"), CardTitle = wrap("h2"), CardContent = wrap("div");
            export const Button = wrap("button"), Badge = wrap("span"), Input = wrap("input"), Label = wrap("label"), Textarea = wrap("textarea");`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/amendment-mounted-isolated.cjs`);
compiled.filename = `${process.cwd()}/amendment-mounted-isolated.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const { QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fixture = () => ({
  current: { id: "commitment-original", payment_status: "paid", commitment_snapshot: { config: { name: "Associate" } }, tier_label: "Standard", term_end_date: "2027-04-17", final_cost: 182.41, vat_amount: 36.48, total_with_vat: 218.89, currency: "GBP" },
  structures: [{ id: "config-advanced", name: "Professional", pricing_model: "tiered", bands: [{ id: "band-standard", label: "Standard" }, { id: "band-reduced", label: "Reduced" }] }],
  history: [],
  capabilities: { preview: true, create: true, apply: false },
  blockers: [],
});
const quote = (grossDelta = 43.27) => ({
  expectedQuote: "a".repeat(64),
  quote: {
    delta: { netMinor: grossDelta ? 3606 : 0, vatMinor: grossDelta ? 721 : 0, grossMinor: Math.round(grossDelta * 100) },
    originalRemaining: { netMinor: 2167, vatMinor: 433, grossMinor: 2600 },
    targetRemaining: { netMinor: 5773, vatMinor: 1154, grossMinor: 6927 },
    proration: { remainingDays: 83, totalDays: 365 }, currency: "GBP", term: { endDate: "2027-04-17" },
  },
  blockers: ["Settlement is not implemented. Entitlements remain unchanged."], canCreate: true,
});
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
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
async function fill() {
  await change('select[id^="amend-config-"]', "config-advanced");
  await change('select[id^="amend-band-"]', "band-standard");
  await change('input[type="date"]', "2027-01-24");
  await change("textarea", "Professional qualification verified");
}
async function mount({ data = fixture(), get, post } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    assert.equal(options.headers["X-Tenant-Id"], "tenant-safe");
    assert.match(url, /^\/api\/membership\/member-amendments/);
    calls.push({ url, payload: options.body ? JSON.parse(options.body) : null });
    return options.method === "POST" ? (post ? post(JSON.parse(options.body)) : json(quote())) : get ? get() : json(data);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (memberId = "member-personal") => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Component, { memberId, tenantId: "tenant-safe" })));
  await act(async () => render());
  return { calls, container, render, async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}

test("loading, empty history, immutable snapshot and scope messaging", async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const view = await mount({ get: () => gate });
  try {
    assert.ok(document.querySelector('[aria-label="Loading membership change requests"]'));
    await act(async () => resolve(json(fixture())));
    await waitFor(() => button("Preview"));
    assert.match(view.container.textContent, /No membership change requests recorded/);
    assert.match(view.container.textContent, /Financial settlement and monthly amendments are not yet enabled/);
    assert.match(document.querySelector('[data-testid="amendment-original"]').textContent, /Read-only/);
    assert.equal(button("Preview").disabled, true);
  } finally { await view.cleanup(); }
});

test("GET failure has an explicit retry, not an empty history success", async () => {
  let count = 0;
  const view = await mount({ get: () => ++count === 1 ? json({ error: "Permission check unavailable" }, 503) : json(fixture()) });
  try {
    await waitFor(() => button("Retry loading"));
    assert.match(view.container.textContent, /Permission check unavailable/);
    assert.doesNotMatch(view.container.textContent, /No membership change requests recorded/);
    await click(button("Retry loading"));
    await waitFor(() => button("Preview"));
  } finally { await view.cleanup(); }
});

test("server preview grants and scope blockers gate the form", async () => {
  for (const data of [
    { ...fixture(), capabilities: { preview: false, create: false } },
    { ...fixture(), blockers: [{ code: "MONTHLY_UNSUPPORTED", message: "Monthly commitments cannot be amended yet." }] },
  ]) {
    const view = await mount({ data });
    try {
      await waitFor(() => view.container.textContent.includes("Preview is unavailable"));
      assert.equal(button("Preview"), undefined);
      assert.equal(view.calls.filter(call => call.payload).length, 0);
    } finally { await view.cleanup(); }
  }
});

test("preview uses explicit target and defer; edits invalidate quote and reset dependent band", async () => {
  const view = await mount();
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    const body = view.calls.find(call => call.payload)?.payload;
    assert.deepEqual(body, { action: "preview", memberId: "member-personal", configId: "config-advanced", bandId: "band-standard", effectiveDate: "2027-01-24", reason: "Professional qualification verified", settlementChoice: "defer" });
    assert.match(document.querySelector('[data-testid="amendment-quote"]').textContent, /£43.27/);
    await change("textarea", "Updated reason");
    assert.equal(document.querySelector('[data-testid="amendment-quote"]'), null);
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    await change('select[id^="amend-config-"]', "");
    assert.equal(document.querySelector('[data-testid="amendment-quote"]'), null);
    assert.equal(document.querySelector('select[id^="amend-band-"]').value, "");
  } finally { await view.cleanup(); }
});

test("save is unavailable without create permission or a server canCreate grant", async () => {
  for (const variant of ["permission", "canCreate"]) {
    const data = fixture();
    if (variant === "permission") data.capabilities.create = false;
    const view = await mount({ data, post: () => json({ ...quote(), canCreate: variant !== "canCreate" }) });
    try {
      await waitFor(() => button("Preview"));
      await fill();
      await click(button("Preview"));
      await waitFor(() => button("Save change request"));
      assert.equal(button("Save change request").disabled, true);
      assert.equal(view.calls.filter(call => call.payload?.action === "create").length, 0);
    } finally { await view.cleanup(); }
  }
});

test("ambiguous create locks inputs and retries the exact same idempotent request; confirmed request is not settlement", async () => {
  let creates = 0;
  const data = fixture();
  const view = await mount({ data, post: body => {
    if (body.action === "preview") return json(quote());
    if (++creates === 1) throw new Error("Connection interrupted");
    const amendment = { id: "amendment-recorded", status: "pending_settlement", request: body, quote: quote().quote, created_at: "2027-01-24T12:00:00Z", settlement_status: "not_started", entitlement_applied: false };
    data.history = [amendment];
    return json({ amendment, replayed: true });
  } });
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    await click(button("Save change request"));
    await waitFor(() => view.container.textContent.includes("save outcome is unconfirmed"));
    assert.equal(document.querySelector("fieldset").disabled, true);
    assert.doesNotMatch(view.container.textContent, /Change request saved/);
    await click(button("Retry save change request"));
    await waitFor(() => view.container.textContent.includes("Change request saved"));
    const payloads = view.calls.filter(call => call.payload?.action === "create").map(call => call.payload);
    assert.equal(payloads.length, 2);
    assert.ok(payloads[0].idempotencyKey);
    assert.equal(payloads[0].expectedQuote, quote().expectedQuote);
    assert.deepEqual(payloads[0], payloads[1]);
    assert.match(view.container.textContent, /Pending settlement — no payment or refund has been processed/);
    assert.match(view.container.textContent, /not a payment receipt/);
    assert.equal(button("Save change request"), undefined);
    assert.ok(view.calls.every(call => !call.payload || ["preview", "create"].includes(call.payload.action)));
  } finally { await view.cleanup(); }
});

test("zero-delta request remains pending application and never offers apply", async () => {
  const data = fixture();
  const view = await mount({ data, post: body => {
    if (body.action === "preview") return json(quote(0));
    const amendment = { id: "zero-change", status: "pending_application", request: body, quote: quote(0).quote, created_at: "2027-01-24T12:00:00Z", settlement_status: "not_started", entitlement_applied: false };
    data.history = [amendment];
    return json({ amendment, replayed: false });
  } });
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    await click(button("Save change request"));
    await waitFor(() => view.container.textContent.includes("Change request saved"));
    assert.match(view.container.textContent, /Pending application — no entitlement has changed/);
    assert.equal(button("Apply"), undefined);
  } finally { await view.cleanup(); }
});

test("late quote for a previous member cannot populate the next member form", async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const view = await mount({ post: () => gate });
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await act(async () => view.render("other-member"));
    await waitFor(() => button("Preview"));
    await act(async () => resolve(json(quote())));
    assert.equal(document.querySelector('[data-testid="amendment-quote"]'), null);
    assert.equal(document.querySelector("textarea").value, "");
  } finally { await view.cleanup(); }
});

test("flat structures explicitly send no band and server blockers without a quote remain visible", async () => {
  const data = fixture();
  data.structures[0].pricing_model = "flat";
  data.structures[0].bands = [];
  const view = await mount({ data, post: () => json({ quote: null, canCreate: false, blockers: ["Only today is supported."] }) });
  try {
    await waitFor(() => button("Preview"));
    await change('select[id^="amend-config-"]', "config-advanced");
    assert.equal(document.querySelector('select[id^="amend-band-"]').disabled, true);
    await change('input[type="date"]', "2027-01-24");
    await change("textarea", "Explicit flat price request");
    await click(button("Preview"));
    await waitFor(() => view.container.textContent.includes("Only today is supported."));
    assert.equal(view.calls.find(call => call.payload)?.payload.bandId, null);
    assert.equal(button("Save change request"), undefined);
    assert.match(view.container.textContent, /no request has been saved/);
  } finally { await view.cleanup(); }
});

test("unconfirmed create response cannot report success; exact request can be retried", async () => {
  const view = await mount({ post: body => json(body.action === "preview" ? quote() : { replayed: false }) });
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    await click(button("Save change request"));
    await waitFor(() => view.container.textContent.includes("did not confirm a saved request"));
    assert.doesNotMatch(view.container.textContent, /Change request saved/);
    assert.ok(button("Retry save change request"));
    assert.equal(document.querySelector("fieldset").disabled, true);
  } finally { await view.cleanup(); }
});

test("preview HTTP error shows retryable feedback without stale quote", async () => {
  const view = await mount({ post: () => json({ error: "Target VAT cannot be resolved" }, 422) });
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await waitFor(() => view.container.textContent.includes("Target VAT cannot be resolved"));
    assert.equal(button("Save change request"), undefined);
    assert.equal(button("Preview").disabled, false);
    assert.equal(document.querySelector("fieldset").disabled, false);
  } finally { await view.cleanup(); }
});

test("persisted amendment history shows request reason, exact recorded amounts and separate audit states", async () => {
  const data = fixture();
  data.history = [{
    id: "saved-history", status: "pending_settlement", source_record_id: "original-purchase", actor_id: "operator-finance",
    created_at: "2027-01-24T12:30:00Z", settlement_status: "not_started", entitlement_applied: false,
    request: { effectiveDate: "2027-01-24", reason: "Changed professional classification" },
    quote: {
      ...quote().quote,
      originalFullTerm: { netMinor: 18241, vatMinor: 3648, grossMinor: 21889 },
      sourceSnapshot: data.current,
      targetSnapshot: { config: { name: "Professional" }, band: { label: "Standard" } },
    },
  }];
  const view = await mount({ data });
  try {
    await waitFor(() => button("Preview"));
    const history = document.querySelector('section[aria-label="Amendment history"]');
    assert.match(history.textContent, /Changed professional classification/);
    assert.match(history.textContent, /Original: Associate/);
    assert.match(history.textContent, /Target: Professional · Standard/);
    assert.match(history.textContent, /£43.27/);
    assert.match(history.textContent, /£218.89/);
    assert.match(history.textContent, /original-purchase/);
    assert.match(history.textContent, /operator-finance/);
    assert.match(history.textContent, /Settlement: Not started/);
    assert.match(history.textContent, /Entitlement application: Not applied/);
    assert.match(history.textContent, /24\/01\/2027/);
  } finally { await view.cleanup(); }
});

test("ineligible unpaid purchases are never presented as paid commitments", async () => {
  const data = fixture();
  data.current.payment_status = "unpaid";
  data.blockers = ["The original purchase must be active and fully paid."];
  const view = await mount({ data });
  try {
    await waitFor(() => view.container.textContent.includes("Preview is unavailable"));
    const record = document.querySelector('[data-testid="amendment-original"]');
    assert.match(record.textContent, /Original purchase record/);
    assert.match(record.textContent, /Recorded payment status: unpaid/);
    assert.doesNotMatch(record.textContent, /Original paid commitment|Original paid gross/);
  } finally { await view.cleanup(); }
});

test("preview without a server-issued fingerprint cannot be saved", async () => {
  const response = quote();
  delete response.expectedQuote;
  const view = await mount({ post: () => json(response) });
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    assert.equal(button("Save change request").disabled, true);
    assert.match(view.container.textContent, /did not supply a quote fingerprint/);
    assert.equal(view.calls.filter(call => call.payload?.action === "create").length, 0);
  } finally { await view.cleanup(); }
});

test("an unrelated 409 does not unlock an ambiguous request or discard its fingerprint", async () => {
  let creates = 0;
  const view = await mount({ post: body => {
    if (body.action === "preview") return json(quote());
    if (++creates === 1) throw new Error("Network response lost");
    return json({ error: "Tenant context mismatch", code: "TENANT_CONTEXT_CHANGED" }, 409);
  } });
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    await click(button("Save change request"));
    await waitFor(() => view.container.textContent.includes("Network response lost"));
    assert.equal(button("Preview"), undefined);
    assert.equal(document.querySelector("fieldset").disabled, true);
    await click(button("Retry save change request"));
    await waitFor(() => view.container.textContent.includes("Tenant context mismatch"));
    assert.equal(document.querySelector("fieldset").disabled, true);
    assert.equal(button("Preview"), undefined);
    const payloads = view.calls.filter(call => call.payload?.action === "create").map(call => call.payload);
    assert.equal(payloads[0].expectedQuote, quote().expectedQuote);
    assert.deepEqual(payloads[0], payloads[1]);
  } finally { await view.cleanup(); }
});

test("definitive quote_changed 409 discards stale preview and requires a new fingerprint and key", async () => {
  let previews = 0;
  let creates = 0;
  const view = await mount({ post: body => {
    if (body.action === "preview") return json({ ...quote(previews ? 61.38 : 43.27), expectedQuote: (++previews === 1 ? "a" : "b").repeat(64) });
    if (++creates === 1) return json({ error: "The quoted purchase, target pricing or term changed. Preview again before confirming.", code: "quote_changed" }, 409);
    return json({ amendment: { id: "fresh-request", status: "pending_settlement", request: body }, replayed: false });
  } });
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    await click(button("Save change request"));
    await waitFor(() => view.container.textContent.includes("rejected quote cannot be reused"));
    assert.equal(document.querySelector('[data-testid="amendment-quote"]'), null);
    assert.equal(button("Save change request"), undefined);
    assert.equal(button("Retry save change request"), undefined);
    assert.equal(document.querySelector("fieldset").disabled, false);
    assert.doesNotMatch(view.container.textContent, /Change request saved/);
    assert.equal(view.calls.filter(call => call.payload?.action === "create").length, 1);
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    assert.match(document.querySelector('[data-testid="amendment-quote"]').textContent, /£61.38/);
    await click(button("Save change request"));
    await waitFor(() => view.container.textContent.includes("Change request saved"));
    const payloads = view.calls.filter(call => call.payload?.action === "create").map(call => call.payload);
    assert.equal(payloads[0].expectedQuote, "a".repeat(64));
    assert.equal(payloads[1].expectedQuote, "b".repeat(64));
    assert.notEqual(payloads[0].idempotencyKey, payloads[1].idempotencyKey);
  } finally { await view.cleanup(); }
});

test("quote_changed after a prior network failure does not clear an unresolved save", async () => {
  let creates = 0;
  const view = await mount({ post: body => {
    if (body.action === "preview") return json(quote());
    if (++creates === 1) throw new Error("Network result unknown");
    return json({ error: "Quote changed", code: "quote_changed" }, 409);
  } });
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    await click(button("Save change request"));
    await waitFor(() => view.container.textContent.includes("Network result unknown"));
    await click(button("Retry save change request"));
    await waitFor(() => view.container.textContent.includes("Quote changed"));
    assert.equal(document.querySelector("fieldset").disabled, true);
    assert.equal(button("Preview"), undefined);
    assert.ok(button("Retry save change request"));
    const payloads = view.calls.filter(call => call.payload?.action === "create").map(call => call.payload);
    assert.deepEqual(payloads[0], payloads[1]);
    assert.match(view.container.textContent, /save outcome is unconfirmed/);
  } finally { await view.cleanup(); }
});
