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
      builder.onResolve({ filter: /^@\// }, args => /(?:directDebitConsentSummary|membershipFeeCopy)$/.test(args.path)
        ? { path: resolve(`client/src/lib/${args.path.split('/').at(-1)}.js`) }
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
async function mount(data, search = "", transport, vouchers = { enabled: false, vouchers: [] }) {
  dom.window.history.replaceState({}, "", `/membership-fees/saved-token${search}`);
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === "/api/public/membership-fees/saved-token?action=vouchers") {
      return new Response(JSON.stringify(vouchers), { status: 200 });
    }
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
  await waitFor(() => container.textContent.includes("Your Membership") || container.textContent.includes("Payment Complete"));
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
      assert.match(byId("member-start-payment-authority").textContent, /Payment method:/);
      assert.match(view.container.textContent, /1 February 2027 – 31 January 2028/);
      assert.equal(view.calls.filter(Boolean).length, 0);
      if (mode === "invoice") assert.match(view.container.textContent, /invoice remains outstanding/);
      if (mode === "free") assert.match(view.container.textContent, /There is no membership fee to pay/);
    } finally { await view.cleanup(); }
  }
});

test("variable DD content hides internal labels and retains dates, price and continuation disclosures", async () => {
  const data=fixture('direct_debit');
  data.tierLabel='Flat Rate';
  data.membershipYear='rolling:2027-02-01';
  data.renewalLifecycle={};
  data.ddOffer.collectionPolicy={pricing_policy:'dynamic',end_policy:'continue'};
  const view=await mount(data);
  try {
    assert.match(view.container.textContent,/1 February 2027 – 31 January 2028/);
    assert.match(view.container.textContent,/Current monthly payment/);
    assert.match(view.container.textContent,/may change if membership fees are updated/);
    assert.match(view.container.textContent,/payments continue when your membership renews/);
    assert.match(byId('button-setup-direct-debit').textContent,/Continue to Direct Debit Setup/);
    assert.doesNotMatch(view.container.textContent,/rolling:|Flat Rate|first_payment|Membership term:|saved collection|dynamic monthly|billing period/i);
    assert.equal(view.calls.filter(Boolean).length,0);
  } finally {await view.cleanup();}
});

test("confirmed DD renewal describes reuse without implying new setup", async () => {
  const data=fixture(null);
  data.renewal={provider:'gocardless',status:'notice_sent',mode:'confirm'};
  const view=await mount(data);
  try {
    assert.match(byId('button-setup-direct-debit').textContent,/Confirm Direct Debit Renewal/);
    assert.match(view.container.textContent,/Your existing Direct Debit will be reused/);
    assert.doesNotMatch(view.container.textContent,/guide you through secure Direct Debit setup/);
    assert.equal(view.calls.filter(Boolean).length,0);
  } finally {await view.cleanup();}
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
      assert.match(view.container.textContent, /Your membership becomes active after your first payment is received/);
      assert.doesNotMatch(view.container.textContent, /12 monthly/);
    } finally { await view.cleanup(); }
    const incomplete = await mount({ ...data, cardMonthly: null, ddOffer: null });
    try {
      assert.match(incomplete.container.textContent, /can’t confirm your monthly payment details yet/);
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
      assert.match(view.container.textContent, /payment has not yet been confirmed|membership is not yet confirmed/);
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
    assert.match(view.container.textContent, /Current monthly payment/);
    assert.match(view.container.textContent, /notified in advance/);
    assert.match(view.container.textContent, /payments continue when your membership renews/);
    assert.match(view.container.textContent, /monthly amount may change/);
    assert.doesNotMatch(view.container.textContent, /terms are incomplete|12 monthly|£0.00|total for this term|Total Due/);
    await act(async () => byId("button-setup-direct-debit").click());
    await waitFor(() => view.calls.some(Boolean));
    assert.deepEqual(view.calls.filter(Boolean), [{ action: "start_direct_debit" }]);
  } finally { await view.cleanup(); }
});

test("query-string setup returns never claim paid and mismatched return cannot confirm another rail", async () => {
  const monthly = await mount(fixture("stripe_monthly"), "?card=success");
  try {
    await waitFor(() => monthly.container.textContent.includes("Monthly card payments awaiting confirmation"));
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

const availableCredit = {
  enabled: true,
  vouchers: [{ id: "credit-1", value: 13.83, code: "MEM-27", ownerType: "member", displayName: "Harbour rewards" }],
};
const creditQuoteFixture = (dynamic, cashMinor = 12428) => ({
  id: "quote-1", currency: "GBP", paymentMode: "direct_debit",
  grossMinor: 13811, cashMinor,
  allocations: [{ voucherId: "credit-1", amountMinor: 1383, ownerType: "member", displayName: "Harbour rewards" }],
  monthlySnapshot: { instalment_count: 7, collection_policy: { pricing_policy: dynamic ? "dynamic" : "fixed" } },
  // Deliberately out of array order; ordinal, not array position, identifies month one.
  creditSchedule: [
    { ordinal: 2, allocatedCreditMinor: 198 }, { ordinal: 1, allocatedCreditMinor: 198 },
    ...[3, 4, 5, 6, 7].map(ordinal => ({ ordinal, allocatedCreditMinor: ordinal < 5 ? 198 : 197 })),
  ],
});
async function applyCredit(view) {
  await waitFor(() => view.container.querySelector('input[type="checkbox"]'));
  await act(async () => view.container.querySelector('input[type="checkbox"]').click());
  await act(async () => [...view.container.querySelectorAll("button")].find(button => button.textContent === "Apply credit").click());
  await waitFor(() => view.container.querySelector('[role="status"]'));
}
function assertVariableCreditCopy(view) {
  const text = view.container.textContent;
  assert.match(text, /Total selected credit: £13.83/);
  assert.match(text, /spread over 7 monthly payments/);
  assert.match(text, /First-month allocated credit: £1.98/);
  assert.match(text, /Current monthly payment estimate before credit: £19.73/);
  assert.match(text, /Actual monthly fees and payments may change/);
  assert.match(text, /not a fixed total/);
  assert.match(text, /not future renewals/);
  assert.match(text, /Harbour rewards \(your credit\)/);
  assert.doesNotMatch(text, /Remaining to pay:|Membership cost:|Total Due|cash total|monthly payments of|Complete with membership credit|dynamic|collection_policy|allocatedCreditMinor|NaN|Infinity/);
  assert.ok(byId("button-setup-direct-debit"));
  assert.equal(byId("button-pay-now"), null);
  assert.equal(byId("button-setup-monthly-card"), null);
}
test("variable credit quotes disclose actual allocation and never complete from zero or positive forecasts", async () => {
  for (const cashMinor of [0, 12428]) {
    const data = fixture("direct_debit");
    data.ddOffer.collectionPolicy.pricing_policy = "dynamic";
    const quote = creditQuoteFixture(true, cashMinor);
    const view = await mount(data, "", payload => new Response(JSON.stringify(
      payload?.action === "quote_vouchers" ? { quote } : payload ? {} : data
    ), { status: 200 }), availableCredit);
    try {
      await applyCredit(view);
      assertVariableCreditCopy(view);
      assert.deepEqual(view.calls.filter(Boolean), [
        { action: "quote_vouchers", voucherIds: ["credit-1"], paymentMode: "direct_debit" },
      ]);
      await act(async () => byId("button-setup-direct-debit").click());
      await waitFor(() => view.calls.some(call => call?.action === "start_direct_debit"));
      assert.deepEqual(view.calls.filter(Boolean).at(-1), { action: "start_direct_debit", voucherQuoteId: "quote-1" });
      assert.equal(view.calls.some(call => call?.action === "complete_with_vouchers"), false);
      assert.doesNotMatch(view.container.textContent, /Payment Complete|fee .* has been received/);
    } finally { await view.cleanup(); }
  }
});
test("reserved variable credit with a zero forecast retains DD setup and can be released", async () => {
  const data = fixture("direct_debit");
  data.ddOffer.collectionPolicy.pricing_policy = "dynamic";
  const quote = creditQuoteFixture(true, 0);
  data.voucherFunding = {
    variableCredit: true, payableMinor: quote.grossMinor, remainingMinor: 0,
    allocations: quote.allocations.map(row => ({ ...row, id: row.voucherId })),
    creditSchedule: quote.creditSchedule,
  };
  data.voucherMonthly = { paymentMode: "direct_debit", instalmentCount: 7 };
  let released = false;
  const view = await mount(data, "", payload => {
    if (payload?.action === "release_vouchers") released = true;
    return new Response(JSON.stringify(payload ? {} : released ? { ...data, voucherFunding: null, voucherMonthly: null } : data), { status: 200 });
  });
  try {
    assertVariableCreditCopy(view);
    await act(async () => byId("button-setup-direct-debit").click());
    assert.deepEqual(view.calls.filter(Boolean), [{ action: "start_direct_debit" }]);
    assert.doesNotMatch(view.container.textContent, /Payment Complete|has been received/);
    await act(async () => [...view.container.querySelectorAll("button")].find(button => button.textContent === "Cancel payment and release credit").click());
    await waitFor(() => !view.container.querySelector('[aria-label="Reserved membership credit"]'));
    assert.ok(view.calls.some(call => call?.action === "release_vouchers"));
  } finally { await view.cleanup(); }
});
test("variable credit missing allocation details does not invent a count or first-month amount", async () => {
  const data = fixture("direct_debit");
  data.ddOffer.collectionPolicy.pricing_policy = "dynamic";
  const quote = creditQuoteFixture(true, 0);
  delete quote.creditSchedule;
  delete quote.monthlySnapshot.instalment_count;
  const view = await mount(data, "", payload => new Response(JSON.stringify(payload ? { quote } : data), { status: 200 }), availableCredit);
  try {
    await applyCredit(view);
    assert.match(view.container.textContent, /First-month allocated credit is not available yet/);
    assert.match(view.container.textContent, /confirm how your credit is spread/);
    assert.doesNotMatch(view.container.textContent, /12 monthly|NaN|Infinity|Complete with membership credit/);
    await act(async () => [...view.container.querySelectorAll("button")].find(button => button.textContent === "Remove credit selection").click());
    assert.equal(byId("variable-credit-summary"), null);
    assert.ok(byId("button-setup-direct-debit"));
  } finally { await view.cleanup(); }
});
test("fixed credit quotes retain totals and the existing zero-cash completion handler", async () => {
  for (const mode of ["direct_debit", "stripe_monthly", "stripe_upfront"]) {
    const data = fixture(mode);
    const quote = { ...creditQuoteFixture(false, 0), paymentMode: mode };
    if (mode === "stripe_upfront") delete quote.monthlySnapshot;
    const view = await mount(data, "", payload => new Response(JSON.stringify(
      payload?.action === "quote_vouchers" ? { quote }
        : payload ? { error: "Fixture stopped before completion" } : data
    ), { status: payload?.action === "complete_with_vouchers" ? 409 : 200 }), availableCredit);
    try {
      await applyCredit(view);
      assert.match(view.container.textContent, /Membership cost: £138.11/);
      assert.match(view.container.textContent, /Remaining to pay: £0.00/);
      assert.equal(byId("variable-credit-summary"), null);
      const complete = [...view.container.querySelectorAll("button")].find(button => button.textContent === "Complete with membership credit");
      assert.ok(complete);
      await act(async () => complete.click());
      assert.ok(view.calls.some(call => call?.action === "complete_with_vouchers" && call.voucherQuoteId === "quote-1"));
      assert.equal(document.querySelector('script[src="https://js.stripe.com/v3/"]'), null);
      assert.doesNotMatch(view.container.textContent, /Payment Complete|has been received/);
    } finally { await view.cleanup(); }
  }
});

test("a failed variable credit quote can be retried without starting a payment", async () => {
  const data = fixture("direct_debit");
  data.ddOffer.collectionPolicy.pricing_policy = "dynamic";
  let attempts = 0;
  const view = await mount(data, "", payload => {
    if (payload?.action === "quote_vouchers") {
      attempts += 1;
      return new Response(JSON.stringify(attempts === 1
        ? { error: "Credit summary is temporarily unavailable. Try again." }
        : { quote: creditQuoteFixture(true, 0) }), { status: attempts === 1 ? 503 : 200 });
    }
    return new Response(JSON.stringify(data), { status: 200 });
  }, availableCredit);
  try {
    await waitFor(() => view.container.querySelector('input[type="checkbox"]'));
    await act(async () => view.container.querySelector('input[type="checkbox"]').click());
    const apply = () => [...view.container.querySelectorAll("button")].find(button => button.textContent === "Apply credit");
    await act(async () => apply().click());
    await waitFor(() => view.container.querySelector('[role="alert"]'));
    assert.match(view.container.textContent, /Credit summary is temporarily unavailable/);
    assert.equal(byId("variable-credit-summary"), null);
    await act(async () => apply().click());
    await waitFor(() => byId("variable-credit-summary"));
    assertVariableCreditCopy(view);
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.equal(view.calls.filter(Boolean).length, 2);
    assert.ok(view.calls.filter(Boolean).every(call => call.action === "quote_vouchers"));
  } finally { await view.cleanup(); }
});
