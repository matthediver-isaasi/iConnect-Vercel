import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Existing mounted-test harness conventions. All transport is replaced before import.
// node scripts/run-isolated-tests.mjs node --test client/src/components/MemberUpfrontFinancialChanges.mounted.test.mjs
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
    name: "upfront-financial-isolated-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\// }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        loader: "js",
        contents: path.endsWith("adminFetch")
          ? "export const adminFetch = (url, options = {}, tenantId) => globalThis.fetch(url, {...options, credentials:'include', headers:{...options.headers, 'X-Tenant-Id':tenantId}});"
          : `import React from "react";
            const wrap = tag => ({children, variant, size, ...props}) => React.createElement(tag, props, children);
            export const Card = wrap("div"), CardHeader = wrap("div"), CardTitle = wrap("h2"), CardContent = wrap("div");
            export const Button = wrap("button"), Badge = wrap("span"), Input = wrap("input"), Label = wrap("label"), Textarea = wrap("textarea");`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/upfront-financial-mounted-isolated.cjs`);
compiled.filename = `${process.cwd()}/upfront-financial-mounted-isolated.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const { QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const authority = (grossMinor = 4327, surplusHandling = "none") => ({
  version: 1, action: "change", tenantId: "tenant-finance", memberId: "member-upfront",
  sourceSnapshot: {
    id: "source-upfront", term_start_date: "2026-04-17", term_end_date: "2027-04-16", membership_renewal_date: "2027-04-17",
    commitment_snapshot: { payment_frequency: "upfront", config: { name: "Associate" } },
  },
  targetSnapshot: { id: "target-config", name: "Professional", pricing_model: "tiered" },
  targetBandSnapshot: { id: "standard", label: "Standard" },
  request: { configId: "target-config", bandId: "standard", effectiveDate: "2027-01-17", reason: "Qualification verified" },
  calculation: {
    version: 2, behaviour: "retain_term", sourceRecordId: "source-upfront", currency: "GBP", effectiveDate: "2027-01-17",
    delta: { netMinor: grossMinor ? Math.sign(grossMinor) * 3606 : 0, vatMinor: grossMinor ? Math.sign(grossMinor) * 721 : 0, grossMinor },
    newTerm: { renewalDate: "2027-04-17" }, finance: { personalFundingOnly: true, blockers: [] }, blockers: [],
  },
  fundingEvidence: { complete: true, sourceRecordId: "source-upfront", settledFunding: [{ id: "cash-proof", kind: "cash", state: "settled", ownerType: "member", ownerId: "member-upfront" }] },
  settlement: { surplusHandling, blockers: [] },
  ...(surplusHandling === "credit" ? { creditLiabilityBinding: { accountId: "liability-account", providerTenantId: "accounting-org" } } : {}),
});
const fixture = () => ({
  current: authority().sourceSnapshot,
  structures: [{ id: "target-config", name: "Professional", pricing_model: "tiered", bands: [{ id: "standard", label: "Standard" }] }],
  history: [], monthlyChanges: [], financialChanges: [], financialExecutionAvailable: true, memberCreditExecutionAvailable: true,
  capabilities: { preview: true, create: true }, blockers: [],
});
const record = evidence => ({ id: "financial-authority", authority: evidence || authority(), execution: null, settlement: null, application: null, notifications: [] });
const life = (overrides = {}) => ({ execution: null, settlement: null, application: null, notifications: [], ...overrides });
const application = { id: "application-upfront", snapshot: { targetSnapshot: { config: { id: "target-config" } } }, effective_date: "2027-01-17", expires_on: "2027-04-17" };
const fingerprint = "a".repeat(64);
const financialPanel = () => document.querySelector('[data-testid="upfront-financial-changes"]');
const button = label => [...document.querySelectorAll("button")].find(item => item.textContent === label);
const click = async element => {
  assert.ok(element, "button exists");
  assert.equal(element.disabled, false);
  await act(async () => element.click());
};
async function waitFor(predicate) {
  for (let i = 0; i < 70; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.fail("Timed out waiting for mounted upfront financial UI");
}
async function change(selector, value) {
  const element = document.querySelector(selector);
  assert.ok(element, selector);
  const prototype = element.tagName === "INPUT" ? dom.window.HTMLInputElement.prototype : element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLSelectElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function fill(reason = "Qualification verified") {
  await change('select[id^="financial-config-"]', "target-config");
  await change('select[id^="financial-band-"]', "standard");
  await change('input[id^="financial-date-"]', "2027-01-17");
  await change('textarea[id^="financial-reason-"]', reason);
}
async function approve() {
  await change('textarea[id^="financial-approval-reason-"]', "Finance verified original cash and retained term");
  await click(document.querySelector('input[id^="financial-approve-"]'));
  await click(button("Approve and execute upfront financial change"));
}
async function mount({ data = fixture(), get, post } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.match(url, /^\/api\/membership\/member-amendments/);
    assert.equal(options.credentials, "include");
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ payload, tenantId: options.headers["X-Tenant-Id"] });
    return payload ? post ? post(payload) : json({ authority: authority(), fingerprint }) : get ? get() : json(data);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (memberId = "member-upfront", tenantId = "tenant-finance") => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Component, { memberId, tenantId })));
  await act(async () => render());
  await waitFor(() => container.textContent.includes("Membership change requests"));
  await waitFor(() => !container.querySelector('[aria-label="Loading membership change requests"]'));
  return { calls, container, client, render, async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}
function historyFixture(evidence = authority(), overrides = {}) {
  const data = fixture();
  data.financialChanges = [{ ...record(evidence), ...overrides }];
  return data;
}
const approvalEvidence = () => ({
  ...authority(-4327, "approval"),
  creditLiabilityBinding: { accountId: "liability-account", providerTenantId: "accounting-org" },
});

test("replacement-term execution requires its own release capability and shows the new renewal boundary", async () => {
  const replacement = authority();
  replacement.calculation.behaviour = "new_term";
  replacement.calculation.newTerm = { startDate: "2027-01-17", renewalDate: "2028-01-17" };
  let mounted = await mount({ data: historyFixture(replacement) });
  try {
    assert.equal(button("Check / recover upfront financial change"), undefined);
  } finally { await mounted.cleanup(); }
  const data = { ...historyFixture(replacement), replacementExecutionAvailable: true };
  mounted = await mount({ data, post: payload => {
    if (payload.action === "resume_change") return json(life({ nextAction: "execute" }));
    assert.equal(payload.action, "execute_change");
    assert.equal(payload.settlementChoice, "collect");
    assert.equal(payload.approve, true);
    return json(life({
      execution: { id: "replacement-execution", settlement_choice: "collect" },
      settlement: { state: "settled", choice: "collect" },
      application: { ...application, expires_on: "2028-01-17" },
    }));
  } });
  try {
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => !!button("Approve and execute upfront financial change"));
    assert.match(financialPanel().textContent, /replacement-term change/);
    await approve();
    await waitFor(() => financialPanel().textContent.includes("Upfront membership application confirmed"));
    assert.match(financialPanel().textContent, /New renewal boundary: 2028-01-17/);
    assert.doesNotMatch(financialPanel().textContent, /Original renewal boundary retained:/);
  } finally { await mounted.cleanup(); }
});

test("separate upfront form leaves the legacy form intact and previews exact retained-term selection", async () => {
  window.localStorage.clear();
  const view = await mount();
  try {
    assert.ok(button("Preview"));
    assert.ok(button("Preview upfront financial change"));
    assert.equal(button("Preview upfront financial change").disabled, true);
    await fill();
    await click(button("Preview upfront financial change"));
    await waitFor(() => button("Save upfront financial authority"));
    assert.deepEqual(view.calls.find(item => item.payload).payload, {
      action: "preview_change", memberId: "member-upfront",
      selection: { configId: "target-config", bandId: "standard", effectiveDate: "2027-01-17", reason: "Qualification verified", action: "change" },
    });
    assert.match(financialPanel().textContent, /Gross adjustment£43.27/);
    assert.match(financialPanel().textContent, /Original renewal boundary: 2027-04-17/);
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
    await change('textarea[id^="financial-reason-"]', "Updated reason");
    assert.equal(document.querySelector('[data-testid="upfront-financial-preview"]'), null);
  } finally { await view.cleanup(); }
});

test("source snapshot updates invalidate previews and late preview results", async () => {
  window.localStorage.clear();
  let resolve;
  let delayed = false;
  const gate = new Promise(done => { resolve = done; });
  const view = await mount({ post: () => delayed ? gate : json({ authority: authority(), fingerprint }) });
  try {
    await fill();
    await click(button("Preview upfront financial change"));
    await waitFor(() => button("Save upfront financial authority"));
    await act(async () => view.client.setQueryData(["member-amendments", "tenant-finance", "member-upfront"], previous => ({ ...previous, current: { ...previous.current, total_with_vat: 207.43 } })));
    await waitFor(() => document.querySelector('[data-testid="upfront-financial-preview"]') === null);
    delayed = true;
    await click(button("Preview upfront financial change"));
    await act(async () => view.client.setQueryData(["member-amendments", "tenant-finance", "member-upfront"], previous => ({ ...previous, current: { ...previous.current, total_with_vat: 219.83 } })));
    await waitFor(() => view.container.textContent.includes("219.83"));
    await act(async () => resolve(json({ authority: authority(), fingerprint })));
    assert.equal(document.querySelector('[data-testid="upfront-financial-preview"]'), null);
  } finally { await view.cleanup(); }
});

test("lost confirmation retries the exact request; persistent storage contains no reason or selection", async () => {
  window.localStorage.clear();
  let confirmations = 0;
  const privateReason = "Private finance note that must stay out of browser storage";
  const view = await mount({ post: payload => {
    if (payload.action === "preview_change") return json({ authority: authority(), fingerprint });
    if (++confirmations === 1) throw new Error("Confirmation connection lost");
    return json({ record: record() });
  } });
  try {
    await fill(privateReason);
    await click(button("Preview upfront financial change"));
    await waitFor(() => button("Save upfront financial authority"));
    await click(button("Save upfront financial authority"));
    await waitFor(() => financialPanel().textContent.includes("Confirmation connection lost"));
    assert.equal(document.querySelector('select[id^="financial-config-"]').closest("fieldset").disabled, true);
    const stored = window.localStorage.getItem(window.localStorage.key(0));
    assert.doesNotMatch(stored, /Private|reason|selection|configId/);
    assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ["fingerprint", "idempotencyKey"]);
    await click(button("Retry original financial confirmation"));
    await waitFor(() => financialPanel().textContent.includes("Upfront financial authority saved"));
    const requests = view.calls.filter(item => item.payload?.action === "confirm_change");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].payload, requests[1].payload);
    assert.equal(requests[0].payload.selection.reason, privateReason);
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
  } finally { await view.cleanup(); window.localStorage.clear(); }
});

test("reload confirmation recovery uses persisted operational key only, never confirms or executes automatically", async () => {
  window.localStorage.clear();
  let view = await mount({ post: payload => payload.action === "preview_change" ? json({ authority: authority(), fingerprint }) : new Response("<html>Gateway</html>", { status: 502 }) });
  try {
    await fill();
    await click(button("Preview upfront financial change"));
    await waitFor(() => button("Save upfront financial authority"));
    await click(button("Save upfront financial authority"));
    await waitFor(() => financialPanel().textContent.includes("unreadable response"));
    const original = view.calls.find(item => item.payload?.action === "confirm_change").payload;
    await view.cleanup();
    view = await mount({ post: payload => {
      assert.deepEqual(payload, { action: "recover_change", memberId: "member-upfront", fingerprint: original.fingerprint, idempotencyKey: original.idempotencyKey });
      return json({ record: record() });
    } });
    assert.equal(button("Retry original financial confirmation"), undefined);
    assert.equal(button("Preview upfront financial change"), undefined);
    assert.equal(view.calls.filter(item => item.payload).length, 0);
    await click(button("Recover saved financial authority"));
    await waitFor(() => financialPanel().textContent.includes("Upfront financial authority saved"));
    assert.equal(view.calls.filter(item => item.payload).length, 1);
    assert.equal(button("Approve and execute upfront financial change"), undefined);
  } finally { await view.cleanup(); window.localStorage.clear(); }
});

test("availability strictly gates saving and execution while saved history stays visible", async () => {
  for (const availability of [false, undefined, "true"]) {
    const data = historyFixture();
    data.financialExecutionAvailable = availability;
    const view = await mount({ data, post: payload => payload.action === "preview_change" ? json({ authority: authority(), fingerprint }) : json(life({ nextAction: "execute" })) });
    try {
      assert.match(financialPanel().textContent, /authority saving are unavailable/);
      assert.match(financialPanel().textContent, /Financial authority financial-authority/);
      await fill();
      await click(button("Preview upfront financial change"));
      await waitFor(() => button("Save upfront financial authority"));
      assert.equal(button("Save upfront financial authority").disabled, true);
      await click(button("Check / recover upfront financial change"));
      assert.equal(button("Approve and execute upfront financial change"), undefined);
      assert.ok(view.calls.every(item => !item.payload || ["preview_change", "resume_change"].includes(item.payload.action)));
    } finally { await view.cleanup(); }
  }
});

test("positive and zero adjustments require explicit approval/reason and use collect or none", async () => {
  for (const [delta, choice] of [[4327, "collect"], [0, "none"]]) {
    const view = await mount({ data: historyFixture(authority(delta)), post: payload => json(payload.action === "resume_change" ? life({ nextAction: "execute" }) : life({ application })) });
    try {
      assert.equal(button("Approve and execute upfront financial change"), undefined);
      await click(button("Check / recover upfront financial change"));
      await waitFor(() => button("Approve and execute upfront financial change"));
      assert.equal(button("Approve and execute upfront financial change").disabled, true);
      await change('textarea[id^="financial-approval-reason-"]', "   ");
      await click(document.querySelector('input[id^="financial-approve-"]'));
      assert.equal(button("Approve and execute upfront financial change").disabled, true);
      await change('textarea[id^="financial-approval-reason-"]', "Finance verified");
      await click(button("Approve and execute upfront financial change"));
      await waitFor(() => financialPanel().textContent.includes("Upfront membership application confirmed"));
      assert.deepEqual(view.calls.find(item => item.payload?.action === "execute_change").payload, {
        action: "execute_change", memberId: "member-upfront", authorityId: "financial-authority", approve: true, reason: "Finance verified", settlementChoice: choice,
      });
      assert.ok(view.calls.every(item => item.tenantId === "tenant-finance"));
    } finally { await view.cleanup(); }
  }
});

test("negative refund and explicitly selected approval-policy refund require manual bank reconciliation, never automatic cash", async () => {
  for (const policy of ["refund", "approval"]) {
    const view = await mount({ data: historyFixture(authority(-4327, policy)), post: payload => json(payload.action === "resume_change" ? life({ nextAction: "execute" }) : life({ settlement: { choice: "refund", state: "awaiting_reconciliation" } })) });
    try {
      assert.match(financialPanel().textContent, /manual refund must be recorded and bank-reconciled/);
      assert.match(financialPanel().textContent, /does not send cash automatically/);
      await click(button("Check / recover upfront financial change"));
      await waitFor(() => button("Approve and execute upfront financial change"));
      if (policy === "approval") {
        assert.equal(document.querySelector('select[id^="financial-treatment-"]').value, "");
        assert.equal(button("Approve and execute upfront financial change").disabled, true);
        await change('select[id^="financial-treatment-"]', "refund");
      }
      await approve();
      assert.equal(view.calls.find(item => item.payload?.action === "execute_change").payload.settlementChoice, "refund");
      assert.doesNotMatch(financialPanel().textContent, /Upfront membership application confirmed/);
      assert.equal(button("Approve and execute upfront financial change"), undefined);
    } finally { await view.cleanup(); }
  }
});

test("credit needs frozen binding, is iConnect member credit, and remains unspendable without application", async () => {
  const evidence = authority(-4327, "credit");
  let view = await mount({ data: historyFixture(evidence), post: payload => json(payload.action === "resume_change" ? life({ nextAction: "back_credit" }) : life({ settlement: { choice: "credit", state: "settled" } })) });
  try {
    assert.match(financialPanel().textContent, /liability-backed iConnect member credit/);
    assert.match(financialPanel().textContent, /not a retained Xero credit note and not a cash refund/);
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => button("Approve and execute upfront financial change"));
    await approve();
    assert.equal(view.calls.find(item => item.payload?.action === "execute_change").payload.settlementChoice, "credit");
    assert.match(financialPanel().textContent, /Member credit is not spendable yet/);
    assert.doesNotMatch(financialPanel().textContent, /Upfront membership application confirmed/);
  } finally { await view.cleanup(); }
  delete evidence.creditLiabilityBinding;
  view = await mount({ data: historyFixture(evidence), post: () => json({ authority: evidence, fingerprint }) });
  try {
    assert.match(financialPanel().textContent, /Frozen credit liability binding is missing/);
    assert.equal(button("Check / recover upfront financial change"), undefined);
    await fill();
    await click(button("Preview upfront financial change"));
    await waitFor(() => button("Save upfront financial authority"));
    assert.equal(button("Save upfront financial authority").disabled, true);
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
  } finally { await view.cleanup(); }
});

test("credit flag false or absent blocks credit despite frozen liability binding and backend back_credit grant", async () => {
  for (const creditFlag of [false, undefined, "true"]) {
    const data = historyFixture(authority(-4327, "credit"));
    data.memberCreditExecutionAvailable = creditFlag;
    const view = await mount({ data, post: () => json(life({ nextAction: "back_credit" })) });
    try {
      assert.equal(data.financialExecutionAvailable, true);
      assert.ok(data.financialChanges[0].authority.creditLiabilityBinding);
      assert.match(financialPanel().textContent, /iConnect member credit policy — not yet executable/);
      assert.match(financialPanel().textContent, /account binding alone does not enable credit/);
      assert.match(financialPanel().textContent, /No retained Xero credit or refund fallback/);
      await click(button("Check / recover upfront financial change"));
      await waitFor(() => financialPanel().textContent.includes("No permitted execution action is available"));
      assert.equal(button("Approve and execute upfront financial change"), undefined);
      assert.equal(document.querySelector('textarea[id^="financial-approval-reason-"]'), null);
      assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
      assert.ok(view.calls.every(item => !item.payload || item.payload.action === "resume_change"));
    } finally { await view.cleanup(); }
  }
});

test("credit also requires financial availability even with explicit member credit flag", async () => {
  const data = historyFixture(authority(-4327, "credit"));
  data.financialExecutionAvailable = false;
  data.memberCreditExecutionAvailable = true;
  const view = await mount({ data, post: () => json(life({ nextAction: "execute" })) });
  try {
    assert.match(financialPanel().textContent, /iConnect member credit policy — not yet executable/);
    await click(button("Check / recover upfront financial change"));
    assert.equal(button("Approve and execute upfront financial change"), undefined);
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
  } finally { await view.cleanup(); }
});

test("settled alone never implies application and malformed application fails closed", async () => {
  for (const app of [null, {}]) {
    const view = await mount({ data: historyFixture(authority(), { settlement: { choice: "collect", state: "settled" }, application: app }) });
    try {
      assert.match(financialPanel().textContent, /Settlement recorded, but membership application is not confirmed/);
      assert.doesNotMatch(financialPanel().textContent, /Upfront membership application confirmed/);
      if (app) assert.match(financialPanel().textContent, /Application evidence is incomplete/);
    } finally { await view.cleanup(); }
  }
});

test("awaiting collection offers only verified HTTPS payment links with no automatic navigation", async () => {
  for (const [paymentUrl, verified, expected] of [
    ["https://in.xero.com/verified-invoice", true, true],
    ["javascript:alert(1)", true, false],
    ["http://in.xero.com/invoice", true, false],
    ["https://user:secret@in.xero.com/invoice", true, false],
    ["https://in.xero.com/unverified", false, false],
  ]) {
    const view = await mount({ data: historyFixture(authority(), { settlement: { choice: "collect", state: "awaiting_payment", evidence: { paymentUrl, verified } } }) });
    try {
      const link = financialPanel().querySelector("a");
      assert.equal(!!link, expected);
      if (expected) { assert.equal(link.href, paymentUrl); assert.equal(link.rel, "noopener noreferrer"); }
      assert.equal(window.location.href, "https://isolated.example.test/");
      assert.equal(view.calls.filter(item => item.payload).length, 0);
    } finally { await view.cleanup(); }
  }
});

test("monthly/currently missing sources never offer upfront preview but financial history is always displayed", async () => {
  for (const current of [null, { ...authority().sourceSnapshot, commitment_snapshot: { payment_frequency: "monthly" } }]) {
    const data = historyFixture();
    data.current = current;
    const view = await mount({ data });
    try {
      assert.match(financialPanel().textContent, /Financial authority financial-authority/);
      assert.equal(button("Preview upfront financial change"), undefined);
    } finally { await view.cleanup(); }
  }
});

test("missing accounts/provider failures are exposed; uncertain execute forces read-only recovery", async () => {
  let recoveries = 0;
  const view = await mount({ data: historyFixture(), post: payload => {
    if (payload.action === "resume_change") return ++recoveries === 1 ? json(life({ nextAction: "execute" })) : json({ error: "Provider bank account evidence unavailable" }, 503);
    return json({ error: { message: "Xero liability account is missing", code: "credit_liability_unavailable" } }, 409);
  } });
  try {
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => button("Approve and execute upfront financial change"));
    await approve();
    await waitFor(() => financialPanel().textContent.includes("Xero liability account is missing"));
    assert.equal(button("Approve and execute upfront financial change"), undefined);
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => financialPanel().textContent.includes("Provider bank account evidence unavailable"));
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 1);
  } finally { await view.cleanup(); }
});

test("unsupported funding, non-retained terms, mismatched bindings and finance blockers have no fallback execution", async () => {
  for (const variant of ["voucher", "new_term", "tenant", "member", "blocker"]) {
    const evidence = authority();
    if (variant === "voucher") evidence.fundingEvidence.settledFunding[0].kind = "voucher";
    if (variant === "new_term") evidence.calculation.behaviour = "new_term";
    if (variant === "tenant") evidence.tenantId = "other-tenant";
    if (variant === "member") evidence.memberId = "other-member";
    if (variant === "blocker") evidence.settlement.blockers.push("missing_financial_evidence");
    const view = await mount({ data: historyFixture(evidence), post: () => json({ authority: evidence, fingerprint }) });
    try {
      assert.equal(button("Check / recover upfront financial change"), undefined);
      await fill();
      await click(button("Preview upfront financial change"));
      await waitFor(() => button("Save upfront financial authority"));
      assert.equal(button("Save upfront financial authority").disabled, true);
      assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
    } finally { await view.cleanup(); }
  }
});

test("unconfirmed/malformed financial results cannot imply success or retain an execution grant", async () => {
  const view = await mount({ data: historyFixture(), post: payload => json(payload.action === "resume_change" ? life({ nextAction: "execute" }) : { settlement: { state: "settled" }, application: {}, notifications: [] }) });
  try {
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => button("Approve and execute upfront financial change"));
    await approve();
    await waitFor(() => financialPanel().textContent.includes("Financial lifecycle evidence is incomplete"));
    assert.doesNotMatch(financialPanel().textContent, /Upfront membership application confirmed/);
    assert.equal(button("Approve and execute upfront financial change"), undefined);
  } finally { await view.cleanup(); }
});

test("late results and saved confirmation metadata stay isolated across member/tenant switches", async () => {
  window.localStorage.clear();
  for (const scope of ["member", "tenant"]) {
    let resolve;
    const gate = new Promise(done => { resolve = done; });
    const view = await mount({ post: () => gate });
    try {
      await fill();
      await click(button("Preview upfront financial change"));
      await act(async () => view.render(scope === "member" ? "other-member" : "member-upfront", scope === "tenant" ? "other-tenant" : "tenant-finance"));
      await waitFor(() => button("Preview upfront financial change"));
      await act(async () => resolve(json({ authority: authority(), fingerprint })));
      assert.equal(document.querySelector('[data-testid="upfront-financial-preview"]'), null);
      assert.equal(document.querySelector('textarea[id^="financial-reason-"]').value, "");
    } finally { await view.cleanup(); }
  }
});

test("double financial approval clicks submit once; recovery with application confirms only the original authority", async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  let recoveries = 0;
  const view = await mount({ data: historyFixture(), post: payload => payload.action === "resume_change"
    ? json(++recoveries === 1 ? life({ nextAction: "execute" }) : life({ application, notifications: [{ id: "notice", state: "pending" }] }))
    : gate });
  try {
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => button("Approve and execute upfront financial change"));
    await change('textarea[id^="financial-approval-reason-"]', "Approved financial evidence");
    await click(document.querySelector('input[id^="financial-approve-"]'));
    const execute = button("Approve and execute upfront financial change");
    await act(async () => { execute.click(); execute.click(); });
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 1);
    await act(async () => resolve(new Response("<html>Proxy error</html>", { status: 502 })));
    await waitFor(() => financialPanel().textContent.includes("unreadable response"));
    assert.equal(button("Approve and execute upfront financial change"), undefined);
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => financialPanel().textContent.includes("Upfront membership application confirmed"));
    assert.equal(button("Check / recover upfront financial change"), undefined);
    assert.match(financialPanel().textContent, /Notification evidencepending/);
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 1);
  } finally { await view.cleanup(); }
});

test("flat upfront target sends null band and dependent selection resets", async () => {
  const data = fixture();
  data.structures.push({ id: "flat-config", name: "Fellow", pricing_model: "flat", bands: [] });
  const view = await mount({ data });
  try {
    await fill();
    await click(button("Preview upfront financial change"));
    await waitFor(() => button("Save upfront financial authority"));
    await change('select[id^="financial-config-"]', "flat-config");
    assert.equal(document.querySelector('[data-testid="upfront-financial-preview"]'), null);
    assert.equal(document.querySelector('select[id^="financial-band-"]').value, "");
    assert.equal(document.querySelector('select[id^="financial-band-"]').disabled, true);
    await click(button("Preview upfront financial change"));
    await waitFor(() => button("Save upfront financial authority"));
    assert.equal(view.calls.filter(item => item.payload).at(-1).payload.selection.bandId, null);
  } finally { await view.cleanup(); }
});

test("corrupt confirmation metadata fails closed and unavailable recovery cannot create a fresh key", async () => {
  window.localStorage.clear();
  const storageKey = 'membership-upfront-financial-confirm:["tenant-finance","member-upfront"]';
  window.localStorage.setItem(storageKey, "{bad-json");
  let view = await mount();
  try {
    assert.match(financialPanel().textContent, /Confirmation recovery metadata could not be read/);
    assert.equal(button("Preview upfront financial change").disabled, true);
    assert.equal(view.calls.filter(item => item.payload).length, 0);
  } finally { await view.cleanup(); window.localStorage.clear(); }
  const metadata = { idempotencyKey: "original-confirmation-key", fingerprint };
  window.localStorage.setItem(storageKey, JSON.stringify(metadata));
  view = await mount({ post: () => json({ error: "Confirmed authority not found; recovery is unavailable" }, 404) });
  try {
    await click(button("Recover saved financial authority"));
    await waitFor(() => financialPanel().textContent.includes("recovery is unavailable"));
    assert.equal(button("Preview upfront financial change"), undefined);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(storageKey)), metadata);
    assert.ok(view.calls.every(item => !item.payload || item.payload.action === "recover_change"));
  } finally { await view.cleanup(); window.localStorage.clear(); }
});

test("approval policy has no default and explicitly selected eligible credit is sent only after finance approval", async () => {
  const view = await mount({ data: historyFixture(approvalEvidence()), post: payload => json(payload.action === "resume_change"
    ? life({ nextAction: "execute" })
    : life({ execution: { id: "approved-execution", settlement_choice: "credit" }, settlement: { state: "settled", choice: "credit" } })) });
  try {
    assert.match(financialPanel().textContent, /explicit refund or eligible iConnect credit choice required/);
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => document.querySelector('select[id^="financial-treatment-"]'));
    const select = document.querySelector('select[id^="financial-treatment-"]');
    assert.equal(select.required, true);
    assert.equal(select.value, "");
    assert.deepEqual([...select.options].map(option => option.value), ["", "refund", "credit"]);
    assert.equal(button("Approve and execute upfront financial change").disabled, true);
    assert.equal(document.querySelector('textarea[id^="financial-approval-reason-"]').disabled, true);
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
    await change('select[id^="financial-treatment-"]', "credit");
    await approve();
    await waitFor(() => financialPanel().textContent.includes("Locked execution treatment"));
    const execute = view.calls.find(item => item.payload?.action === "execute_change").payload;
    assert.equal(execute.settlementChoice, "credit");
    assert.equal(execute.approve, true);
    assert.match(execute.reason, /Finance verified/);
    assert.match(financialPanel().textContent, /Member credit is not spendable yet/);
  } finally { await view.cleanup(); }
});

test("approval policy keeps refund explicitly selectable when credit flags, binding or optional eligibility checks fail", async () => {
  for (const variant of ["credit-flag", "missing-flag", "binding", "eligibility-error"]) {
    const evidence = approvalEvidence();
    const data = historyFixture(evidence);
    if (variant === "credit-flag") data.memberCreditExecutionAvailable = false;
    if (variant === "missing-flag") delete data.memberCreditExecutionAvailable;
    if (variant === "binding") delete evidence.creditLiabilityBinding;
    if (variant === "eligibility-error") {
      delete evidence.creditLiabilityBinding;
      evidence.creditEligibilityError = "Liability account currency is incompatible with the original payment.";
    }
    const view = await mount({ data, post: payload => json(payload.action === "resume_change"
      ? life({ nextAction: "execute" })
      : life({ execution: { id: "approved-refund", settlement_choice: "refund" }, settlement: { choice: "refund", state: "awaiting_reconciliation" } })) });
    try {
      if (variant === "eligibility-error") assert.match(financialPanel().textContent, /Liability account currency is incompatible/);
      await click(button("Check / recover upfront financial change"));
      await waitFor(() => document.querySelector('select[id^="financial-treatment-"]'));
      const select = document.querySelector('select[id^="financial-treatment-"]');
      assert.equal(select.value, "");
      assert.deepEqual([...select.options].map(option => option.value), ["", "refund"]);
      assert.equal(button("Approve and execute upfront financial change").disabled, true);
      await change('select[id^="financial-treatment-"]', "refund");
      await approve();
      assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 1);
      assert.equal(view.calls.find(item => item.payload?.action === "execute_change").payload.settlementChoice, "refund");
      assert.doesNotMatch(financialPanel().textContent, /Upfront membership application confirmed/);
    } finally { await view.cleanup(); }
  }
});

test("changing an approval-policy treatment clears approval and reason, including clearing back to the placeholder", async () => {
  const view = await mount({ data: historyFixture(approvalEvidence()), post: () => json(life({ nextAction: "execute" })) });
  try {
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => document.querySelector('select[id^="financial-treatment-"]'));
    await change('select[id^="financial-treatment-"]', "credit");
    await change('textarea[id^="financial-approval-reason-"]', "Approval applies only to credit");
    await click(document.querySelector('input[id^="financial-approve-"]'));
    assert.equal(button("Approve and execute upfront financial change").disabled, false);
    await change('select[id^="financial-treatment-"]', "refund");
    assert.equal(document.querySelector('textarea[id^="financial-approval-reason-"]').value, "");
    assert.equal(document.querySelector('input[id^="financial-approve-"]').checked, false);
    assert.equal(button("Approve and execute upfront financial change").disabled, true);
    await change('textarea[id^="financial-approval-reason-"]', "New refund review");
    await click(document.querySelector('input[id^="financial-approve-"]'));
    await change('select[id^="financial-treatment-"]', "");
    assert.equal(document.querySelector('textarea[id^="financial-approval-reason-"]').value, "");
    assert.equal(document.querySelector('input[id^="financial-approve-"]').checked, false);
    assert.equal(button("Approve and execute upfront financial change").disabled, true);
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
  } finally { await view.cleanup(); }
});

test("existing approval-policy execution locks to settlement_choice and cannot be changed through recovery", async () => {
  const execution = { id: "approved-refund", settlement_choice: "refund" };
  const view = await mount({
    data: historyFixture(approvalEvidence(), { execution }),
    post: payload => json(payload.action === "resume_change" ? life({ execution, nextAction: "execute" }) : life({ execution, settlement: { choice: "refund", state: "awaiting_reconciliation" } })),
  });
  try {
    assert.match(financialPanel().textContent, /Locked execution treatment: Record a manual, bank-reconciled cash refund/);
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => document.querySelector('select[id^="financial-treatment-"]'));
    const select = document.querySelector('select[id^="financial-treatment-"]');
    assert.equal(select.disabled, true);
    assert.equal(select.value, "refund");
    assert.deepEqual([...select.options].map(option => option.value), ["", "refund"]);
    await change('select[id^="financial-treatment-"]', "credit");
    assert.equal(document.querySelector('select[id^="financial-treatment-"]').value, "refund");
    await approve();
    assert.equal(view.calls.find(item => item.payload?.action === "execute_change").payload.settlementChoice, "refund");
  } finally { await view.cleanup(); }
});

test("lost execution acknowledgement recovers its locked credit choice and back_credit still requires fresh explicit approval", async () => {
  let resumes = 0;
  let executes = 0;
  const execution = { id: "approved-credit", settlement_choice: "credit" };
  const view = await mount({ data: historyFixture(approvalEvidence()), post: payload => {
    if (payload.action === "resume_change") return json(++resumes === 1
      ? life({ nextAction: "execute" })
      : life({ execution, nextAction: "back_credit" }));
    if (++executes === 1) throw new Error("Approved execution response lost");
    return json(life({ execution, settlement: { choice: "credit", state: "settled" } }));
  } });
  try {
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => document.querySelector('select[id^="financial-treatment-"]'));
    await change('select[id^="financial-treatment-"]', "credit");
    await approve();
    await waitFor(() => financialPanel().textContent.includes("Approved execution response lost"));
    assert.equal(button("Approve and execute upfront financial change"), undefined);
    assert.equal(executes, 1);
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => button("Approve and execute upfront financial change"));
    assert.equal(document.querySelector('select[id^="financial-treatment-"]').value, "credit");
    assert.equal(document.querySelector('select[id^="financial-treatment-"]').disabled, true);
    assert.equal(document.querySelector('textarea[id^="financial-approval-reason-"]').value, "");
    assert.equal(document.querySelector('input[id^="financial-approve-"]').checked, false);
    assert.equal(button("Approve and execute upfront financial change").disabled, true);
    assert.equal(executes, 1);
    await approve();
    assert.equal(executes, 2);
    const requests = view.calls.filter(item => item.payload?.action === "execute_change");
    assert.ok(requests.every(item => item.payload.authorityId === "financial-authority" && item.payload.settlementChoice === "credit" && item.payload.approve === true));
  } finally { await view.cleanup(); }
});

test("locked credit cannot fall back to refund when credit execution is unavailable", async () => {
  const execution = { id: "approved-credit", settlement_choice: "credit" };
  const data = historyFixture(approvalEvidence(), { execution });
  data.memberCreditExecutionAvailable = false;
  const view = await mount({ data, post: () => json(life({ execution, nextAction: "back_credit" })) });
  try {
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => financialPanel().textContent.includes("No permitted execution action"));
    assert.match(financialPanel().textContent, /Locked execution treatment: Issue liability-backed iConnect member credit/);
    assert.match(financialPanel().textContent, /No retained Xero credit or refund fallback/);
    assert.equal(document.querySelector('select[id^="financial-treatment-"]'), null);
    assert.equal(button("Approve and execute upfront financial change"), undefined);
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
  } finally { await view.cleanup(); }
});

test("missing or conflicting execution choices fail closed rather than silently selecting a different treatment", async () => {
  for (const variant of ["missing", "conflicting"]) {
    const execution = { id: "approved-operation", ...(variant === "conflicting" ? { settlement_choice: "refund" } : {}) };
    const view = await mount({
      data: historyFixture(approvalEvidence(), { execution }),
      post: () => json(life({ execution: variant === "conflicting" ? { ...execution, settlement_choice: "credit" } : execution, nextAction: "execute" })),
    });
    try {
      await click(button("Check / recover upfront financial change"));
      await waitFor(() => financialPanel().textContent.includes("No permitted execution action"));
      assert.match(financialPanel().textContent, /Execution treatment evidence is missing or conflicts/);
      assert.equal(document.querySelector('select[id^="financial-treatment-"]'), null);
      assert.equal(button("Approve and execute upfront financial change"), undefined);
      assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
    } finally { await view.cleanup(); }
  }
});

test("settlement evidence without its execution cannot unlock a new approval-policy choice", async () => {
  const settlement = { choice: "credit", state: "reserved" };
  const view = await mount({ data: historyFixture(approvalEvidence(), { settlement }), post: () => json(life({ settlement, nextAction: "execute" })) });
  try {
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => financialPanel().textContent.includes("No permitted execution action"));
    assert.match(financialPanel().textContent, /Execution treatment evidence is missing or conflicts/);
    assert.equal(document.querySelector('select[id^="financial-treatment-"]'), null);
    assert.equal(button("Approve and execute upfront financial change"), undefined);
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
  } finally { await view.cleanup(); }
});

test("losing optional credit capability invalidates an unexecuted selection and does not silently choose refund", async () => {
  const view = await mount({ data: historyFixture(approvalEvidence()), post: () => json(life({ nextAction: "execute" })) });
  try {
    await click(button("Check / recover upfront financial change"));
    await waitFor(() => document.querySelector('select[id^="financial-treatment-"]'));
    await change('select[id^="financial-treatment-"]', "credit");
    await change('textarea[id^="financial-approval-reason-"]', "Credit approval before capability changed");
    await click(document.querySelector('input[id^="financial-approve-"]'));
    await act(async () => view.client.setQueryData(["member-amendments", "tenant-finance", "member-upfront"], previous => ({ ...previous, memberCreditExecutionAvailable: false })));
    await waitFor(() => document.querySelector('select[id^="financial-treatment-"]').value === "");
    assert.equal(document.querySelector('textarea[id^="financial-approval-reason-"]').value, "");
    assert.equal(document.querySelector('input[id^="financial-approve-"]').checked, false);
    assert.equal(button("Approve and execute upfront financial change").disabled, true);
    assert.deepEqual([...document.querySelector('select[id^="financial-treatment-"]').options].map(option => option.value), ["", "refund"]);
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
  } finally { await view.cleanup(); }
});
