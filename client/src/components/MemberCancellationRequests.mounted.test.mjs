import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Isolated mounted regression coverage. Every transport is replaced; no live calls.
// node scripts/run-isolated-tests.mjs node --test client/src/components/MemberCancellationRequests.mounted.test.mjs
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  stdin: { contents: 'export { default } from "./client/src/components/MemberCancellationRequests.jsx"; export { default as Panel } from "./client/src/components/MemberMembershipAmendments.jsx";', resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "isolated-administrator-cancellations",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^\.\/MemberChangeRequestReview$/ }, () => ({ path: "review", namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default function Review(){return null;}", loader: "js" }));
      builder.onResolve({ filter: /^@\/lib\/memberChangeRequests$/ }, () => ({ path: `${process.cwd()}/client/src/lib/memberChangeRequests.js` }));
      builder.onResolve({ filter: /^@\// }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        loader: "js",
        contents: path.endsWith("adminFetch")
          ? "export const adminFetch = (url, options = {}, tenantId) => globalThis.fetch(url, {...options, credentials:'include', headers:{...options.headers, 'X-Tenant-Id':tenantId}});"
          : path.endsWith("useFormAlerts")
            ? "export const useFormAlertTenant = () => globalThis.cancellationScope;"
            : `import React from "react";
              const wrap = tag => ({children, variant, size, ...props}) => React.createElement(tag, props, children);
              export const Card = wrap("div"), CardHeader = wrap("div"), CardTitle = wrap("h2"), CardContent = wrap("div");
              export const Button = wrap("button"), Badge = wrap("span"), Input = wrap("input"), Label = wrap("label"), Textarea = wrap("textarea");`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/administrator-cancellations-mounted.cjs`);
compiled.filename = `${process.cwd()}/administrator-cancellations-mounted.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const { QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; delete globalThis.cancellationScope; dom.window.close(); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const record = (extra = {}) => ({
  id: "cancel-27", reason: "Member requested cancellation", effective_date: "2027-04-17", timing: "end_of_term",
  access_ended_at: null, withdrawn_at: null, financial_state: "awaiting_reconciliation", created_at: "2026-04-17T14:23:00Z", ...extra,
});
const preview = (calculation = { currency: "GBP", paymentDueMinor: 1723, surplusMinor: 4327 }, policy = { cancellationUnusedValue: "none" }) => ({
  fingerprint: "a".repeat(64),
  authority: { effectiveDate: "2027-04-17", timing: "end_of_term", financialReviewReason: null, calculation, policySnapshot: { policy }, sourceSnapshot: { privateEvidence: "DO_NOT_RENDER" } },
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const button = label => [...document.querySelectorAll("button")].find(item => item.textContent === label);
const previewButton = () => button("Preview cancellation");
const confirmButton = () => button("Confirm cancellation");
const recoverButton = () => button("Recover cancellation by key");
async function click(element) {
  assert.ok(element); assert.equal(element.disabled, false);
  await act(async () => element.click());
}
async function waitFor(predicate) {
  for (let count = 0; count < 70; count++) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  assert.fail("Timed out waiting for administrator cancellation UI");
}
async function text(value, selector = "textarea") {
  const input = document.querySelector(selector);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function mount({ get, post, actionsEnabled = true, panel = false, scope = {} } = {}) {
  const calls = [], changes = [], invalidations = [];
  globalThis.cancellationScope = { status: "ready", tenantId: "tenant-safe", scopeKey: "scope-safe", assertCurrent() {}, ...scope };
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, payload, tenantId: options.headers["X-Tenant-Id"] });
    if (payload) return post ? post(payload) : json(preview());
    if (get) return get(url);
    if (url.includes("action=cancellation_")) return json({ records: [], nextCursor: null });
    return json({ current: null, history: [], structures: [], capabilities: {}, blockers: [] });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = options => { invalidations.push(options.queryKey); return invalidate(options); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (props = {}) => root.render(React.createElement(QueryClientProvider, { client },
    React.createElement(panel ? compiled.exports.Panel : Component, {
      memberId: "member-safe", tenantId: "tenant-safe", actionsEnabled, onChange: item => changes.push(item), ...props,
    })));
  await act(async () => render());
  return { calls, changes, invalidations, container, render, async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}
async function prepare() {
  await waitFor(() => document.querySelector("textarea") && !document.querySelector("textarea").disabled);
  await text("Requested by member after relocation");
  await click(previewButton());
  await waitFor(confirmButton);
}
async function approve() {
  await click(document.querySelector('input[type="checkbox"]'));
  await click(confirmButton());
}

test("reason is mandatory, preview is explicit, policy timing has no override, approval is separate", async () => {
  const mounted = await mount();
  try {
    await waitFor(previewButton);
    assert.equal(previewButton().disabled, true);
    await text("   "); assert.equal(previewButton().disabled, true);
    assert.equal(mounted.calls.filter(call => call.payload).length, 0);
    await prepare();
    assert.equal(confirmButton().disabled, true);
    assert.equal(mounted.calls.filter(call => call.payload?.approve).length, 0);
    assert.match(mounted.container.textContent, /£17.23/);
    assert.match(mounted.container.textContent, /£43.27/);
    assert.match(mounted.container.textContent, /does not waive service-used debt/);
    assert.match(mounted.container.textContent, /tenant policy; no override/);
    assert.equal(document.querySelector("select,input[type=date]"), null);
    assert.doesNotMatch(mounted.container.textContent, /DO_NOT_RENDER/);
    await text("Different reason");
    assert.equal(confirmButton(), undefined);
  } finally { await mounted.cleanup(); }
});

test("confirmation binds the reason and fingerprint; repeated clicks issue one request only", async () => {
  const pending = deferred();
  const mounted = await mount({ post: payload => payload.action === "preview_cancellation" ? json(preview()) : pending.promise });
  try {
    await prepare();
    await click(document.querySelector('input[type="checkbox"]'));
    const button = confirmButton();
    await act(async () => { button.click(); button.click(); });
    const writes = mounted.calls.filter(call => call.payload?.approve);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].tenantId, "tenant-safe");
    assert.deepEqual(writes[0].payload, {
      action: "confirm_cancellation", memberId: "member-safe", approve: true,
      fingerprint: preview().fingerprint, selection: { reason: "Requested by member after relocation" }, key: writes[0].payload.key,
    });
    assert.ok(writes[0].payload.key);
    await act(async () => pending.resolve(json({ record: record(), provider: { state: "pending" } })));
    assert.match(mounted.container.textContent, /Scheduled — access end not recorded/);
    assert.match(mounted.container.textContent, /provider stop are not confirmed/);
    assert.equal(mounted.changes.length, 1);
    assert.equal(recoverButton(), undefined);
  } finally { await mounted.cleanup(); }
});

test("lost confirmation response recovers by key without a second confirmation and retains the form", async () => {
  const mounted = await mount({ post: payload => {
    if (payload.action === "preview_cancellation") return json(preview());
    if (payload.action === "confirm_cancellation") throw new Error("Connection lost");
    return json({ record: record({ access_ended_at: "2026-04-17T14:23:00Z", timing: "immediate" }), provider: { state: "pending" } });
  } });
  try {
    await prepare(); await approve();
    assert.match(mounted.container.textContent, /Connection lost/);
    assert.equal(confirmButton(), undefined);
    assert.equal(document.querySelector("textarea").value, "Requested by member after relocation");
    assert.equal(document.querySelector("textarea").disabled, true);
    await click(recoverButton());
    const confirmed = mounted.calls.find(call => call.payload?.approve).payload;
    assert.deepEqual(mounted.calls.at(-1).payload, { action: "recover_cancellation", memberId: "member-safe", key: confirmed.key, fingerprint: confirmed.fingerprint });
    assert.equal(mounted.calls.filter(call => call.payload?.approve).length, 1);
    assert.match(mounted.container.textContent, /Applied — access ended/);
  } finally { await mounted.cleanup(); }
});

test("not-found recovery permits an explicit retry with the identical key, fingerprint and reason", async () => {
  let confirms = 0;
  const mounted = await mount({ post: payload => {
    if (payload.action === "preview_cancellation") return json(preview());
    if (payload.action === "recover_cancellation") return json({ record: null, provider: null });
    confirms += 1;
    if (confirms === 1) return new Response("unreadable", { status: 200 });
    return json({ record: record() });
  } });
  try {
    await prepare(); await approve();
    assert.equal(button("Retry cancellation confirmation with same key"), undefined);
    await click(recoverButton());
    const retry = button("Retry cancellation confirmation with same key");
    assert.equal(retry.disabled, true);
    await click(document.querySelector('input[type="checkbox"]')); await click(retry);
    const writes = mounted.calls.filter(call => call.payload?.approve);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].payload, writes[1].payload);
    assert.deepEqual(mounted.calls.filter(call => call.payload).map(call => call.payload.action), [
      "preview_cancellation", "confirm_cancellation", "recover_cancellation", "confirm_cancellation",
    ]);
  } finally { await mounted.cleanup(); }
});

test("malformed confirmation and failed recovery remain locked and never allocate a new key", async () => {
  const mounted = await mount({ post: payload => {
    if (payload.action === "preview_cancellation") return json(preview());
    if (payload.action === "confirm_cancellation") return json({ provider: { state: "done" } });
    return json({ error: { message: "Recovery unavailable" } }, 503);
  } });
  try {
    await prepare(); await approve();
    assert.match(mounted.container.textContent, /outcome was not confirmed/);
    await click(recoverButton()); await click(recoverButton());
    const recoveries = mounted.calls.filter(call => call.payload?.action === "recover_cancellation");
    assert.deepEqual(recoveries[0].payload, recoveries[1].payload);
    assert.match(mounted.container.textContent, /Recovery unavailable/);
    assert.equal(confirmButton(), undefined);
    assert.equal(previewButton(), undefined);
  } finally { await mounted.cleanup(); }
});

test("actual monthly paymentDueMinor null and absent surplus await reconciliation, never zero", async () => {
  for (const calculation of [null, { currency: "GBP", paymentDueMinor: null }, { currency: "GBP", paymentDueMinor: null, surplusMinor: null }]) {
    const mounted = await mount({ post: () => {
      const result = preview(calculation);
      result.authority.financialReviewReason = "monthly_reconciliation_required";
      return json(result);
    } });
    try {
      await prepare();
      assert.match(mounted.container.textContent, /Awaiting reconciliation/);
      assert.deepEqual([...document.querySelectorAll("dd")].map(element => element.textContent), ["Awaiting reconciliation", "Awaiting reconciliation"]);
      assert.match(mounted.container.textContent, /awaiting reconciliation, not zero/);
      assert.doesNotMatch(mounted.container.textContent, /£0\.00|GBP 0/);
    } finally { await mounted.cleanup(); }
  }
});

test("dated history distinguishes scheduled, withdrawn and applied; only scheduled can withdraw", async () => {
  const records = [
    record({ id: "scheduled" }),
    record({ id: "withdrawn", withdrawn_at: "2026-04-18T10:00:00Z" }),
    record({ id: "applied", access_ended_at: "2026-04-17T14:23:00Z", timing: "immediate" }),
  ];
  const mounted = await mount({ get: () => json({ records, nextCursor: null }), post: payload =>
    json({ record: record({ id: payload.id, withdrawn_at: "2026-04-19T10:00:00Z" }) }) });
  try {
    await waitFor(() => button("Withdraw scheduled cancellation scheduled"));
    assert.match(mounted.container.textContent, /Scheduled — access end not recorded/);
    assert.match(mounted.container.textContent, /Withdrawn/);
    assert.match(mounted.container.textContent, /Applied — access ended/);
    assert.match(mounted.container.textContent, /17\/04\/2027/);
    assert.equal(button("Withdraw scheduled cancellation applied"), undefined);
    assert.equal(button("Withdraw scheduled cancellation withdrawn"), undefined);
    await click(button("Withdraw scheduled cancellation scheduled"));
    const submit = button("Confirm cancellation withdrawal");
    assert.equal(submit.disabled, true);
    await text("Member wishes to stay", "#withdraw-cancellation-scheduled");
    assert.equal(submit.disabled, true);
    await click(document.querySelector('input[type="checkbox"]')); await click(submit);
    assert.deepEqual(mounted.calls.at(-1).payload, { action: "withdraw_cancellation", memberId: "member-safe", id: "scheduled", reason: "Member wishes to stay" });
    assert.equal(button("Withdraw scheduled cancellation scheduled"), undefined);
  } finally { await mounted.cleanup(); }
});

test("uncertain withdrawal requires recovery by id, not a blind repeat", async () => {
  const mounted = await mount({ get: () => json({ records: [record()], nextCursor: null }), post: payload => {
    if (payload.action === "withdraw_cancellation") throw new Error("Withdrawal response lost");
    return json({ record: record({ withdrawn_at: "2026-04-18T10:00:00Z" }) });
  } });
  try {
    await waitFor(() => button("Withdraw scheduled cancellation cancel-27"));
    await click(button("Withdraw scheduled cancellation cancel-27"));
    await text("Member staying", "#withdraw-cancellation-cancel-27");
    await click(document.querySelector('input[type="checkbox"]')); await click(button("Confirm cancellation withdrawal"));
    assert.equal(button("Confirm cancellation withdrawal").disabled, true);
    await click(button("Recover cancellation request cancel-27"));
    assert.deepEqual(mounted.calls.at(-1).payload, { action: "recover_cancellation", memberId: "member-safe", id: "cancel-27" });
    assert.equal(mounted.calls.filter(call => call.payload?.action === "withdraw_cancellation").length, 1);
    assert.match(mounted.container.textContent, /Withdrawn/);
  } finally { await mounted.cleanup(); }
});

test("history has skeleton, empty state, error reload and explicit pagination", async () => {
  const loading = deferred(); let failed = true, first = true;
  const mounted = await mount({ get: url => {
    if (!url.includes("after=")) {
      if (first) { first = false; return loading.promise; }
      return json({ records: [record()], nextCursor: "cursor-older" });
    }
    if (failed) return json({ error: "History unavailable" }, 503);
    return json({ records: [record({ id: "older" })], nextCursor: null });
  } });
  try {
    assert.ok(document.querySelector('[aria-label="Loading cancellation requests"]'));
    await act(async () => loading.resolve(json({ records: [record()], nextCursor: "cursor-older" })));
    await click(button("Load more cancellation requests"));
    assert.match(mounted.container.textContent, /History unavailable/);
    assert.equal(previewButton().disabled, true);
    // Reload validates page one before pagination can be attempted again.
    failed = false; await click(button("Reload cancellation history"));
    await click(button("Load more cancellation requests"));
    assert.equal(document.querySelectorAll("li").length, 2);
    const url = new URL(mounted.calls.at(-1).url, "https://isolated.example.test");
    assert.equal(url.searchParams.get("after"), "cursor-older");
    assert.equal(url.searchParams.get("memberId"), "member-safe");
  } finally { await mounted.cleanup(); }
  const empty = await mount();
  try { await waitFor(() => empty.container.textContent.includes("No cancellation requests recorded")); }
  finally { await empty.cleanup(); }
});

test("API preview and permission errors are explicit; unverified scopes never call APIs", async () => {
  for (const code of [403, 409, 503]) {
    const mounted = await mount({ post: () => json({ error: { message: "Cancellation policy unavailable" } }, code) });
    try {
      await waitFor(() => document.querySelector("textarea") && !document.querySelector("textarea").disabled);
      await text("Member request"); await click(previewButton());
      assert.match(mounted.container.textContent, /Cancellation policy unavailable/);
      assert.equal(confirmButton(), undefined);
      if (code === 403) assert.equal(previewButton().disabled, true);
    } finally { await mounted.cleanup(); }
  }
  const denied = await mount({ scope: { status: "error", tenantId: null } });
  try { assert.equal(denied.calls.length, 0); assert.equal(previewButton(), undefined); }
  finally { await denied.cleanup(); }
  const disabled = await mount({ actionsEnabled: false });
  try { await waitFor(previewButton); assert.equal(previewButton().disabled, true); }
  finally { await disabled.cleanup(); }
});

test("late responses cannot cross member/tenant or revoked action permissions", async () => {
  const pending = deferred();
  const mounted = await mount({ post: () => pending.promise });
  try {
    await waitFor(() => document.querySelector("textarea") && !document.querySelector("textarea").disabled);
    await text("Member request"); await click(previewButton());
    await act(async () => mounted.render({ actionsEnabled: false }));
    await act(async () => mounted.render({ actionsEnabled: true }));
    await act(async () => pending.resolve(json(preview())));
    assert.equal(confirmButton(), undefined);
    await act(async () => mounted.render({ memberId: "other-member", tenantId: "other-tenant" }));
    assert.equal(previewButton(), undefined);
    assert.equal(mounted.changes.length, 0);
  } finally { await mounted.cleanup(); }
});

test("confirmed access evidence refreshes surrounding membership caches and finance discovery", async () => {
  const mounted = await mount({ panel: true, post: payload => payload.action === "preview_cancellation" ? json(preview())
    : json({ record: record({ access_ended_at: "2026-04-17T14:23:00Z", timing: "immediate" }), provider: { state: "pending" } }) });
  try {
    await prepare();
    const discoveries = mounted.calls.filter(call => call.url.includes("action=cancellation_finances")).length;
    await approve();
    await waitFor(() => mounted.calls.filter(call => call.url.includes("action=cancellation_finances")).length > discoveries);
    assert.ok(mounted.invalidations.some(key => key[0] === "member-membership" && key[1] === "member-safe"));
    assert.ok(mounted.invalidations.some(key => key[0] === "member-detail" && key[1] === "member-safe"));
    assert.ok(mounted.invalidations.some(key => key[0] === "member-amendments" && key[1] === "tenant-safe"));
    assert.match(mounted.container.textContent, /Applied cancellation finances/);
    assert.match(mounted.container.textContent, /provider stop are not confirmed/);
  } finally { await mounted.cleanup(); }
});

test("an uncertain confirmation retains its bound preview through temporary action disablement", async () => {
  const mounted = await mount({ post: payload => {
    if (payload.action === "preview_cancellation") return json(preview());
    if (payload.action === "confirm_cancellation") throw new Error("Response lost");
    return json({ record: null });
  } });
  try {
    await prepare(); await approve();
    await act(async () => mounted.render({ actionsEnabled: false }));
    await act(async () => mounted.render({ actionsEnabled: true }));
    await click(recoverButton());
    assert.ok(button("Retry cancellation confirmation with same key"));
    assert.equal(button("Retry cancellation confirmation with same key").disabled, true);
    assert.equal(document.querySelector("textarea").value, "Requested by member after relocation");
    assert.match(mounted.container.textContent, /17\/04\/2027/);
  } finally { await mounted.cleanup(); }
});

test("late confirmation cannot populate a different member and recovery cannot waive a concurrent access end", async () => {
  const pending = deferred();
  const mounted = await mount({ post: payload => payload.action === "preview_cancellation" ? json(preview()) : pending.promise });
  try {
    await prepare(); await approve();
    await act(async () => mounted.render({ memberId: "other-member" }));
    await act(async () => pending.resolve(json({ record: record({ access_ended_at: "2026-04-17T14:23:00Z" }) })));
    assert.equal(mounted.changes.length, 0);
    assert.doesNotMatch(mounted.container.textContent, /Applied — access ended/);
  } finally { await mounted.cleanup(); }
  const ended = await mount({ get: () => json({ records: [record()], nextCursor: null }), post: () =>
    json({ record: record({ access_ended_at: "2026-04-17T14:23:00Z" }) }) });
  try {
    await waitFor(() => button("Recover cancellation request cancel-27"));
    await click(button("Recover cancellation request cancel-27"));
    assert.equal(button("Withdraw scheduled cancellation cancel-27"), undefined);
    assert.match(ended.container.textContent, /Applied — access ended/);
    assert.equal(ended.calls.filter(call => call.payload?.action === "withdraw_cancellation").length, 0);
  } finally { await ended.cleanup(); }
});

test("immediate requests without access evidence are not described as applied or scheduled", async () => {
  const mounted = await mount({ get: () => json({ records: [record({ timing: "immediate" })], nextCursor: null }) });
  try {
    await waitFor(() => mounted.container.textContent.includes("Access end not confirmed"));
    assert.doesNotMatch(mounted.container.textContent, /Applied — access ended|Scheduled — access end not recorded/);
    assert.equal(button("Withdraw scheduled cancellation cancel-27"), undefined);
  } finally { await mounted.cleanup(); }
});

test("missing preview fingerprint or policy authority cannot grant confirmation", async () => {
  for (const result of [{ authority: preview().authority }, { fingerprint: preview().fingerprint, authority: {} }]) {
    const mounted = await mount({ post: () => json(result) });
    try {
      await waitFor(() => document.querySelector("textarea") && !document.querySelector("textarea").disabled);
      await text("Member request"); await click(previewButton());
      assert.match(mounted.container.textContent, /valid cancellation preview was not returned/);
      assert.equal(confirmButton(), undefined);
      assert.equal(document.querySelector('input[type="checkbox"]'), null);
    } finally { await mounted.cleanup(); }
  }
});

test("actual upfront paymentDueMinor is displayed, never a guessed debtMinor or nested settlement amount", async () => {
  const mounted = await mount({ post: () => json(preview({
    paymentDueMinor: 1723, surplusMinor: 4327, currency: "GBP", debtMinor: 99999,
    finance: { paymentDueMinor: 88888 }, settlement: { paymentDueMinor: 77777 },
  })) });
  try {
    await prepare();
    assert.deepEqual([...document.querySelectorAll("dd")].map(element => element.textContent), ["£17.23", "£43.27"]);
    assert.match(mounted.container.textContent, /Service-used balance due/);
    assert.match(mounted.container.textContent, /Calculated unused value — not a return entitlement/);
    assert.doesNotMatch(mounted.container.textContent, /£999\.99|£888\.88|£777\.77|Potential returnable surplus/);
  } finally { await mounted.cleanup(); }
});

test("none policy retains positive unused value without promising refund or member credit", async () => {
  const mounted = await mount();
  try {
    await prepare();
    assert.match(mounted.container.textContent, /£43\.27/);
    assert.match(mounted.container.textContent, /unused value is retained/);
    assert.match(mounted.container.textContent, /not owed back as a refund or member credit/);
    assert.doesNotMatch(mounted.container.textContent, /Potential returnable surplus/);
  } finally { await mounted.cleanup(); }
});

test("tenant surplus policy distinguishes credit, refund and approval without granting return entitlement", async () => {
  for (const [surplusHandling, expected] of [
    ["credit", /considered for member credit.*No member credit has been issued/],
    ["refund", /considered for refund.*No refund is promised or processed/],
    ["approval", /requires separate approval.*Neither member credit nor a refund has been approved/],
    [undefined, /Surplus handling is not supplied or is unsupported/],
  ]) {
    const mounted = await mount({ post: () => json(preview(
      { paymentDueMinor: 1723, surplusMinor: 4327, currency: "GBP" },
      { cancellationUnusedValue: "tenant_surplus_policy", surplusHandling },
    )) });
    try {
      await prepare();
      assert.match(mounted.container.textContent, /tenant surplus policy/);
      assert.match(mounted.container.textContent, expected);
      assert.match(mounted.container.textContent, /not a return entitlement/);
      assert.equal(confirmButton().disabled, true);
      assert.equal(mounted.calls.filter(call => call.payload?.approve).length, 0);
    } finally { await mounted.cleanup(); }
  }
});

test("record/provider confirmation envelope never implies completed settlement", async () => {
  for (const provider of [null, { state: "pending" }, { state: "done" }]) {
    const confirmedRecord = record({ access_ended_at: "2026-04-17T14:23:00Z", timing: "immediate", financial_state: "awaiting_reconciliation" });
    const mounted = await mount({ post: payload => payload.action === "preview_cancellation"
      ? json(preview()) : json({ record: confirmedRecord, provider }) });
    try {
      await prepare(); await approve();
      assert.deepEqual(mounted.changes, [confirmedRecord]);
      assert.match(mounted.container.textContent, /Applied — access ended/);
      assert.match(mounted.container.textContent, /Recorded financial state: awaiting reconciliation/);
      assert.match(mounted.container.textContent, /Financial processing and provider stop are not confirmed/);
      assert.doesNotMatch(mounted.container.textContent, /Cancellation finances completed|Financially settled/);
    } finally { await mounted.cleanup(); }
  }
});
