import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Every transport is stubbed before mounting. No live requests or provider writes.
// node scripts/run-isolated-tests.mjs node --test client/src/components/MemberMonthlyMembershipAmendments.mounted.test.mjs
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
    name: "monthly-isolated-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^\.\/MemberChangeRequestReview$/ }, () => ({ path: "request-review", namespace: "review-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "review-fixture" }, () => ({ contents: "export default function Review(){return null;}", loader: "js" }));
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
const compiled = new Module(`${process.cwd()}/monthly-mounted-isolated.cjs`);
compiled.filename = `${process.cwd()}/monthly-mounted-isolated.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const { QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const authority = (version = 3) => ({
  memberId: "member-monthly", action: "change",
  request: { reason: "Professional qualification verified" },
  sourceSnapshot: {
    id: "source-purchase", term_start_date: "2026-04-17", term_end_date: "2027-04-16", membership_renewal_date: "2027-04-17",
    commitment_snapshot: { payment_frequency: "monthly", config: { name: "Associate" } },
  },
  targetSnapshot: { id: "target-config", name: "Professional", pricing_model: "tiered" },
  targetBandSnapshot: { id: "standard", label: "Standard" },
  calculation: {
    version, behaviour: "retain_term", currency: "GBP", effectiveDate: "2027-01-17",
    newTerm: { renewalDate: "2027-04-17" },
    ...(version === 3 ? { currentMonthlyPriceMinor: 2843, futureObligationMinor: null } : { futureObligationMinor: 8529 }),
    blockers: ["provider_schedule_coordination_required"], finance: { blockers: [] },
  },
  monthlyExecution: { version: 1, providerTarget: {}, providerAuthority: {} },
});
const fixture = () => ({
  current: authority().sourceSnapshot,
  structures: [{ id: "target-config", name: "Professional", pricing_model: "tiered", bands: [{ id: "standard", label: "Standard" }] }],
  history: [], monthlyChanges: [], monthlyExecutionAvailable: true,
  // Legacy upfront blockers must not suppress the new monthly path.
  capabilities: { preview: false, create: false, providerAmendment: false },
  blockers: [{ code: "MONTHLY_UNSUPPORTED", message: "Legacy monthly path unavailable" }],
});
const application = { operationId: "operation-verified", effectiveDate: "2027-01-17", expiresOn: "2027-04-17" };
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
  assert.fail("Timed out waiting for mounted monthly UI");
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
async function fill() {
  await change('select[id^="monthly-config-"]', "target-config");
  await change('select[id^="monthly-band-"]', "standard");
  await change('input[id^="monthly-date-"]', "2027-01-17");
  await change('textarea[id^="monthly-reason-"]', "Professional qualification verified");
}
async function mount({ data = fixture(), post, get } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.match(url, /^\/api\/membership\/member-amendments/);
    assert.equal(options.credentials, "include");
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ payload, tenantId: options.headers["X-Tenant-Id"] });
    return payload ? post ? post(payload) : json({ authority: authority(), fingerprint: "fp-monthly" }) : get ? get() : json(data);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (memberId = "member-monthly", tenantId = "tenant-finance") => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Component, { memberId, tenantId })));
  await act(async () => render());
  await waitFor(() => container.textContent.includes("Retained-term monthly change"));
  return { calls, container, render, async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}
const historyFixture = (version = 3, operation = null) => {
  const data = fixture();
  data.monthlyChanges = [{ id: "authority-saved", authority: authority(version), operation, notification: { status: "pending" } }];
  return data;
};

test("legacy blockers do not gate monthly preview; v3 shows prospective rate, never annualises it", async () => {
  window.localStorage.clear();
  const view = await mount();
  try {
    assert.ok(button("Preview monthly change"));
    assert.equal(button("Preview"), undefined);
    await fill();
    await click(button("Preview monthly change"));
    await waitFor(() => button("Save monthly authority"));
    assert.deepEqual(view.calls.find(item => item.payload).payload, {
      action: "preview_change", memberId: "member-monthly",
      selection: { configId: "target-config", bandId: "standard", effectiveDate: "2027-01-17", reason: "Professional qualification verified", action: "change" },
    });
    const preview = document.querySelector('[data-testid="monthly-preview"]').textContent;
    assert.match(preview, /Current prospective monthly price: £28.43/);
    assert.match(preview, /Original renewal boundary: 2027-04-17/);
    assert.doesNotMatch(preview, /£341.16|Future fixed-term obligation/);
    await change('textarea[id^="monthly-reason-"]', "Updated evidence");
    assert.equal(document.querySelector('[data-testid="monthly-preview"]'), null);
    assert.ok(view.calls.every(item => !item.payload || item.payload.action === "preview_change"));
  } finally { await view.cleanup(); }
});

test("uncertain confirmation survives remount with exact payload/key; saving never executes", async () => {
  window.localStorage.clear();
  const confirmations = [];
  const post = payload => {
    if (payload.action === "preview_change") return json({ authority: authority(), fingerprint: "fp-monthly" });
    confirmations.push(payload);
    if (confirmations.length === 1) throw new Error("Confirmation connection lost");
    return json({ record: { id: "authority-confirmed", authority: authority() } });
  };
  let view = await mount({ post });
  try {
    await fill();
    await click(button("Preview monthly change"));
    await waitFor(() => button("Save monthly authority"));
    await click(button("Save monthly authority"));
    await waitFor(() => view.container.textContent.includes("Confirmation connection lost"));
    assert.equal(document.querySelector('fieldset').disabled, true);
    await view.cleanup();
    view = await mount({ post });
    await waitFor(() => button("Retry saved monthly confirmation"));
    assert.equal(button("Preview monthly change"), undefined);
    await click(button("Retry saved monthly confirmation"));
    await waitFor(() => view.container.textContent.includes("Monthly authority saved"));
    assert.equal(confirmations.length, 2);
    assert.deepEqual(confirmations[0], confirmations[1]);
    assert.ok(confirmations[0].idempotencyKey);
    assert.equal(confirmations[0].fingerprint, "fp-monthly");
    assert.equal(button("Approve and execute monthly change"), undefined);
    assert.ok(view.calls.every(item => !item.payload || item.payload.action === "confirm_change"));
  } finally { await view.cleanup(); window.localStorage.clear(); }
});

test("execution is hidden without an exact availability grant, but server notice and history remain", async () => {
  for (const available of [false, undefined, "true"]) {
    const data = historyFixture();
    data.monthlyExecutionAvailable = available;
    data.monthlyExecutionNotice = "Provider recovery is not deployed on this server.";
    const view = await mount({ data });
    try {
      assert.match(view.container.textContent, /Provider recovery is not deployed/);
      assert.match(view.container.textContent, /Authority authority-saved/);
      assert.equal(button("Check / recover monthly operation"), undefined);
      assert.equal(button("Approve and execute monthly change"), undefined);
      assert.equal(view.calls.filter(item => item.payload).length, 0);
    } finally { await view.cleanup(); }
  }
});

test("recovery not_started never executes; execution needs reason and explicit approval", async () => {
  const view = await mount({ data: historyFixture(), post: payload => {
    if (payload.action === "resume_change") return json({ state: "not_started", nextAction: "execute" });
    assert.equal(payload.action, "execute_change");
    return json({ application });
  } });
  try {
    assert.equal(button("Approve and execute monthly change"), undefined);
    await click(button("Check / recover monthly operation"));
    await waitFor(() => button("Approve and execute monthly change"));
    assert.equal(button("Approve and execute monthly change").disabled, true);
    await change('textarea[id^="monthly-approval-reason-"]', "   ");
    await click(document.querySelector('input[type="checkbox"]'));
    assert.equal(button("Approve and execute monthly change").disabled, true);
    await change('textarea[id^="monthly-approval-reason-"]', "Verified finance evidence");
    await click(button("Approve and execute monthly change"));
    await waitFor(() => view.container.textContent.includes("Membership application confirmed"));
    assert.deepEqual(view.calls.filter(item => item.payload).map(item => item.payload), [
      { action: "resume_change", memberId: "member-monthly", authorityId: "authority-saved" },
      { action: "execute_change", memberId: "member-monthly", authorityId: "authority-saved", approve: true, reason: "Verified finance evidence" },
    ]);
    assert.ok(view.calls.every(item => item.tenantId === "tenant-finance"));
  } finally { await view.cleanup(); }
});

test("fixed v2 displays future obligation and actual execution quote; finalization needs fresh approval", async () => {
  const operation = {
    id: "operation-verified", state: "provider_applied",
    prepared: { quote: { currency: "GBP", amountMinor: 2843, collectionDates: ["2027-01-17", "2027-02-17", "2027-03-17"] } },
  };
  const view = await mount({ data: historyFixture(2, operation), post: () => json({ operation, nextAction: "approve_finalization" }) });
  try {
    assert.match(view.container.textContent, /Future fixed-term obligation: £85.29/);
    assert.match(view.container.textContent, /Execution quote: £28.43 per collection/);
    assert.doesNotMatch(view.container.textContent, /Membership application confirmed/);
    await click(button("Check / recover monthly operation"));
    await waitFor(() => button("Approve monthly finalization"));
    assert.equal(button("Approve monthly finalization").disabled, true);
    assert.ok(view.calls.every(item => !item.payload || item.payload.action === "resume_change"));
  } finally { await view.cleanup(); }
});

test("uncertain execution forces recovery, including after reload; no new provider attempt is automatic", async () => {
  const data = historyFixture();
  const post = payload => {
    if (payload.action === "resume_change") return json({ state: "not_started", nextAction: "execute" });
    throw new Error("Provider response lost");
  };
  let view = await mount({ data, post });
  try {
    await click(button("Check / recover monthly operation"));
    await waitFor(() => button("Approve and execute monthly change"));
    await change('textarea[id^="monthly-approval-reason-"]', "Evidence reviewed");
    await click(document.querySelector('input[type="checkbox"]'));
    await click(button("Approve and execute monthly change"));
    await waitFor(() => view.container.textContent.includes("Provider response lost"));
    assert.equal(button("Approve and execute monthly change"), undefined);
    assert.ok(button("Check / recover monthly operation"));
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 1);
    await view.cleanup();
    view = await mount({ data, post });
    assert.equal(button("Approve and execute monthly change"), undefined);
    assert.equal(view.calls.filter(item => item.payload).length, 0);
  } finally { await view.cleanup(); }
});

test("unresolved or aborted operations never imply completion or offer finalization", async () => {
  for (const state of ["uncertain", "executing", "aborted", "finalized"]) {
    const operation = { id: "operation-pending", state };
    const view = await mount({ data: historyFixture(3, operation), post: () => json({ operation, nextAction: "approve_finalization" }) });
    try {
      await click(button("Check / recover monthly operation"));
      await waitFor(() => view.container.textContent.includes("Provider outcome is unresolved"));
      assert.equal(button("Approve monthly finalization"), undefined);
      assert.equal(button("Approve and execute monthly change"), undefined);
      assert.doesNotMatch(view.container.textContent, /Membership application confirmed/);
    } finally { await view.cleanup(); }
  }
});

test("recovery only reports completion with concrete application evidence", async () => {
  for (const result of [{ application }, { application: {} }, { operation: { state: "finalized" } }]) {
    const view = await mount({ data: historyFixture(), post: () => json(result) });
    try {
      await click(button("Check / recover monthly operation"));
      if (result.application?.operationId) {
        await waitFor(() => view.container.textContent.includes("Membership application confirmed"));
        assert.equal(button("Check / recover monthly operation"), undefined);
      } else {
        await waitFor(() => view.container.textContent.includes("No membership application was confirmed"));
        assert.doesNotMatch(view.container.textContent, /Membership application confirmed/);
      }
    } finally { await view.cleanup(); }
  }
});

test("finance errors and unsupported or blocked calculation evidence fail closed", async () => {
  for (const variant of ["error", "unsupported", "finance"]) {
    const evidence = authority();
    if (variant === "unsupported") evidence.calculation.version = 9;
    if (variant === "finance") evidence.calculation.finance.blockers = ["Unreconciled prepaid cash"];
    const view = await mount({ post: () => variant === "error" ? json({ error: { message: "Receipts could not be reconciled", code: "monthly_quote_unavailable" } }, 422) : json({ authority: evidence, fingerprint: "fp-blocked" }) });
    try {
      await fill();
      await click(button("Preview monthly change"));
      await waitFor(() => variant === "error" ? view.container.textContent.includes("Receipts could not be reconciled") : button("Save monthly authority"));
      if (variant === "error") assert.equal(button("Save monthly authority"), undefined);
      else assert.equal(button("Save monthly authority").disabled, true);
      if (variant === "finance") assert.match(view.container.textContent, /Unreconciled prepaid cash/);
      assert.equal(view.calls.filter(item => item.payload?.action === "confirm_change").length, 0);
    } finally { await view.cleanup(); }
  }
});

test("flat target sends bandId null and changing target invalidates preview and dependent band", async () => {
  const data = fixture();
  data.structures.push({ id: "flat-config", name: "Fellow", pricing_model: "flat", bands: [] });
  const view = await mount({ data });
  try {
    await fill();
    await click(button("Preview monthly change"));
    await waitFor(() => button("Save monthly authority"));
    await change('select[id^="monthly-config-"]', "flat-config");
    assert.equal(document.querySelector('[data-testid="monthly-preview"]'), null);
    assert.equal(document.querySelector('select[id^="monthly-band-"]').value, "");
    assert.equal(document.querySelector('select[id^="monthly-band-"]').disabled, true);
    await click(button("Preview monthly change"));
    await waitFor(() => button("Save monthly authority"));
    assert.equal(view.calls.filter(item => item.payload).at(-1).payload.selection.bandId, null);
  } finally { await view.cleanup(); }
});

test("late preview cannot cross member or tenant boundaries", async () => {
  for (const scope of ["member", "tenant"]) {
    let resolve;
    const gate = new Promise(done => { resolve = done; });
    const view = await mount({ post: () => gate });
    try {
      await fill();
      await click(button("Preview monthly change"));
      await act(async () => view.render(scope === "member" ? "member-other" : "member-monthly", scope === "tenant" ? "tenant-other" : "tenant-finance"));
      await waitFor(() => button("Preview monthly change"));
      await act(async () => resolve(json({ authority: authority(), fingerprint: "late" })));
      assert.equal(document.querySelector('[data-testid="monthly-preview"]'), null);
      assert.equal(document.querySelector('textarea[id^="monthly-reason-"]').value, "");
    } finally { await view.cleanup(); }
  }
});

test("unreadable and rejected confirmation responses retain the original fingerprint/key without creating a new authority", async () => {
  window.localStorage.clear();
  let confirms = 0;
  const view = await mount({ post: payload => {
    if (payload.action === "preview_change") return json({ authority: authority(), fingerprint: "fp-original" });
    return ++confirms === 1
      ? new Response("<html>Gateway failure</html>", { status: 502 })
      : json({ error: { message: "Source evidence changed", code: "change_authority_conflict" } }, 409);
  } });
  try {
    await fill();
    await click(button("Preview monthly change"));
    await waitFor(() => button("Save monthly authority"));
    await click(button("Save monthly authority"));
    await waitFor(() => view.container.textContent.includes("unreadable response"));
    await click(button("Retry saved monthly confirmation"));
    await waitFor(() => view.container.textContent.includes("Source evidence changed"));
    const requests = view.calls.filter(item => item.payload?.action === "confirm_change");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].payload, requests[1].payload);
    assert.equal(button("Preview monthly change"), undefined);
    assert.equal(document.querySelector("fieldset").disabled, true);
    assert.doesNotMatch(view.container.textContent, /Monthly authority saved/);
  } finally { await view.cleanup(); window.localStorage.clear(); }
});

test("corrupt recovery storage blocks new authorities instead of discarding the uncertain key", async () => {
  window.localStorage.clear();
  window.localStorage.setItem('membership-monthly-confirm:["tenant-finance","member-monthly"]', "{bad-json");
  const view = await mount();
  try {
    assert.match(view.container.textContent, /Saved confirmation recovery could not be read/);
    assert.equal(button("Preview monthly change").disabled, true);
    assert.equal(view.calls.filter(item => item.payload).length, 0);
  } finally { await view.cleanup(); window.localStorage.clear(); }
});

test("missing execution envelope and server finance errors are explicit, not fallback execution", async () => {
  const data = historyFixture();
  delete data.monthlyChanges[0].authority.monthlyExecution;
  let view = await mount({ data });
  try {
    assert.match(view.container.textContent, /confirmed monthly execution or member-binding evidence is missing/);
    assert.equal(button("Check / recover monthly operation"), undefined);
  } finally { await view.cleanup(); }
  view = await mount({ data: historyFixture(), post: () => json({ error: "Finance provider evidence could not be read", code: "monthly_execution_conflict" }, 409) });
  try {
    await click(button("Check / recover monthly operation"));
    await waitFor(() => view.container.textContent.includes("Finance provider evidence could not be read"));
    assert.equal(button("Approve and execute monthly change"), undefined);
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 0);
  } finally { await view.cleanup(); }
});

test("double approval clicks submit once and late execution cannot populate another member", async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const view = await mount({ data: historyFixture(), post: payload => payload.action === "resume_change" ? json({ state: "not_started", nextAction: "execute" }) : gate });
  try {
    await click(button("Check / recover monthly operation"));
    await waitFor(() => button("Approve and execute monthly change"));
    await change('textarea[id^="monthly-approval-reason-"]', "Finance verified the retained boundary");
    await click(document.querySelector('input[type="checkbox"]'));
    const execute = button("Approve and execute monthly change");
    await act(async () => { execute.click(); execute.click(); });
    assert.equal(view.calls.filter(item => item.payload?.action === "execute_change").length, 1);
    await act(async () => view.render("member-other"));
    await waitFor(() => button("Preview monthly change"));
    await act(async () => resolve(json({ application })));
    assert.doesNotMatch(view.container.textContent, /Membership application confirmed/);
    assert.equal(button("Approve and execute monthly change"), undefined);
  } finally { await view.cleanup(); }
});
