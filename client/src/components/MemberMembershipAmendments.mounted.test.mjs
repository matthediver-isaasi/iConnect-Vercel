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
      // Reviewed separately in MembershipChange.mounted.test.mjs.
      builder.onResolve({ filter: /^\.\/Member(?:ChangeRequestReview|CancellationRequests)$/ }, () => ({ path: "request-review", namespace: "review-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "review-fixture" }, () => ({ contents: "export default function Review(){return null;}", loader: "js" }));
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
    if (url.includes("action=cancellation_finances")) return json({ records: [], nextCursor: null });
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
    assert.match(view.container.textContent, /Monthly card, fixed Direct Debit and dynamic Direct Debit amendments are not connected/);
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

test("nested server validation error preserves quote-change recovery", async () => {
  const view = await mount({ post: body => body.action === "preview" ? json(quote()) : json({ error: { message: "Saved tax changed", code: "quote_changed" } }, 409) });
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    await click(button("Save change request"));
    await waitFor(() => view.container.textContent.includes("Saved tax changed"));
    assert.match(view.container.textContent, /rejected quote cannot be reused/);
    assert.equal(document.querySelector("fieldset").disabled, false);
    assert.ok(button("Preview"));
  } finally { await view.cleanup(); }
});

test("unreadable create response retains immutable request and fingerprint on retry", async () => {
  const view = await mount({ post: body => body.action === "preview" ? json(quote()) : new Response("<html>Gateway failure</html>", { status: 502 }) });
  try {
    await waitFor(() => button("Preview"));
    await fill();
    await click(button("Preview"));
    await waitFor(() => button("Save change request"));
    await click(button("Save change request"));
    await waitFor(() => button("Retry save change request"));
    await click(button("Retry save change request"));
    await waitFor(() => button("Retry save change request")?.disabled === false);
    const attempts = view.calls.filter(call => call.payload?.action === "create");
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].payload, attempts[1].payload);
    assert.equal(document.querySelector("fieldset").disabled, true);
    assert.match(view.container.textContent, /No outcome has been confirmed/);
    assert.doesNotMatch(view.container.textContent, /Change request saved/);
  } finally { await view.cleanup(); }
});

// Shapes and capability keys mirror the production settlement contract/service.
// This fixture transport is the only network boundary used by these mounted tests.
const amendmentId = "53b617cc-9f28-4d37-bae3-f653c10e09d7";
function financialFixture(direction = "charge") {
  const data = fixture();
  const sign = direction === "credit" ? -1 : direction === "none" ? 0 : 1;
  const recordedQuote = {
    ...quote().quote, effectiveDate: new Date().toISOString().slice(0, 10), financialDirection: direction,
    delta: { netMinor: sign * 3606, vatMinor: sign * 721, grossMinor: sign * 4327 },
    sourceSnapshot: { ...data.current, commitment_snapshot: { ...data.current.commitment_snapshot, payment_frequency: "upfront" } },
    targetSnapshot: { config: { id: "config-advanced", name: "Professional" }, band: { id: "band-standard", label: "Standard" } },
  };
  if (direction === "credit") {
    [recordedQuote.originalRemaining, recordedQuote.targetRemaining] = [recordedQuote.targetRemaining, recordedQuote.originalRemaining];
  }
  if (direction === "none") recordedQuote.targetRemaining = { ...recordedQuote.originalRemaining };
  data.history = [{
    id: amendmentId, source_record_id: data.current.id, status: sign ? "pending_settlement" : "pending_application",
    settlement_status: "not_started", entitlement_applied: false, quote: recordedQuote,
    idempotency_key: "unchanged-proposal-key",
    request: { expectedQuote: "a".repeat(64), reason: "Qualification verified", effectiveDate: recordedQuote.effectiveDate },
  }];
  data.capabilities = {
    preview: true, create: true, apply: true, invoice: true, refund: true, providerAmendment: false,
    retainedCredit: true, reconcile: true, notifications: true,
    collectionMode: "xero_invoice_verified_payment", refundMode: "xero_bank_reconciled_manual_refund_only",
    automatedCashRefund: false, repeatedAmendments: false,
  };
  data.blockers = ["This purchase already has an amendment proposal. Use its settlement/application history."];
  data.lifecycle = { [amendmentId]: { settlement: null, application: null, notifications: [] } };
  return data;
}
function settlementFixture(choice = "collect", state = "awaiting_payment") {
  return {
    id: "settlement-record", amendment_id: amendmentId, choice, state, actor_id: "finance-operator",
    context: { provider: choice === "none" ? "none" : "xero", reference: `MA:${amendmentId}`, sourceInvoiceId: "original-invoice" },
    evidence: { provider: "xero", verified: true, documentId: "adjustment-document", reference: `MA:${amendmentId}`, paymentUrl: "https://in.xero.com/verified-invoice" },
    updated_at: "2027-01-24T12:34:56Z", next_attempt_at: "2027-01-24T12:44:56Z",
  };
}
function appliedFixture(data) {
  return {
    id: "application-record", amendment_id: amendmentId, source_record_id: data.current.id,
    snapshot: data.history[0].quote, effective_date: data.history[0].quote.effectiveDate,
    expires_on: "2027-04-18", created_at: "2027-01-24T12:36:00Z", applied_by: "finance-operator",
  };
}
const financialPanel = () => document.querySelector(`[data-testid="amendment-lifecycle-${amendmentId}"]`);
async function chooseTreatment(choice) {
  await change(`select[id="amend-treatment-${amendmentId}"]`, choice);
  await click(button("Review settlement"));
  assert.ok(document.querySelector('[aria-label="Confirm financial treatment"]'));
}

test("invoice collection, verified reconciliation, application and notification use actual lifecycle, not immutable proposal flags", async () => {
  const data = financialFixture();
  const originalHistory = structuredClone(data.history);
  const life = data.lifecycle[amendmentId];
  const view = await mount({ data, post: body => {
    if (body.action === "settle") life.settlement = settlementFixture();
    if (body.action === "reconcile") life.settlement = { ...life.settlement, state: "settled", evidence: { ...life.settlement.evidence, kind: "collected", paymentIds: ["payment-verified"] } };
    if (body.action === "apply") {
      life.settlement.state = "applied";
      life.application = appliedFixture(data);
      life.notifications = [{ id: "delivery-applied", kind: "applied", state: "pending" }];
    }
    if (body.action === "notify") life.notifications[0] = { ...life.notifications[0], state: "sent", evidence: { messageId: "confirmed-email" } };
    return json(life);
  } });
  try {
    await waitFor(() => button("Review settlement"));
    assert.equal(button("Review settlement").disabled, true);
    assert.equal(button("Apply verified membership change"), undefined);
    await chooseTreatment("collect");
    await click(button("Cancel settlement review"));
    assert.equal(button("Confirm settlement"), undefined);
    await click(button("Review settlement"));
    assert.equal(view.calls.filter(call => call.payload).length, 0);
    await click(button("Confirm settlement"));
    await waitFor(() => financialPanel().textContent.includes("additional payment is not yet verified"));
    const link = financialPanel().querySelector("a");
    assert.equal(link.textContent, "Open collection invoice");
    assert.equal(link.href, "https://in.xero.com/verified-invoice");
    assert.match(link.rel, /noopener/);
    assert.equal(button("Apply verified membership change"), undefined);
    assert.equal(button("Review settlement"), undefined);
    await click(button("Reconcile provider status"));
    await waitFor(() => button("Apply verified membership change"));
    assert.match(financialPanel().textContent, /Additional invoice payment verified/);
    await click(button("Apply verified membership change"));
    await waitFor(() => financialPanel().textContent.includes("Applied membership history"));
    assert.match(financialPanel().textContent, /Professional · Standard/);
    assert.match(financialPanel().textContent, /finance-operator/);
    assert.match(financialPanel().textContent, /2027-01-24T12:36:00.000Z/);
    assert.equal(button("Apply verified membership change"), undefined);
    await click(button("Retry pending notifications"));
    await waitFor(() => financialPanel().textContent.includes("confirmed-email"));
    assert.equal(button("Retry pending notifications"), undefined);
    assert.deepEqual(data.history, originalHistory);
    assert.match(view.container.textContent, /Proposal: Pending settlement/);
    assert.match(view.container.textContent, /Quote fingerprint: a{64}/);
    assert.match(view.container.textContent, /unchanged-proposal-key/);
    assert.match(document.querySelector('[data-testid="amendment-original"]').textContent, /Associate/);
    const writes = view.calls.filter(call => call.payload).map(call => call.payload);
    assert.deepEqual(writes, [
      { action: "settle", amendmentId, settlementChoice: "collect" },
      { action: "reconcile", amendmentId }, { action: "apply", amendmentId }, { action: "notify", amendmentId },
    ]);
  } finally { await view.cleanup(); }
});

test("retained credit is an explicit irreversible choice, not a refund or inferred payment", async () => {
  const data = financialFixture("credit");
  const life = data.lifecycle[amendmentId];
  const view = await mount({ data, post: () => {
    life.settlement = { ...settlementFixture("credit", "settled"), evidence: { kind: "retained_credit", verified: true, documentId: "credit-note" } };
    return json(life);
  } });
  try {
    await waitFor(() => button("Review settlement"));
    const select = document.querySelector(`#amend-treatment-${amendmentId}`);
    assert.deepEqual([...select.options].map(item => item.value), ["", "credit", "refund"]);
    await chooseTreatment("credit");
    assert.match(financialPanel().textContent, /cannot later be switched to refund/);
    await click(button("Confirm settlement"));
    await waitFor(() => financialPanel().textContent.includes("Retained credit verified"));
    assert.match(financialPanel().textContent, /This is not a cash refund/);
    assert.equal(document.querySelector(`#amend-treatment-${amendmentId}`), null);
    assert.ok(button("Apply verified membership change"));
    assert.equal(view.calls.find(call => call.payload)?.payload.settlementChoice, "credit");
  } finally { await view.cleanup(); }
});

test("manual refund requires bank reconciliation and never claims an automatic cash transfer", async () => {
  const data = financialFixture("credit");
  const life = data.lifecycle[amendmentId];
  const view = await mount({ data, post: body => {
    life.settlement = {
      ...settlementFixture("refund", body.action === "settle" ? "awaiting_payment" : "settled"),
      evidence: body.action === "settle"
        ? { kind: "awaiting_recorded_manual_refund", instruction: "Record and bank-reconcile the cash refund against this credit note in Xero. No automatic cash transfer was made." }
        : { kind: "recorded_manual_refund", paymentIds: ["bank-verified"], retainedCreditMinor: 0 },
    };
    return json(life);
  } });
  try {
    await waitFor(() => button("Review settlement"));
    await chooseTreatment("refund");
    assert.match(financialPanel().textContent, /not a bank transfer/);
    await click(button("Confirm settlement"));
    await waitFor(() => financialPanel().textContent.includes("Awaiting a recorded manual refund"));
    assert.match(financialPanel().textContent, /No automatic cash transfer/);
    assert.match(financialPanel().textContent, new RegExp(`Required Xero refund payment reference: MA:${amendmentId}:refund`));
    assert.equal(financialPanel().querySelector("a"), null);
    assert.equal(button("Apply verified membership change"), undefined);
    await click(button("Reconcile provider status"));
    await waitFor(() => button("Apply verified membership change"));
    assert.match(financialPanel().textContent, /Bank-reconciled manual refund verified/);
    assert.equal(view.calls.filter(call => call.payload?.action === "settle").length, 1);
  } finally { await view.cleanup(); }
});

test("exact zero delta requires a recorded none settlement before application", async () => {
  const data = financialFixture("none");
  const life = data.lifecycle[amendmentId];
  const view = await mount({ data, post: () => {
    life.settlement = { ...settlementFixture("none", "settled"), evidence: { kind: "zero_difference", verified: true } };
    return json(life);
  } });
  try {
    await waitFor(() => button("Review settlement"));
    assert.equal(button("Apply verified membership change"), undefined);
    assert.deepEqual([...document.querySelector(`#amend-treatment-${amendmentId}`).options].map(item => item.value), ["", "none"]);
    await chooseTreatment("none");
    await click(button("Confirm settlement"));
    await waitFor(() => button("Apply verified membership change"));
    assert.match(financialPanel().textContent, /Zero financial difference verified/);
    assert.deepEqual(view.calls.find(call => call.payload).payload, { action: "settle", amendmentId, settlementChoice: "none" });
  } finally { await view.cleanup(); }
});

test("ambiguous money response locks choice and permits only read-only reconciliation, with retryable reconciliation errors", async () => {
  const data = financialFixture("credit");
  const life = data.lifecycle[amendmentId];
  let reconciles = 0;
  const view = await mount({ data, post: body => {
    if (body.action === "settle") {
      life.settlement = { ...settlementFixture("credit", "uncertain"), error_code: "provider_outcome_uncertain" };
      throw new Error("Response lost after reservation");
    }
    if (++reconciles === 1) return json({ error: "Accounting provider temporarily unavailable", code: "accounting_request_failed" }, 502);
    life.settlement.state = "settled";
    life.settlement.evidence = { kind: "retained_credit", verified: true };
    return json(life);
  } });
  try {
    await waitFor(() => button("Review settlement"));
    await chooseTreatment("credit");
    await click(button("Confirm settlement"));
    await waitFor(() => financialPanel().textContent.includes("Response lost after reservation"));
    assert.match(financialPanel().textContent, /outcome is unconfirmed/);
    assert.equal(button("Review settlement"), undefined);
    assert.equal(button("Confirm settlement"), undefined);
    assert.equal(button("Apply verified membership change"), undefined);
    await click(button("Reconcile provider status"));
    await waitFor(() => financialPanel().textContent.includes("accounting_request_failed"));
    await click(button("Reconcile provider status"));
    await waitFor(() => button("Apply verified membership change"));
    assert.equal(view.calls.filter(call => call.payload?.action === "settle").length, 1);
    assert.deepEqual(view.calls.filter(call => call.payload?.action === "reconcile").map(call => call.payload), [
      { action: "reconcile", amendmentId }, { action: "reconcile", amendmentId },
    ]);
  } finally { await view.cleanup(); }
});

test("unresolved settlement error and missing reservation show exact errors, never a success or a new financial attempt", async () => {
  const data = financialFixture();
  const view = await mount({ data, post: body => body.action === "settle"
    ? json({ error: "Accounting provider outcome could not be read.", code: "accounting_request_failed" }, 502)
    : json({ error: "No settlement reservation exists.", code: "settlement_not_started" }, 409) });
  try {
    await waitFor(() => button("Review settlement"));
    await chooseTreatment("collect");
    await click(button("Confirm settlement"));
    await waitFor(() => financialPanel().textContent.includes("accounting_request_failed"));
    assert.equal(button("Apply verified membership change"), undefined);
    assert.equal(button("Review settlement"), undefined);
    await click(button("Reconcile provider status"));
    await waitFor(() => financialPanel().textContent.includes("settlement_not_started"));
    assert.doesNotMatch(financialPanel().textContent, /Applied membership history|Additional invoice payment verified/);
  } finally { await view.cleanup(); }
});

test("application conflicts preserve money evidence and block further application", async () => {
  const data = financialFixture();
  const life = data.lifecycle[amendmentId];
  life.settlement = settlementFixture("collect", "settled");
  const view = await mount({ data, post: () => {
    life.settlement.state = "conflict";
    life.settlement.error_code = "source_changed";
    return json({ error: "Settlement arrived after the membership changed, paused or renewed. Funds remain recorded; entitlement was not applied.", code: "source_changed" }, 409);
  } });
  try {
    await waitFor(() => button("Apply verified membership change"));
    await click(button("Apply verified membership change"));
    await waitFor(() => financialPanel().textContent.includes("source_changed"));
    assert.match(financialPanel().textContent, /Funds remain recorded/);
    assert.match(financialPanel().textContent, /adjustment-document/);
    assert.match(financialPanel().textContent, /Review required/);
    assert.equal(button("Apply verified membership change"), undefined);
    assert.equal(button("Reconcile provider status"), undefined);
    assert.doesNotMatch(financialPanel().textContent, /Applied membership history/);
  } finally { await view.cleanup(); }
});

test("returned capabilities, lifecycle availability, source ownership and exact signs gate every financial treatment", async () => {
  for (const variant of ["capabilities", "missing-life", "source", "monthly", "mixed-tax", "tax-adjustment", "status", "date"]) {
    const data = financialFixture();
    if (variant === "capabilities") data.capabilities = { preview: true, create: true };
    if (variant === "missing-life") delete data.lifecycle;
    if (variant === "source") data.history[0].source_record_id = "previous-purchase";
    if (variant === "monthly") data.history[0].quote.sourceSnapshot.commitment_snapshot.payment_frequency = "monthly";
    if (variant === "mixed-tax") data.history[0].quote.delta = { netMinor: -17, vatMinor: 34, grossMinor: 17 };
    if (variant === "tax-adjustment") data.history[0].quote.financialDirection = "tax_adjustment";
    if (variant === "status") data.history[0].status = "unexpected-status";
    if (variant === "date") data.history[0].quote.effectiveDate = "2001-01-17";
    const view = await mount({ data });
    try {
      await waitFor(() => financialPanel());
      assert.equal(button("Review settlement"), undefined, variant);
      assert.equal(button("Apply verified membership change"), undefined, variant);
      assert.equal(button("Reconcile provider status"), undefined, variant);
      assert.equal(button("Retry pending notifications"), undefined, variant);
      assert.equal(view.calls.filter(call => call.payload).length, 0);
      if (variant === "date") assert.match(financialPanel().textContent, /Initial settlement requires the proposal effective date to be today/);
      assert.match(view.container.textContent, /Monthly card, fixed Direct Debit and dynamic Direct Debit amendments are not connected/);
    } finally { await view.cleanup(); }
  }
  const data = financialFixture("credit");
  data.capabilities.refund = false;
  const view = await mount({ data });
  try {
    await waitFor(() => button("Review settlement"));
    assert.deepEqual([...document.querySelector(`#amend-treatment-${amendmentId}`).options].map(item => item.value), ["", "credit"]);
  } finally { await view.cleanup(); }
});

test("unsafe collection links are not navigable and provider audit evidence remains visible", async () => {
  for (const paymentUrl of ["javascript:alert(1)", "http://unsafe.example.test/pay", "https://user:secret@example.test/pay", "/relative-invoice", null]) {
    const data = financialFixture();
    data.lifecycle[amendmentId].settlement = { ...settlementFixture(), evidence: { documentId: "invoice-exact", paymentUrl } };
    const view = await mount({ data });
    try {
      await waitFor(() => financialPanel());
      assert.equal(financialPanel().querySelector("a"), null);
      assert.match(financialPanel().textContent, /No secure payment link was returned/);
      assert.match(financialPanel().textContent, /invoice-exact|2027-01-24T12:34:56.000Z/);
    } finally { await view.cleanup(); }
  }
});

test("notification sending and uncertain outcomes remain visible without offering unsafe resend", async () => {
  const data = financialFixture();
  data.lifecycle[amendmentId].settlement = settlementFixture("collect", "applied");
  data.lifecycle[amendmentId].application = appliedFixture(data);
  data.lifecycle[amendmentId].notifications = [
    { kind: "settlement", state: "uncertain", evidence: { reason: "delivery_not_confirmed" } },
    { kind: "applied", state: "sending", updated_at: "2027-01-24T12:37:00Z" },
  ];
  const view = await mount({ data });
  try {
    await waitFor(() => financialPanel());
    assert.match(financialPanel().textContent, /Delivery is not confirmed/);
    assert.match(financialPanel().textContent, /delivery not confirmed/);
    assert.equal(button("Retry pending notifications"), undefined);
    assert.equal(button("Apply verified membership change"), undefined);
    assert.equal(view.calls.filter(call => call.payload).length, 0);
  } finally { await view.cleanup(); }
});

test("unconfirmed lifecycle response cannot imply successful collection or application", async () => {
  const data = financialFixture();
  const view = await mount({ data, post: () => json({ success: true }) });
  try {
    await waitFor(() => button("Review settlement"));
    await chooseTreatment("collect");
    await click(button("Confirm settlement"));
    await waitFor(() => financialPanel().textContent.includes("did not confirm the action outcome"));
    assert.equal(button("Review settlement"), undefined);
    assert.ok(button("Reconcile provider status"));
    assert.doesNotMatch(financialPanel().textContent, /Applied membership history|Additional invoice payment verified/);
  } finally { await view.cleanup(); }
});

test("failed application remains retryable with the same amendment identity and never rewrites the quote", async () => {
  const data = financialFixture();
  const life = data.lifecycle[amendmentId];
  life.settlement = settlementFixture("collect", "settled");
  let applies = 0;
  const view = await mount({ data, post: () => {
    if (++applies === 1) throw new Error("Application response unavailable");
    life.application = appliedFixture(data);
    life.settlement.state = "applied";
    return json(life);
  } });
  try {
    await waitFor(() => button("Apply verified membership change"));
    await click(button("Apply verified membership change"));
    await waitFor(() => financialPanel().textContent.includes("Application response unavailable"));
    assert.doesNotMatch(financialPanel().textContent, /Applied membership history/);
    await click(button("Apply verified membership change"));
    await waitFor(() => financialPanel().textContent.includes("Applied membership history"));
    const payloads = view.calls.filter(call => call.payload).map(call => call.payload);
    assert.deepEqual(payloads, [{ action: "apply", amendmentId }, { action: "apply", amendmentId }]);
    assert.equal(data.history[0].request.expectedQuote, "a".repeat(64));
    assert.equal(data.history[0].idempotency_key, "unchanged-proposal-key");
  } finally { await view.cleanup(); }
});

test("notification recipient failure exposes exact error and retries only server-pending delivery", async () => {
  const data = financialFixture();
  const life = data.lifecycle[amendmentId];
  life.settlement = settlementFixture();
  life.notifications = [{ kind: "settlement", state: "pending" }];
  let sends = 0;
  const view = await mount({ data, post: () => {
    if (++sends === 1) return json({ error: "No verified member or original payer email is available for notification.", code: "notification_recipient_missing" }, 422);
    life.notifications[0] = { kind: "settlement", state: "uncertain", evidence: { reason: "delivery_not_confirmed" } };
    return json(life);
  } });
  try {
    await waitFor(() => button("Retry pending notifications"));
    await click(button("Retry pending notifications"));
    await waitFor(() => financialPanel().textContent.includes("notification_recipient_missing"));
    await click(button("Retry pending notifications"));
    await waitFor(() => financialPanel().textContent.includes("delivery not confirmed"));
    assert.equal(button("Retry pending notifications"), undefined);
    assert.match(financialPanel().textContent, /Automatic resend is withheld/);
    assert.deepEqual(view.calls.filter(call => call.payload).map(call => call.payload), [
      { action: "notify", amendmentId }, { action: "notify", amendmentId },
    ]);
  } finally { await view.cleanup(); }
});

test("failed refresh preserves audit history with a stale-data warning and retry restores available actions", async () => {
  const data = financialFixture();
  data.lifecycle[amendmentId].settlement = settlementFixture("collect", "settled");
  let gets = 0;
  const view = await mount({ get: () => ++gets === 2 ? json({ error: "Lifecycle database unavailable" }, 503) : json(data) });
  try {
    await waitFor(() => button("Refresh amendment history")?.disabled === false);
    await click(button("Refresh amendment history"));
    await waitFor(() => button("Retry loading"));
    assert.match(view.container.textContent, /History could not be refreshed/);
    assert.match(view.container.textContent, /latest outcome is not confirmed/);
    assert.match(financialPanel().textContent, /adjustment-document/);
    assert.equal(button("Apply verified membership change"), undefined);
    await click(button("Retry loading"));
    await waitFor(() => button("Apply verified membership change"));
    assert.doesNotMatch(view.container.textContent, /History could not be refreshed/);
    assert.equal(view.calls.filter(call => call.payload).length, 0);
  } finally { await view.cleanup(); }
});

test("double confirmation submits only once and late lifecycle results cannot populate another member", async () => {
  const data = financialFixture();
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const view = await mount({ data, post: () => gate });
  try {
    await waitFor(() => button("Review settlement"));
    await chooseTreatment("collect");
    const confirm = button("Confirm settlement");
    await act(async () => { confirm.click(); confirm.click(); });
    assert.equal(view.calls.filter(call => call.payload?.action === "settle").length, 1);
    assert.ok(button("Submitting settlement…")?.disabled);
    await act(async () => view.render("other-member"));
    await waitFor(() => button("Review settlement"));
    await act(async () => resolve(json({ settlement: settlementFixture("collect", "settled"), application: null, notifications: [] })));
    assert.equal(button("Apply verified membership change"), undefined);
    assert.doesNotMatch(financialPanel().textContent, /Additional invoice payment verified/);
    assert.ok(button("Review settlement"));
  } finally { await view.cleanup(); }
});

test("a settled record grants no application, reconciliation or delivery action without each returned capability", async () => {
  const data = financialFixture();
  data.capabilities = { invoice: true };
  data.lifecycle[amendmentId].settlement = settlementFixture("collect", "settled");
  data.lifecycle[amendmentId].notifications = [{ kind: "settlement", state: "pending" }];
  const view = await mount({ data });
  try {
    await waitFor(() => financialPanel());
    assert.equal(button("Apply verified membership change"), undefined);
    assert.equal(button("Reconcile provider status"), undefined);
    assert.equal(button("Retry pending notifications"), undefined);
    assert.equal(button("Review settlement"), undefined);
  } finally { await view.cleanup(); }
});

test("an applied settlement flag without application evidence is not presented as applied membership", async () => {
  const data = financialFixture();
  data.lifecycle[amendmentId].settlement = settlementFixture("collect", "applied");
  const view = await mount({ data });
  try {
    await waitFor(() => financialPanel());
    assert.match(financialPanel().textContent, /Application not confirmed/);
    assert.match(financialPanel().textContent, /no membership application record was returned/);
    assert.doesNotMatch(financialPanel().textContent, /Applied membership history/);
    assert.equal(button("Apply verified membership change"), undefined);
  } finally { await view.cleanup(); }
});

test("malformed application evidence fails closed instead of rendering a success", async () => {
  const data = financialFixture();
  data.lifecycle[amendmentId].settlement = settlementFixture("collect", "settled");
  const view = await mount({ data, post: () => json({
    settlement: settlementFixture("collect", "applied"), application: { id: "not-enough-evidence" }, notifications: [],
  }) });
  try {
    await waitFor(() => button("Apply verified membership change"));
    await click(button("Apply verified membership change"));
    await waitFor(() => financialPanel().textContent.includes("did not confirm the action outcome"));
    assert.doesNotMatch(financialPanel().textContent, /Applied membership history/);
  } finally { await view.cleanup(); }
});

test("definitive finance evidence rejection can retry only the same amendment and locked treatment after review", async () => {
  const data = financialFixture("credit");
  const life = data.lifecycle[amendmentId];
  let attempts = 0;
  const view = await mount({ data, post: () => {
    if (++attempts === 1) return json({
      error: "Connected settlement currently requires Xero; this accounting provider is unsupported.", code: "finance_evidence_required",
    }, 422);
    life.settlement = { ...settlementFixture("credit", "settled"), evidence: { kind: "retained_credit", verified: true } };
    return json(life);
  } });
  try {
    await waitFor(() => button("Review settlement"));
    await chooseTreatment("credit");
    await click(button("Confirm settlement"));
    await waitFor(() => button("Review settlement retry"));
    assert.match(financialPanel().textContent, /accounting provider is unsupported/);
    assert.match(financialPanel().textContent, /no success is confirmed/);
    assert.equal(document.querySelector(`#amend-treatment-${amendmentId}`).disabled, true);
    assert.equal(document.querySelector(`#amend-treatment-${amendmentId}`).value, "credit");
    assert.equal(button("Apply verified membership change"), undefined);
    assert.equal(view.calls.filter(call => call.payload).length, 1);
    await click(button("Review settlement retry"));
    await click(button("Confirm settlement"));
    await waitFor(() => button("Apply verified membership change"));
    const writes = view.calls.filter(call => call.payload).map(call => call.payload);
    assert.deepEqual(writes, [
      { action: "settle", amendmentId, settlementChoice: "credit" },
      { action: "settle", amendmentId, settlementChoice: "credit" },
    ]);
  } finally { await view.cleanup(); }
});

test("incomplete audit data never invents GBP currency or a flat price band", async () => {
  const data = financialFixture();
  delete data.current.currency;
  delete data.history[0].quote.currency;
  data.history[0].quote.targetSnapshot = { config: { name: "Professional", pricing_model: "tiered" } };
  const view = await mount({ data });
  try {
    await waitFor(() => financialPanel());
    assert.match(view.container.textContent, /43.27 \(currency not supplied\)/);
    assert.match(view.container.textContent, /Target: Professional · Band not supplied/);
    assert.doesNotMatch(view.container.textContent, /£|Professional · Flat price/);
    assert.equal(button("Review settlement"), undefined);
  } finally { await view.cleanup(); }
});
