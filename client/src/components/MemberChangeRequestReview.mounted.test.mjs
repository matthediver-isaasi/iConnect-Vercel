import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// node scripts/run-isolated-tests.mjs node --test client/src/components/MemberChangeRequestReview.mounted.test.mjs
// The real review, parent and financial lifecycles are mounted; all transport is isolated.
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
    name: "approved-request-isolated-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^\.\/MemberCancellationRequests$/ }, () => ({ path: "cancellations", namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default function Stub(){return null;}", loader: "js" }));
      builder.onResolve({ filter: /^@\/lib\/memberChangeRequests$/ }, () => ({ path: `${process.cwd()}/client/src/lib/memberChangeRequests.js` }));
      builder.onResolve({ filter: /^@\// }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        loader: "js",
        contents: path.endsWith("adminFetch")
          ? "export const adminFetch = (url, options = {}, tenantId) => globalThis.fetch(url, {...options, credentials:'include', headers:{...options.headers, 'X-Tenant-Id':tenantId}});"
          : path.endsWith("useFormAlerts")
            ? "export const useFormAlertTenant = () => globalThis.reviewScope;"
            : `import React from "react";
              const wrap = tag => ({children, variant, size, ...props}) => React.createElement(tag, props, children);
              export const Card = wrap("div"), CardHeader = wrap("div"), CardTitle = wrap("h2"), CardContent = wrap("div");
              export const Button = wrap("button"), Badge = wrap("span"), Input = wrap("input"), Label = wrap("label"), Textarea = wrap("textarea");`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/approved-request-mounted.cjs`);
compiled.filename = `${process.cwd()}/approved-request-mounted.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const { QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const life = overrides => ({ execution: null, settlement: null, application: null, notifications: [], ...overrides });
const authority = (delta = 4327, policy = "none") => ({
  action: "change", memberId: "member-review", tenantId: "tenant-finance",
  sourceSnapshot: {
    id: "source", term_start_date: "2026-04-17", term_end_date: "2027-04-16", membership_renewal_date: "2027-04-17",
    commitment_snapshot: { payment_frequency: "upfront", config: { name: "Associate" } },
  },
  targetSnapshot: { id: "professional", name: "Professional", pricing_model: "flat" },
  calculation: {
    version: 2, behaviour: "retain_term", sourceRecordId: "source", currency: "GBP", effectiveDate: "2027-01-17",
    delta: { grossMinor: delta }, newTerm: { renewalDate: "2027-04-17" },
    finance: { personalFundingOnly: true, blockers: [] }, blockers: [],
  },
  settlement: { surplusHandling: policy, blockers: [] },
  fundingEvidence: { complete: true, sourceRecordId: "source", settledFunding: [{ kind: "cash", ownerType: "member", ownerId: "member-review" }] },
  ...(policy === "credit" ? { creditLiabilityBinding: { accountId: "liability" } } : {}),
});
const request = overrides => ({
  id: "request-review", state: "approved", authorityId: "authority-review",
  summary: { targetName: "Professional", paymentDueMinor: 4327, surplusMinor: 0, currency: "GBP" }, ...overrides,
});
const button = text => [...document.querySelectorAll("button")].find(item => item.textContent === text);
async function click(element) {
  assert.ok(element, "control exists");
  assert.equal(element.disabled, false, element.textContent);
  await act(async () => element.click());
}
async function waitFor(predicate) {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.fail(`Timed out: ${document.body.textContent}`);
}
async function change(selector, value) {
  const element = document.querySelector(selector);
  assert.ok(element, selector);
  const prototype = element.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function mount({ evidence = authority(), approved = request(), missing = false, creditEnabled = true, monthly = false, post } = {}) {
  window.localStorage.clear();
  globalThis.reviewScope = { status: "ready", tenantId: "tenant-finance", scopeKey: "finance", assertCurrent() {} };
  const calls = [];
  const savedRecord = { id: "authority-review", authority: evidence, ...life() };
  const data = {
    current: evidence.sourceSnapshot, structures: [], history: [], monthlyChanges: [],
    financialChanges: missing || monthly ? [] : [savedRecord],
    ...(monthly ? { monthlyChanges: [savedRecord], monthlyExecutionAvailable: true } : {}),
    financialExecutionAvailable: true, memberCreditExecutionAvailable: creditEnabled,
    capabilities: {}, blockers: [],
  };
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    assert.equal(options.headers["X-Tenant-Id"], "tenant-finance");
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, payload });
    if (payload) return post ? post(payload) : json(life({ state: "not_started", nextAction: "execute" }));
    if (url.includes("action=member_change_requests")) return json({ requests: [approved] });
    if (url.includes("action=cancellation_finances")) return json({ records: [], nextCursor: null });
    return json(data);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const invalidations = [];
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = options => { invalidations.push(options.queryKey); return invalidate(options); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(QueryClientProvider, { client },
    React.createElement(Component, { memberId: "member-review", tenantId: "tenant-finance" }))));
  await waitFor(() => approved.state === "pending" ? button("Review approval") && !button("Review approval").disabled
    : button("Review financial processing") && !button("Review financial processing").disabled);
  return {
    calls, invalidations,
    async select() {
      await click(button("Review financial processing"));
      await waitFor(() => button("Review financial processing") && !button("Review financial processing").disabled);
    },
    async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); },
  };
}
async function approve() {
  await change('textarea[id^="financial-approval-reason-"]', "Finance checked the saved authority");
  await click(document.querySelector('input[id^="financial-approve-"]'));
  await click(button("Approve and execute upfront financial change"));
}

test("approved summary selects the original authority; recovery, reason and confirmation precede collection", async () => {
  let executions = 0;
  const view = await mount({ post: payload => {
    if (payload.action === "resume_change") return json(life({ nextAction: "execute" }));
    executions++;
    assert.deepEqual(payload, {
      action: "execute_change", memberId: "member-review", authorityId: "authority-review",
      approve: true, reason: "Finance checked the saved authority", settlementChoice: "collect",
    });
    return json(life({ execution: { id: "execution", settlement_choice: "collect" }, settlement: {
      choice: "collect", state: "awaiting_payment", evidence: { verified: true, paymentUrl: "https://payments.example.test/invoice" },
    } }));
  } });
  try {
    await view.select();
    assert.equal(document.activeElement.dataset.testid, "financial-authority-authority-review");
    assert.equal(document.querySelectorAll('[data-testid="financial-authority-authority-review"]').length, 1);
    assert.equal(view.calls.filter(call => call.payload).length, 0);
    assert.equal(button("Approve and execute upfront financial change"), undefined);
    await click(button("Check / recover upfront financial change"));
    assert.equal(button("Approve and execute upfront financial change").disabled, true);
    await approve();
    assert.equal(executions, 1);
    assert.match(document.body.textContent, /Awaiting collection/);
    assert.doesNotMatch(document.body.textContent, /Upfront membership application confirmed/);
    assert.ok(document.querySelector('a[href="https://payments.example.test/invoice"]'));
    assert.ok(view.calls.filter(call => !call.payload && !call.url.includes("action=")).length >= 2);
  } finally { await view.cleanup(); }
});

test("unknown execution cannot be retried until resume returns a fresh grant", async () => {
  let attempts = 0;
  const view = await mount({ post: payload => {
    if (payload.action === "resume_change") return json(life({ nextAction: "execute" }));
    attempts++;
    throw new Error("Transport interrupted");
  } });
  try {
    await view.select();
    await click(button("Check / recover upfront financial change"));
    await approve();
    assert.equal(button("Approve and execute upfront financial change"), undefined);
    await view.select();
    assert.equal(attempts, 1);
    await click(button("Check / recover upfront financial change"));
    await approve();
    assert.deepEqual(view.calls.filter(call => call.payload).map(call => call.payload.action),
      ["resume_change", "execute_change", "resume_change", "execute_change"]);
  } finally { await view.cleanup(); }
});

for (const [delta, policy, expected] of [[0, "none", "none"], [-2843, "refund", "refund"], [-2843, "credit", "credit"]]) {
  test(`original authority economics choose ${expected}, not the request summary`, async () => {
    const view = await mount({ evidence: authority(delta, policy), post: payload => {
      if (payload.action === "resume_change") return json(life({ nextAction: "execute" }));
      assert.equal(payload.settlementChoice, expected);
      return json(life({ execution: { id: "execution", settlement_choice: expected },
        settlement: { choice: expected, state: expected === "refund" ? "awaiting_reconciliation" : "settled" } }));
    } });
    try {
      await view.select();
      await click(button("Check / recover upfront financial change"));
      await approve();
      assert.equal(view.calls.filter(call => call.payload?.action === "execute_change").length, 1);
      if (expected === "refund") assert.match(document.body.textContent, /Awaiting finance reconciliation/);
      assert.doesNotMatch(document.body.textContent, /Upfront membership application confirmed/);
    } finally { await view.cleanup(); }
  });
}

test("approval surplus policy requires explicit selection and does not offer disabled credit", async () => {
  const evidence = { ...authority(-2843, "approval"), creditLiabilityBinding: { accountId: "liability" } };
  const view = await mount({ evidence, creditEnabled: false });
  try {
    await view.select();
    await click(button("Check / recover upfront financial change"));
    const select = document.querySelector('select[id^="financial-treatment-"]');
    assert.equal(select.value, "");
    assert.deepEqual([...select.options].map(option => option.value), ["", "refund"]);
    assert.equal(button("Approve and execute upfront financial change").disabled, true);
    await change('select[id^="financial-treatment-"]', "refund");
    await approve();
    assert.equal(view.calls.find(call => call.payload?.action === "execute_change").payload.settlementChoice, "refund");
  } finally { await view.cleanup(); }
});

test("missing authority or unknown economics never infer zero or start execution", async () => {
  const view = await mount({ missing: true, approved: request({ summary: { currency: "GBP" } }) });
  try {
    await view.select();
    assert.match(document.body.textContent, /saved authority is not available/);
    await click(button("Reload selected financial authority"));
    assert.equal(view.calls.filter(call => call.payload).length, 0);
  } finally { await view.cleanup(); }
  const evidence = authority();
  delete evidence.calculation.delta.grossMinor;
  const unknown = await mount({ evidence });
  try {
    await unknown.select();
    assert.match(document.body.textContent, /Financial execution blocked/);
    assert.equal(button("Check / recover upfront financial change"), undefined);
    assert.equal(unknown.calls.filter(call => call.payload).length, 0);
  } finally { await unknown.cleanup(); }
});

test("refund waiting uses refund language, not collection, and application alone refreshes member queries", async () => {
  let recovered = false;
  const application = { id: "application", snapshot: { targetSnapshot: { config: { id: "professional" } } },
    effective_date: "2027-01-17", expires_on: "2027-04-17" };
  const execution = { id: "execution", settlement_choice: "refund" };
  const view = await mount({ evidence: authority(-2843, "refund"), post: payload => {
    if (payload.action === "resume_change" && !recovered) return json(life({ nextAction: "execute" }));
    if (payload.action === "execute_change") {
      recovered = true;
      return json(life({ execution, settlement: { choice: "refund", state: "awaiting_payment" } }));
    }
    return json(life({ execution, settlement: { choice: "refund", state: "settled" }, application }));
  } });
  try {
    await view.select();
    await click(button("Check / recover upfront financial change"));
    await approve();
    assert.match(document.body.textContent, /Awaiting manual refund and bank-reconciliation evidence/);
    assert.doesNotMatch(document.body.textContent, /Awaiting collection/);
    assert.equal(view.invalidations.some(key => key[0] === "member-detail"), false);
    await click(button("Check / recover upfront financial change"));
    assert.match(document.body.textContent, /Upfront membership application confirmed/);
    assert.ok(view.invalidations.some(key => key[0] === "member-detail"));
    assert.ok(view.invalidations.some(key => key[0] === "member-membership"));
    assert.equal(view.calls.filter(call => call.payload?.action === "execute_change").length, 1);
  } finally { await view.cleanup(); }
});

test("monthly approved request selects the existing monthly lifecycle without provider writes", async () => {
  const evidence = authority();
  evidence.sourceSnapshot.commitment_snapshot.payment_frequency = "monthly";
  evidence.calculation.version = 3;
  evidence.calculation.currentMonthlyPriceMinor = 2843;
  evidence.monthlyExecution = { version: 1, providerTarget: {}, providerAuthority: {} };
  const view = await mount({ monthly: true, evidence, post: () => json({ state: "not_started", nextAction: "execute" }) });
  try {
    await view.select();
    assert.equal(document.activeElement.dataset.testid, "monthly-authority-authority-review");
    assert.equal(view.calls.filter(call => call.payload).length, 0);
    await click(button("Check / recover monthly operation"));
    assert.match(document.body.textContent, /Explicit approval required/);
    assert.deepEqual(view.calls.find(call => call.payload).payload,
      { action: "resume_change", memberId: "member-review", authorityId: "authority-review" });
    await view.select();
    assert.doesNotMatch(document.body.textContent, /Explicit approval required/);
  } finally { await view.cleanup(); }
});

test("review approval creates the processing action but never executes automatically", async () => {
  const view = await mount({ approved: request({ state: "pending", authorityId: null }), post: payload => {
    assert.equal(payload.action, "review_member_change_request");
    return json(request());
  } });
  try {
    assert.equal(button("Review financial processing"), undefined);
    await click(button("Review approval"));
    await change('textarea[id^="review-reason-"]', "Approved for finance review");
    await click([...document.querySelectorAll("label")].find(label => label.textContent.includes("I explicitly approve"))?.querySelector("input"));
    await click(button("Confirm approval"));
    await waitFor(() => button("Review financial processing") && !button("Review financial processing").disabled);
    await view.select();
    assert.deepEqual(view.calls.filter(call => call.payload).map(call => call.payload.action), ["review_member_change_request"]);
    assert.match(document.body.textContent, /No payment, refund or membership change was executed/);
  } finally { await view.cleanup(); }
});
