import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// No provider SDKs, database or network are used. All transports are fixtures.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test/membership-fees/saved-token" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/pages/MembershipFeePage.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "isolated-fee-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^react-router-dom$/ }, () => ({ path: "router", namespace: "fixture" }));
      builder.onResolve({ filter: /^@\// }, args => args.path.endsWith("directDebitConsentSummary")
        ? { path: resolve("client/src/lib/directDebitConsentSummary.js") }
        : { path: args.path, namespace: "fixture" });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        loader: "js",
        contents: path === "router" ? 'export const useParams = () => ({token:"saved-token"});'
          : path.includes("GoCardlessDropinFlow") ? 'export default function Dropin(){ return null; }'
            : `import React from "react";
              const wrap = tag => ({children, variant, size, ...props}) => React.createElement(tag, props, children);
              export const Card = wrap("div"), CardContent = wrap("div"), Badge = wrap("span"), Separator = wrap("hr");
              export const Button = wrap("button"), Input = wrap("input"), Label = wrap("label");`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/fee-mounted-isolated.cjs`);
compiled.filename = `${process.cwd()}/fee-mounted-isolated.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const offer = () => ({
  monthlyAmount: 19.73, instalmentCount: 7, planTotal: 138.11, currency: "GBP", activationRule: "first_payment",
  firstCollectionRule: "anniversary", collectionPolicy: { end_policy: "stop", pricing_policy: "fixed" },
});
const fixture = mode => ({
  isMember: true, memberName: "Test Member", membershipYear: "2027", tierLabel: "Standard",
  currency: "GBP", finalCost: 138.11, totalWithVat: 138.11, status: "pending",
  // Deliberately expose every legacy capability: saved authority must win.
  stripeEnabled: true, stripePublishableKey: "test-not-a-real-key", cardMonthlyEnabled: true, ddEnabled: true, poAvailable: true,
  cardMonthly: offer(), ddOffer: offer(),
  memberStart: mode == null ? null : { paymentMode: mode, requestId: "saved-request", termStart: "2027-02-01", termEnd: "2028-01-31" },
});
const settle = () => act(async () => { await new Promise(done => setTimeout(done, 5)); });
async function waitFor(predicate) {
  for (let i = 0; i < 60; i++) { if (predicate()) return; await settle(); }
  assert.fail("Timed out waiting for fee page");
}
const byId = id => document.querySelector(`[data-testid="${id}"]`);
async function mount(data, search = "", transport) {
  dom.window.history.replaceState({}, "", `/membership-fees/saved-token${search}`);
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(url, "/api/public/membership-fees/saved-token");
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push(payload);
    if (transport) return transport(payload);
    return new Response(JSON.stringify(payload ? {} : data), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Component)));
  await waitFor(() => container.textContent.includes("Membership Fee") || container.textContent.includes("Payment Complete"));
  return { calls, container, async cleanup() { await act(async () => root.unmount()); container.remove(); } };
}

const choiceFixture = () => {
  const data = fixture("member_choice");
  data.memberStart.paymentOptions = ["stripe_upfront", "stripe_monthly", "direct_debit"].map(mode => ({
    mode, available: true, quote: { paymentMode: mode, currency: "GBP", totalWithVat: 138.11, paymentOffer: mode === "stripe_upfront" ? null : offer() },
  }));
  return data;
};
test("member choice offers only saved methods and does not start a provider before confirmation", async () => {
  const data = choiceFixture();
  data.memberStart.paymentOptions = data.memberStart.paymentOptions.filter(option => option.mode !== "direct_debit");
  const view = await mount(data);
  try {
    assert.ok(byId("choose-stripe_upfront"));
    assert.ok(byId("choose-stripe_monthly"));
    assert.equal(byId("choose-direct_debit"), null);
    for (const id of ["button-pay-now", "button-setup-monthly-card", "button-setup-direct-debit", "button-submit-po"]) assert.equal(byId(id), null);
    assert.match(view.container.textContent, /See payment options below/);
    assert.match(view.container.textContent, /7 monthly payments of £19.73/);
    assert.equal(view.calls.filter(Boolean).length, 0);
  } finally { await view.cleanup(); }
});
test("member confirms a choice once then sees only the server-selected provider flow", async () => {
  let selected = false;
  let release;
  const gate = new Promise(done => { release = done; });
  const data = choiceFixture();
  const view = await mount(data, "", async payload => {
    if (payload) { await gate; selected = true; }
    return new Response(JSON.stringify(payload ? { success: true } : selected ? fixture("direct_debit") : data), { status: 200 });
  });
  try {
    await act(async () => byId("choose-direct_debit").click());
    assert.equal(byId("choose-stripe_upfront").disabled, true);
    assert.equal(byId("choose-direct_debit").disabled, true);
    await act(async () => release());
    await waitFor(() => byId("button-setup-direct-debit"));
    assert.deepEqual(view.calls.filter(Boolean), [{ action: "select_payment_method", paymentMode: "direct_debit" }]);
    assert.equal(byId("member-payment-choice"), null);
    assert.equal(byId("button-pay-now"), null);
    assert.equal(byId("button-setup-monthly-card"), null);
  } finally { await view.cleanup(); }
});
test("unavailable or incomplete choices cannot be selected, and conflicts do not unlock providers", async () => {
  const data = choiceFixture();
  data.memberStart.paymentOptions[0].available = false;
  data.memberStart.paymentOptions[0].reason = "Provider temporarily unavailable";
  data.memberStart.paymentOptions[1].quote.paymentOffer = null;
  const view = await mount(data, "", payload => new Response(JSON.stringify(payload ? { error: "A method has already been selected. Reload to continue." } : data), { status: payload ? 409 : 200 }));
  try {
    assert.equal(byId("choose-stripe_upfront").disabled, true);
    assert.equal(byId("choose-stripe_monthly").disabled, true);
    await act(async () => byId("choose-direct_debit").click());
    await waitFor(() => view.container.textContent.includes("No payment has been confirmed."));
    assert.equal(byId("button-setup-direct-debit"), null);
    assert.match(view.container.textContent, /already been selected/);
  } finally { await view.cleanup(); }
});

test("saved member-start payment mode is the only offered rail, regardless of legacy capability flags", async () => {
  const ids = { stripe_upfront: "button-pay-now", stripe_monthly: "button-setup-monthly-card", direct_debit: "button-setup-direct-debit", invoice: "button-submit-po" };
  for (const mode of [...Object.keys(ids), "free", "unknown"]) {
    const view = await mount(fixture(mode));
    try {
      for (const [rail, id] of Object.entries(ids)) assert.equal(!!byId(id), rail === mode, `${mode}: ${rail}`);
      assert.match(byId("member-start-payment-authority").textContent, /No alternative payment method is offered/);
      assert.match(view.container.textContent, /2027-02-01 to 2028-01-31/);
      assert.equal(view.calls.filter(Boolean).length, 0);
      if (mode === "invoice") assert.match(view.container.textContent, /invoice remains outstanding/);
      if (mode === "free") assert.match(view.container.textContent, /No payment authorization is required/);
    } finally { await view.cleanup(); }
  }
});

test("legacy public fee flows retain all existing payment options", async () => {
  const view = await mount(fixture(null));
  try {
    for (const id of ["button-pay-now", "button-setup-monthly-card", "button-setup-direct-debit", "button-submit-po"]) assert.ok(byId(id), id);
    assert.equal(byId("member-start-payment-authority"), null);
  } finally { await view.cleanup(); }
});

test("saved monthly offer displays server counts and totals and fails closed without complete terms", async () => {
  for (const mode of ["stripe_monthly", "direct_debit"]) {
    const data = fixture(mode);
    const view = await mount(data);
    try {
      assert.match(view.container.textContent, /7 monthly (?:card )?payments of £19.73/);
      assert.match(view.container.textContent, /138.11/);
      assert.match(view.container.textContent, /Activation rule: first_payment/);
      assert.doesNotMatch(view.container.textContent, /12 monthly/);
    } finally { await view.cleanup(); }
    const incomplete = await mount({ ...data, cardMonthly: null, ddOffer: null });
    try {
      assert.match(incomplete.container.textContent, /saved monthly payment terms are incomplete/);
      assert.equal(byId("button-setup-monthly-card"), null);
      assert.equal(byId("button-setup-direct-debit"), null);
      assert.doesNotMatch(incomplete.container.textContent, /12 monthly|£0.00/);
    } finally { await incomplete.cleanup(); }
  }
});

test("member must initiate chosen monthly authorization; setup result is not payment confirmation", async () => {
  for (const [mode, id, action] of [
    ["stripe_monthly", "button-setup-monthly-card", "start_monthly_card"],
    ["direct_debit", "button-setup-direct-debit", "start_direct_debit"],
  ]) {
    const view = await mount(fixture(mode));
    try {
      assert.equal(view.calls.filter(Boolean).length, 0);
      await act(async () => byId(id).click());
      await waitFor(() => view.calls.some(Boolean));
      assert.deepEqual(view.calls.filter(Boolean), [{ action }]);
      assert.doesNotMatch(view.container.textContent, /Payment Complete|fee .* has been received|no further action is needed/);
      assert.match(view.container.textContent, /not a payment receipt|no payment receipt/);
    } finally { await view.cleanup(); }
  }
});

test("dynamic saved Direct Debit offers variable collections without requiring fixed total or count", async () => {
  const data = fixture("direct_debit");
  data.ddOffer = {
    ...offer(), planTotal: null, instalmentCount: null,
    collectionPolicy: { end_policy: "continue", pricing_policy: "dynamic" },
  };
  data.finalCost = null;
  data.totalWithVat = null;
  const view = await mount(data);
  try {
    assert.ok(byId("button-setup-direct-debit"));
    assert.equal(byId("button-setup-monthly-card"), null);
    assert.equal(byId("button-pay-now"), null);
    assert.match(byId("text-total").textContent, /£19.73/);
    assert.match(view.container.textContent, /Current monthly price \(variable\)/);
    assert.match(view.container.textContent, /No guaranteed plan total or fixed instalment count/);
    assert.match(view.container.textContent, /Collections continue at the end of the billing period/);
    assert.match(view.container.textContent, /The amount can change during the term/);
    assert.doesNotMatch(view.container.textContent, /terms are incomplete|12 monthly|£0.00|total for this term|Total Due/);
    await act(async () => byId("button-setup-direct-debit").click());
    await waitFor(() => view.calls.some(Boolean));
    assert.deepEqual(view.calls.filter(Boolean), [{ action: "start_direct_debit" }]);
  } finally { await view.cleanup(); }
});

test("query-string setup returns never claim paid and mismatched return cannot confirm another rail", async () => {
  const monthly = await mount(fixture("stripe_monthly"), "?card=success");
  try {
    await waitFor(() => monthly.container.textContent.includes("Authorization Pending Confirmation"));
    assert.doesNotMatch(monthly.container.textContent, /Payment Complete|has been received|no further action is needed/);
    assert.equal(monthly.calls.filter(Boolean).length, 0);
  } finally { await monthly.cleanup(); }
  const dd = await mount(fixture("direct_debit"), "?payment_intent=not-real&redirect_status=succeeded&card=success");
  try {
    await settle();
    assert.equal(dd.calls.filter(Boolean).length, 0);
    assert.doesNotMatch(dd.container.textContent, /Monthly Card Authorization|Payment Complete/);
  } finally { await dd.cleanup(); }
});

test("only server-confirmed paid public status is shown as payment received", async () => {
  const view = await mount({ ...fixture("stripe_upfront"), status: "paid" });
  try {
    assert.match(view.container.textContent, /Payment Complete/);
    assert.match(view.container.textContent, /has been received/);
    assert.equal(byId("button-pay-now"), null);
  } finally { await view.cleanup(); }
});
