import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Isolated mounted coverage for the CRM "Cancel membership" action. No live calls.
// node scripts/run-isolated-tests.mjs node --test client/src/components/MemberCancelMembership.mounted.test.mjs
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  stdin: { contents: 'export { default, paymentStopText } from "./client/src/components/MemberCancelMembership.jsx";', resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "isolated-cancel-membership",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\/lib\/memberChangeRequests$/ }, () => ({ path: `${process.cwd()}/client/src/lib/memberChangeRequests.js` }));
      builder.onResolve({ filter: /^@\/components\/MemberCancelUnpaidMembership$/ }, () => ({ path: `${process.cwd()}/client/src/components/MemberCancelUnpaidMembership.jsx` }));
      builder.onResolve({ filter: /^@\// }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        loader: "js",
        contents: path.endsWith("adminFetch")
          ? "export const adminFetch = (url, options = {}, tenantId) => globalThis.fetch(url, {...options, headers:{...options.headers, 'X-Tenant-Id':tenantId}});"
          : path.endsWith("useFormAlerts")
            ? "export const useFormAlertTenant = () => globalThis.cancellationScope;"
            : `import React from "react";
              const wrap = tag => ({children, variant, size, open, onOpenChange, ...props}) => React.createElement(tag, props, children);
              export const Card = wrap("div"), CardHeader = wrap("div"), CardTitle = wrap("h2"), CardContent = wrap("div");
              export const Button = wrap("button"), Label = wrap("label"), Textarea = wrap("textarea");
              export const Dialog = wrap("div"), DialogContent = wrap("section"), DialogHeader = wrap("div"), DialogTitle = wrap("h3"), DialogDescription = wrap("p"), DialogFooter = wrap("div");`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/cancel-membership-mounted.cjs`);
compiled.filename = `${process.cwd()}/cancel-membership-mounted.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const { QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; delete globalThis.cancellationScope; dom.window.close(); });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const eligible = (extra = {}) => ({
  eligible: true, blocker: null, timing: "end_of_term", latest: null,
  current: { id: "h1", tierLabel: "Flat Rate", termStartDate: "2026-10-24", renewalDate: "2027-10-24", paymentMethod: "card_monthly", recurring: true },
  ...extra,
});
const preview = (extra = {}) => ({
  fingerprint: "a".repeat(64),
  authority: {
    effectiveDate: "2027-10-24", timing: "end_of_term", financialReviewReason: "monthly",
    calculation: { currency: "GBP", paymentDueMinor: null },
    policySnapshot: { policy: { cancellationUnusedValue: "none" } },
    planSnapshot: { id: "p" }, providerPrepared: { authority: { provider: "stripe" } }, ...extra,
  },
});
const testId = id => document.querySelector(`[data-testid="${id}"]`);
async function click(element) {
  assert.ok(element, "element exists"); assert.equal(element.disabled, false);
  await act(async () => element.click());
}
async function waitFor(predicate) {
  for (let count = 0; count < 80; count++) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  assert.fail("Timed out waiting for cancel membership UI");
}
async function type(id, value) {
  const input = testId(id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function mount({ status = eligible(), unpaidStatus = { eligible: false }, post = () => json(preview()), scope = {} } = {}) {
  const calls = [], invalidations = [];
  globalThis.cancellationScope = { status: "ready", tenantId: "tenant-safe", scopeKey: "scope", assertCurrent() {}, ...scope };
  let currentStatus = status;
  globalThis.fetch = async (url, options = {}) => {
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, payload, tenantId: options.headers?.["X-Tenant-Id"] });
    if (payload) return post(payload);
    if (url.includes("action=unpaid_cancellation_status")) return json(typeof unpaidStatus === "function" ? unpaidStatus() : unpaidStatus);
    assert.match(url, /action=cancellation_status/);
    return typeof currentStatus === "function" ? currentStatus() : json(currentStatus);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = options => { invalidations.push(options.queryKey); return invalidate(options); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(QueryClientProvider, { client },
    React.createElement(Component, { memberId: "member-safe", tenantId: "tenant-safe" }))));
  return {
    calls, invalidations, container, setStatus(value) { currentStatus = value; },
    async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); },
  };
}

test("hidden for admins without finance access or a different tenant", async () => {
  for (const scope of [{ status: "error" }, { status: "loading" }, { tenantId: "other-tenant" }]) {
    const mounted = await mount({ scope });
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      assert.equal(testId("card-member-cancel-membership"), null);
      assert.equal(mounted.calls.length, 0);
    } finally { await mounted.cleanup(); }
  }
});

test("ineligible memberships explain why instead of offering the button", async () => {
  for (const [blocker, pattern] of [["organisation_funded", /organisation's record/], ["no_current_membership", /no current membership/],
    ["already_cancelled", /already been cancelled/]]) {
    const mounted = await mount({ status: { eligible: false, blocker, latest: null, current: null } });
    try {
      await waitFor(() => testId("text-cancel-membership-blocked"));
      assert.match(testId("text-cancel-membership-blocked").textContent, pattern);
      assert.equal(testId("button-cancel-membership"), null);
    } finally { await mounted.cleanup(); }
  }
});

test("reason, review and explicit confirmation are required; confirm sends one bound approval", async () => {
  const mounted = await mount({
    post: payload => payload.action === "preview_cancellation" ? json(preview())
      : json({ record: { id: "c1", effective_date: "2027-10-24", timing: "end_of_term", access_ended_at: null, authority: { providerPrepared: { authority: { provider: "stripe" } } } }, provider: null }),
  });
  try {
    await waitFor(() => testId("button-cancel-membership"));
    assert.match(mounted.container.textContent, /Flat Rate membership/);
    assert.match(mounted.container.textContent, /end of the current membership year/);
    await click(testId("button-cancel-membership"));
    assert.equal(testId("button-review-cancellation").disabled, true);
    await type("input-cancel-membership-reason", "Member asked to leave and be deleted");
    await click(testId("button-review-cancellation"));
    await waitFor(() => testId("cancel-membership-preview"));
    const summary = testId("cancel-membership-preview").textContent;
    assert.match(summary, /monthly card payments with Stripe will be stopped on 24\/10\/2027/);
    assert.match(summary, /To be worked out by finance/);
    assert.match(summary, /No refund or credit is due/);
    assert.equal(testId("button-confirm-cancel-membership").disabled, true);
    await click(testId("checkbox-confirm-cancel-membership"));
    await click(testId("button-confirm-cancel-membership"));
    await waitFor(() => testId("cancel-membership-outcome"));
    assert.match(testId("cancel-membership-outcome").textContent, /Cancellation scheduled\. Access continues until 24\/10\/2027/);
    assert.match(testId("cancel-membership-outcome").textContent, /will be stopped when access ends/);
    const confirms = mounted.calls.filter(call => call.payload?.action === "confirm_cancellation");
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0].payload.approve, true);
    assert.equal(confirms[0].payload.fingerprint, "a".repeat(64));
    assert.equal(confirms[0].payload.selection.reason, "Member asked to leave and be deleted");
    assert.equal(confirms[0].payload.memberId, "member-safe");
    assert.equal(confirms[0].tenantId, "tenant-safe");
    assert.ok(mounted.invalidations.some(key => key[0] === "member-deletion-billing"));
  } finally { await mounted.cleanup(); }
});

test("a lost confirmation response is recovered by key, never re-sent blindly", async () => {
  let confirmCount = 0, recovered = null;
  const mounted = await mount({
    post: payload => {
      if (payload.action === "preview_cancellation") return json(preview({ timing: "immediate", effectiveDate: "2026-11-25", providerPrepared: { authority: { provider: "gocardless" } } }));
      if (payload.action === "confirm_cancellation") { confirmCount++; return json({ error: "Gateway timeout" }, 504); }
      recovered = payload;
      return json({ record: { id: "c1", effective_date: "2026-11-25", timing: "immediate", access_ended_at: "2026-11-25T10:00:00Z", authority: { providerPrepared: { authority: { provider: "gocardless" } } } }, provider: { state: "stopped" } });
    },
  });
  try {
    await waitFor(() => testId("button-cancel-membership"));
    await click(testId("button-cancel-membership"));
    await type("input-cancel-membership-reason", "Leaving");
    await click(testId("button-review-cancellation"));
    await waitFor(() => testId("checkbox-confirm-cancel-membership"));
    assert.match(testId("cancel-membership-preview").textContent, /mandate itself stays in place/);
    await click(testId("checkbox-confirm-cancel-membership"));
    await click(testId("button-confirm-cancel-membership"));
    await waitFor(() => testId("button-cancel-membership-check"));
    assert.equal(testId("button-confirm-cancel-membership"), null);
    await click(testId("button-cancel-membership-check"));
    await waitFor(() => testId("cancel-membership-outcome"));
    assert.equal(confirmCount, 1);
    assert.equal(recovered.action, "recover_cancellation");
    assert.match(recovered.key, /.{8,}/);
    assert.equal(recovered.fingerprint, "a".repeat(64));
    assert.match(testId("cancel-membership-outcome").textContent, /access has ended/);
    assert.match(testId("cancel-membership-outcome").textContent, /stopped with GoCardless/);
  } finally { await mounted.cleanup(); }
});

test("scheduled cancellation can be withdrawn with a reason", async () => {
  const scheduled = { id: "c9", effective_date: "2027-10-24", timing: "end_of_term", access_ended_at: null, provider: "stripe", providerState: "not_started" };
  const mounted = await mount({
    status: { eligible: false, blocker: "cancellation_scheduled", latest: scheduled, current: eligible().current },
    post: payload => json({ record: { ...scheduled, withdrawn_at: "2026-11-25T10:00:00Z" } }),
  });
  try {
    await waitFor(() => testId("cancel-membership-scheduled"));
    assert.match(testId("cancel-membership-scheduled").textContent, /Access continues until 24\/10\/2027/);
    assert.equal(testId("button-cancel-membership"), null);
    await click(testId("button-withdraw-cancellation"));
    assert.equal(testId("button-confirm-withdraw-cancellation").disabled, true);
    await type("input-withdraw-cancellation-reason", "Member changed their mind");
    await click(testId("button-confirm-withdraw-cancellation"));
    await waitFor(() => /has been withdrawn/.test(testId("dialog-withdraw-cancellation").textContent));
    const call = mounted.calls.find(item => item.payload?.action === "withdraw_cancellation");
    assert.deepEqual({ id: call.payload.id, reason: call.payload.reason }, { id: "c9", reason: "Member changed their mind" });
  } finally { await mounted.cleanup(); }
});

test("applied cancellation with an unconfirmed payment stop offers a recovery check", async () => {
  const applied = { id: "c5", effective_date: "2026-11-25", timing: "immediate", access_ended_at: "2026-11-25T10:00:00Z", provider: "stripe", providerState: "uncertain" };
  const mounted = await mount({
    status: { eligible: false, blocker: "already_cancelled", latest: applied, current: null },
    post: () => json({ record: { ...applied, authority: { providerPrepared: { authority: { provider: "stripe" } } } }, provider: { state: "stopped" } }),
  });
  try {
    await waitFor(() => testId("cancel-membership-applied"));
    assert.match(testId("cancel-membership-applied").textContent, /couldn't confirm/);
    await click(testId("button-check-payment-stop"));
    await waitFor(() => /stopped with Stripe/.test(mounted.container.textContent));
    assert.equal(mounted.calls.find(item => item.payload)?.payload.id, "c5");
  } finally { await mounted.cleanup(); }
  assert.match(compiled.exports.paymentStopText("gocardless", "stopped"), /stopped with GoCardless/);
  assert.match(compiled.exports.paymentStopText(null, "not_required"), /No recurring payments/);
});

test("an unpaid invoice purchase can be reviewed and cancelled from the existing membership card", async () => {
  let released = false;
  const mounted = await mount({
    status: { eligible: false, blocker: "no_current_membership" },
    unpaidStatus: () => released ? { completed: true } : { eligible: true, invoiceNumber: "INV-9748" },
    post: payload => {
      if (payload.action === "preview_unpaid_cancellation") return json({
        fingerprint: "b".repeat(64), invoiceNumber: "INV-9748", grossMinor: 12800, currency: "GBP",
      });
      assert.equal(payload.action, "confirm_unpaid_cancellation");
      assert.equal(payload.approve, true);
      assert.equal(payload.fingerprint, "b".repeat(64));
      assert.equal(payload.reason, "Member selected invoice by mistake");
      released = true; return json({ state: "released" });
    },
  });
  try {
    await waitFor(() => testId("button-cancel-unpaid-membership"));
    assert.equal(testId("text-cancel-membership-blocked"), null);
    await click(testId("button-cancel-unpaid-membership"));
    assert.equal(testId("button-submit-unpaid-cancellation").disabled, true);
    await type("input-unpaid-cancellation-reason", "Member selected invoice by mistake");
    await click(testId("button-submit-unpaid-cancellation"));
    await waitFor(() => /£128/.test(mounted.container.textContent));
    assert.match(mounted.container.textContent, /no payments or credits/);
    await click(testId("button-submit-unpaid-cancellation"));
    await waitFor(() => /History is retained/.test(mounted.container.textContent));
    assert.match(mounted.container.textContent, /\/portal/);
    assert.ok(mounted.invalidations.some(key => key[0] === "member-membership"));
    assert.equal(mounted.calls.filter(call => call.payload?.action === "confirm_unpaid_cancellation").length, 1);
  } finally { await mounted.cleanup(); }
});

test("an uncertain unpaid invoice cancellation exposes recovery rather than a second cancellation", async () => {
  const mounted = await mount({
    status: { eligible: false, blocker: "no_current_membership" },
    unpaidStatus: { pending: true, operationId: "saved-operation" },
    post: payload => {
      assert.equal(payload.action, "recover_unpaid_cancellation");
      assert.equal(payload.operationId, "saved-operation");
      return json({ state: "released" });
    },
  });
  try {
    await waitFor(() => testId("button-recover-unpaid-cancellation"));
    assert.equal(testId("button-cancel-unpaid-membership"), null);
    await click(testId("button-recover-unpaid-cancellation"));
    await waitFor(() => /History is retained/.test(mounted.container.textContent));
  } finally { await mounted.cleanup(); }
});

test("a lost unpaid cancellation confirmation closes approval and offers the saved recovery", async () => {
  let pending = false;
  const mounted = await mount({
    status: { eligible: false, blocker: "no_current_membership" },
    unpaidStatus: () => pending ? { pending: true, operationId: "saved-operation" } : { eligible: true },
    post: payload => {
      if (payload.action === "preview_unpaid_cancellation") return json({
        fingerprint: "c".repeat(64), grossMinor: 12800, currency: "GBP",
      });
      pending = true; return json({ error: "Invoice cancellation needs checking" }, 503);
    },
  });
  try {
    await waitFor(() => testId("button-cancel-unpaid-membership"));
    await click(testId("button-cancel-unpaid-membership"));
    await type("input-unpaid-cancellation-reason", "Incorrect payment choice");
    await click(testId("button-submit-unpaid-cancellation"));
    await waitFor(() => /£128/.test(mounted.container.textContent));
    await click(testId("button-submit-unpaid-cancellation"));
    await waitFor(() => testId("button-recover-unpaid-cancellation"));
    assert.equal(testId("button-submit-unpaid-cancellation"), null);
    assert.equal(testId("button-cancel-unpaid-membership"), null);
    assert.match(mounted.container.textContent, /Invoice cancellation needs checking/);
  } finally { await mounted.cleanup(); }
});
