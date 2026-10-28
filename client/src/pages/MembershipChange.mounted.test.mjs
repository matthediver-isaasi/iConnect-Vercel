import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// All HTTP and auth boundaries replaced before mounting; no live API access.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = Module.createRequire(import.meta.url)("react-router-dom");
const { QueryClient, QueryClientProvider } = Module.createRequire(import.meta.url)("@tanstack/react-query");
async function compile(entry) {
  const bundle = await build({
    entryPoints: [entry], bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
    plugins: [{ name: "isolated-request-boundaries", setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\/components\/ui\// }, args => ({ path: args.path, namespace: "ui" }));
      builder.onLoad({ filter: /.*/, namespace: "ui" }, () => ({ loader: "js", contents: `import React from "react";
        const wrap = tag => ({children, variant, size, ...props}) => React.createElement(tag, props, children);
        export const Card = wrap("div"), CardHeader = wrap("div"), CardTitle = wrap("h2"), CardContent = wrap("div"),
          Button = wrap("button"), Badge = wrap("span"), Label = wrap("label"), Textarea = wrap("textarea");` }));
      builder.onResolve({ filter: /^@\/hooks\/(useMemberChangeSession|useFormAlerts)$/ }, args => ({ path: args.path, namespace: "auth" }));
      builder.onLoad({ filter: /.*/, namespace: "auth" }, () => ({ loader: "js", contents: `
        export const useMemberChangeSession = () => globalThis.requestScope;
        export const useFormAlertTenant = () => globalThis.requestScope;` }));
      builder.onResolve({ filter: /^@\/lib\/adminFetch$/ }, () => ({ path: "admin", namespace: "admin" }));
      builder.onLoad({ filter: /.*/, namespace: "admin" }, () => ({ loader: "js", contents: `export const adminFetch=(url, options={}, tenantId)=>fetch(url,{...options, credentials:"include", headers:{...options.headers,"X-Tenant-Id":tenantId}});` }));
      builder.onResolve({ filter: /^@\// }, args => ({ path: `${process.cwd()}/client/src/${args.path.slice(2)}.jsx`.replace(/\/lib\/(.*)\.jsx$/, "/lib/$1.js") }));
    } }],
  });
  const module = new Module(`${process.cwd()}/membership-request-isolated.cjs`);
  module.filename = `${process.cwd()}/membership-request-isolated.cjs`;
  module.paths = Module._nodeModulePaths(process.cwd());
  module._compile(bundle.outputFiles[0].text, module.filename);
  return module.exports;
}
const Member = (await compile("client/src/pages/MembershipChange.jsx")).default;
const Admin = (await compile("client/src/components/MemberChangeRequestReview.jsx")).default;
const { MemberChangeRequestSummary } = await compile("client/src/components/MemberChangeRequestSummary.jsx");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; delete globalThis.requestScope; dom.window.close(); });
const formId = "e7019952-b991-4f60-8caf-b71efdbfe661";
const fingerprint = "e".repeat(64);
const summary = { targetName: "Professional", paymentDueMinor: 4327, currency: "GBP", effectiveDate: "2026-10-14", renewalDate: "2027-04-17", reason: "New responsibilities" };
const record = (state = "pending") => ({ id: "9af39f42-370d-4489-8bdf-35cacb4d5ba7", state, createdAt: "2026-10-14T08:23:00Z", summary, reviewReason: state === "rejected" ? "Not eligible" : null, authorityId: state === "approved" ? "authority-id" : null });
const context = overrides => ({ form: { id: formId, name: "Member review" }, current: { paymentFrequency: "upfront", startDate: "2026-04-17", renewalDate: "2027-04-17" }, blockers: [], requiresReview: true, structures: [{ id: "professional", name: "Professional", pricingModel: "flat", bands: [] }], requests: [], ...overrides });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const scope = overrides => ({ status: "ready", scopeKey: "member-session-a", tenantId: "tenant-a", assertCurrent() {}, ...overrides });
const button = text => [...document.querySelectorAll("button")].find(node => node.textContent === text);
async function click(node) {
  assert.ok(node, "Control exists"); assert.equal(node.disabled, false, "Control enabled");
  await act(async () => node.click());
}
async function change(selector, value) {
  const node = document.querySelector(selector);
  assert.ok(node, selector);
  const proto = node.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function waitFor(predicate) {
  for (let i = 0; i < 65; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 8)); });
  }
  assert.fail(`Timed out: ${document.body.textContent}`);
}
async function mount({ admin = false, transport, props = {}, auth = scope(), path = `/MembershipChange?formId=${formId}&memberId=ignored` } = {}) {
  globalThis.requestScope = auth;
  const calls = [], invalidations = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    const payload = options.body ? JSON.parse(options.body) : null;
    const action = payload?.action || new URL(url, "https://isolated.example.test").searchParams.get("action");
    calls.push({ url, options, payload, action });
    if (!admin) {
      assert.equal(payload?.memberId, undefined);
      assert.equal(new URL(url, "https://isolated.example.test").searchParams.has("memberId"), false);
      assert.equal(new Headers(options.headers).has("X-Tenant-Id"), false);
    } else assert.equal(options.headers["X-Tenant-Id"], "tenant-a");
    if (transport) return transport({ url, options, payload, action, calls });
    if (action === "member_change_context") return json(context());
    if (action === "member_change_preview") return json({ summary, fingerprint });
    if (action === "member_change_requests") return json({ requests: [record()] });
    return json(record());
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.invalidateQueries = async options => { invalidations.push(options.queryKey); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let currentProps = { memberId: "member-a", tenantId: "tenant-a", actionsEnabled: true, ...props };
  const render = async (nextProps = {}, authNext) => {
    currentProps = { ...currentProps, ...nextProps };
    if (authNext) globalThis.requestScope = authNext;
    await act(async () => root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(admin ? Admin : Member, currentProps)))));
  };
  await render();
  return { calls, invalidations, container, render, async cleanup() {
    await act(async () => root.unmount()); client.clear(); container.remove();
  } };
}
async function preview() {
  await waitFor(() => !!document.querySelector("#request-structure"));
  await change("#request-structure", "professional");
  await change("#request-reason", "New responsibilities");
  await click(button("Preview request"));
  await waitFor(() => !!button("Submit for review"));
}
async function approveDraft() {
  await waitFor(() => !!button("Review approval"));
  await click(button("Review approval"));
  await change('textarea[id^="review-reason"]', "Eligibility and quote checked");
  await click(document.querySelector('input[type="checkbox"]'));
}

test("member preview requires consent, displays supplied values only, and creates review not payment", async () => {
  const view = await mount();
  try {
    await preview();
    assert.equal(button("Submit for review").disabled, true);
    assert.match(view.container.textContent, /£43.27/);
    assert.match(view.container.textContent, /Eligible surplus for reviewNot supplied/);
    await click(document.querySelector('input[type="checkbox"]'));
    await click(button("Submit for review"));
    assert.match(view.container.textContent, /Pending review/);
    assert.match(view.container.textContent, /No membership change or transaction has been executed/);
    const payload = view.calls.find(call => call.action === "member_change_submit").payload;
    assert.equal(payload.formId, formId);
    assert.equal(payload.selection.bandId, null);
    assert.equal(payload.fingerprint, fingerprint);
    assert.ok(payload.key);
    assert.equal(view.calls.some(call => /execute|payment/.test(call.action)), false);
  } finally { await view.cleanup(); }
});

test("editing a preview clears consent and the preview; bands use exact DTO fields", async () => {
  const view = await mount();
  try {
    await preview(); await click(document.querySelector('input[type="checkbox"]'));
    await change("#request-reason", "A revised reason");
    assert.equal(button("Submit for review"), undefined);
    await click(button("Preview request"));
    assert.equal(button("Submit for review").disabled, true);
    assert.equal(document.querySelector('input[type="checkbox"]').checked, false);
  } finally { await view.cleanup(); }
});

test("uncertain submission recovers first and retains identical key, selection and fingerprint on explicit retry", async () => {
  let submits = 0, recovers = 0;
  const view = await mount({ transport: ({ action }) => {
    if (action === "member_change_context") return json(context());
    if (action === "member_change_preview") return json({ summary, fingerprint });
    if (action === "member_change_submit") { submits += 1; throw new Error("Connection lost"); }
    if (action === "member_change_recover") { recovers += 1; return json({ record: recovers === 1 ? null : record() }); }
  } });
  try {
    await preview(); await click(document.querySelector('input[type="checkbox"]')); await click(button("Submit for review"));
    assert.match(view.container.textContent, /submission outcome is unknown/);
    assert.equal(document.querySelector("#request-reason").closest("fieldset").disabled, true);
    assert.equal(button("Submit same request"), undefined);
    await click(button("Recover request outcome"));
    assert.equal(submits, 1);
    await click(button("Submit same request"));
    const attempts = view.calls.filter(call => call.action === "member_change_submit");
    assert.deepEqual(attempts[0].payload, attempts[1].payload);
    await click(button("Recover request outcome"));
    assert.match(view.container.textContent, /Pending review/);
    assert.equal(button("Recover request outcome"), undefined);
  } finally { await view.cleanup(); }
});

test("withdrawal is confirmed, pending-only, and ambiguous outcome requires history reload", async () => {
  let loads = 0;
  const view = await mount({ transport: ({ action }) => {
    if (action === "member_change_context") return json(context({ requests: [record(++loads === 1 ? "pending" : "withdrawn")] }));
    throw new Error("Withdrawal not confirmed");
  } });
  try {
    await click(button("Withdraw request"));
    assert.equal(view.calls.some(call => call.action === "member_change_withdraw"), false);
    await click(button("Confirm withdrawal"));
    assert.match(view.container.textContent, /Withdrawal outcome is unknown/);
    assert.equal(button("Withdraw request").disabled, true);
    await click(button("Reload request history"));
    assert.match(view.container.textContent, /Withdrawn/);
    assert.equal(button("Withdraw request"), undefined);
  } finally { await view.cleanup(); }
});

test("401 and 403 explain sign-in/access and preserve existing login return navigation", async () => {
  for (const status of [401, 403]) {
    const view = await mount({ transport: () => json({ error: "Sign in with your member account" }, status) });
    try {
      assert.match(view.container.textContent, /ask an administrator to check your access/);
      const href = view.container.querySelector("a").getAttribute("href");
      assert.equal(href, `/login?returnTo=${encodeURIComponent(`/MembershipChange?formId=${formId}&memberId=ignored`)}`);
      assert.equal(button("Preview request"), undefined);
    } finally { await view.cleanup(); }
  }
});

test("invalid links and missing member sessions never request member data", async () => {
  for (const options of [{ path: "/MembershipChange?formId=invalid" }, { auth: scope({ status: "error" }) }]) {
    const view = await mount(options);
    try { assert.equal(view.calls.length, 0); assert.ok(view.container.querySelector('[role="alert"]')); }
    finally { await view.cleanup(); }
  }
});

test("monthly unsupported server errors remain explicit, not a fabricated quote", async () => {
  const view = await mount({ transport: ({ action }) => action === "member_change_context"
    ? json(context({ current: { paymentFrequency: "monthly" } }))
    : json({ error: "Monthly member requests are not supported." }, 409) });
  try {
    await change("#request-structure", "professional");
    await change("#request-reason", "New responsibilities");
    await click(button("Preview request"));
    assert.match(view.container.textContent, /Monthly member requests are not supported/);
    assert.equal(button("Submit for review"), undefined);
  } finally { await view.cleanup(); }
});

test("member session changes fence late preview responses and reset draft", async () => {
  const gate = defer();
  const view = await mount({ transport: ({ action }) => action === "member_change_preview" ? gate.promise : json(context()) });
  try {
    await change("#request-structure", "professional"); await change("#request-reason", "Old session");
    await click(button("Preview request"));
    await view.render({}, scope({ scopeKey: "member-session-b" }));
    await act(async () => gate.resolve(json({ summary, fingerprint })));
    assert.equal(button("Submit for review"), undefined);
    assert.equal(document.querySelector("#request-reason").value, "");
  } finally { await view.cleanup(); }
});

test("admin approval requires a reason and explicit authority approval, invalidates existing finance panel only", async () => {
  const view = await mount({ admin: true, transport: ({ action }) => action === "member_change_requests"
    ? json({ requests: [record()] }) : json(record("approved")) });
  try {
    await click(button("Review approval"));
    assert.equal(button("Confirm approval").disabled, true);
    await change('textarea[id^="review-reason"]', "Eligibility checked");
    assert.equal(button("Confirm approval").disabled, true);
    await click(document.querySelector('input[type="checkbox"]'));
    await click(button("Confirm approval"));
    assert.match(view.container.textContent, /Approved for processing/);
    const post = view.calls.find(call => call.action === "review_member_change_request").payload;
    assert.deepEqual(post, { action: "review_member_change_request", memberId: "member-a", id: record().id, decision: "approve", reason: "Eligibility checked" });
    assert.deepEqual(view.invalidations, [["member-amendments", "tenant-a", "member-a"]]);
    assert.equal(view.calls.some(call => /execute/.test(call.action)), false);
  } finally { await view.cleanup(); }
});

test("admin uncertain review prohibits repeating approval until authoritative history reload", async () => {
  let loads = 0;
  const view = await mount({ admin: true, transport: ({ action }) => {
    if (action === "member_change_requests") return json({ requests: [record(++loads === 1 ? "pending" : "approved")] });
    throw new Error("Response lost");
  } });
  try {
    await approveDraft(); await click(button("Confirm approval"));
    assert.match(view.container.textContent, /Review outcome unknown/);
    assert.equal(button("Review approval").disabled, true);
    assert.equal(view.calls.filter(call => call.action === "review_member_change_request").length, 1);
    await click(button("Reload member requests"));
    assert.match(view.container.textContent, /Approved for processing/);
    assert.equal(button("Review approval"), undefined);
    assert.deepEqual(view.invalidations, [["member-amendments", "tenant-a", "member-a"]]);
  } finally { await view.cleanup(); }
});

test("admin rejection requires confirmation and never invokes execution or authority invalidation", async () => {
  const view = await mount({ admin: true, transport: ({ action }) => action === "member_change_requests"
    ? json({ requests: [record()] }) : json(record("rejected")) });
  try {
    await click(button("Review rejection"));
    await change('textarea[id^="review-reason"]', "Not eligible");
    await click(document.querySelector('input[type="checkbox"]'));
    await click(button("Confirm rejection"));
    assert.match(view.container.textContent, /Rejected/);
    assert.equal(view.invalidations.length, 0);
    assert.equal(view.calls.at(-1).payload.decision, "reject");
  } finally { await view.cleanup(); }
});

test("admin gate and member switch suppress unauthorized work and stale review results", async () => {
  const deniedView = await mount({ admin: true, auth: scope({ status: "error" }) });
  try { assert.equal(deniedView.calls.length, 0); assert.match(deniedView.container.textContent, /finance access could not be verified/); }
  finally { await deniedView.cleanup(); }
  const gate = defer();
  const view = await mount({ admin: true, transport: ({ action }) => action === "member_change_requests" ? json({ requests: [record()] }) : gate.promise });
  try {
    await approveDraft(); await click(button("Confirm approval"));
    await view.render({ memberId: "member-b" });
    await act(async () => gate.resolve(json(record("approved"))));
    assert.equal(view.invalidations.length, 0);
    assert.doesNotMatch(view.container.textContent, /Approved for processing/);
  } finally { await view.cleanup(); }
});

test("admin 403 fails closed and offers history reload rather than a repeated decision", async () => {
  const view = await mount({ admin: true, transport: () => json({ error: "Membership finance permission required" }, 403) });
  try {
    assert.match(view.container.textContent, /Sign-in or finance access is required/);
    assert.ok(button("Reload member requests"));
    assert.equal(button("Review approval"), undefined);
  } finally { await view.cleanup(); }
});

test("refreshing an uncertain member submission restores its recovery key and cannot submit blindly", async () => {
  let original;
  const first = await mount({ transport: ({ action, payload }) => {
    if (action === "member_change_context") return json(context());
    if (action === "member_change_preview") return json({ summary, fingerprint });
    original = payload;
    throw new Error("Network interrupted");
  } });
  try {
    await preview(); await click(document.querySelector('input[type="checkbox"]')); await click(button("Submit for review"));
  } finally { await first.cleanup(); }
  const restored = await mount({ transport: ({ action, payload }) => {
    if (action === "member_change_context") return json(context());
    assert.equal(action, "member_change_recover");
    assert.equal(payload.key, original.key);
    assert.equal(payload.fingerprint, original.fingerprint);
    return json({ record: record() });
  } });
  try {
    assert.ok(button("Recover request outcome"));
    assert.equal(button("Submit for review"), undefined);
    await click(button("Recover request outcome"));
    assert.match(restored.container.textContent, /Pending review/);
  } finally { await restored.cleanup(); window.sessionStorage.clear(); }
});

test("tiered requests require band, server blockers prevent preview, and terminal records cannot be withdrawn", async () => {
  const view = await mount({ transport: ({ action, payload }) => {
    if (action === "member_change_context") return json(context({
      structures: [{ id: "professional", name: "Professional", pricingModel: "tiered", bands: [{ id: "standard", label: "Standard band" }] }],
      requests: [record("approved"), { ...record("rejected"), id: "rejected" }, { ...record("withdrawn"), id: "withdrawn" }],
    }));
    assert.equal(payload.selection.bandId, "standard");
    return json({ summary, fingerprint });
  } });
  try {
    await change("#request-structure", "professional"); await change("#request-reason", "New responsibilities");
    assert.equal(button("Preview request").disabled, true);
    await change("#request-band", "standard");
    await click(button("Preview request"));
    assert.ok(button("Submit for review"));
    assert.equal(button("Withdraw request"), undefined);
  } finally { await view.cleanup(); }
  const blocked = await mount({ transport: () => json(context({ blockers: [{ message: "Membership requires administrator attention" }] })) });
  try {
    assert.match(blocked.container.textContent, /Membership requires administrator attention/);
    assert.equal(button("Preview request").disabled, true);
  } finally { await blocked.cleanup(); }
});

test("member context loading uses a skeleton and failed history is retryable, not an empty success", async () => {
  const gate = defer();
  let count = 0;
  const view = await mount({ transport: () => ++count === 1 ? gate.promise : json(context()) });
  try {
    assert.ok(view.container.querySelector('[aria-label="Loading membership review"]'));
    await act(async () => gate.resolve(json({ error: "History temporarily unavailable" }, 503)));
    assert.match(view.container.textContent, /History temporarily unavailable/);
    assert.doesNotMatch(view.container.textContent, /No review requests yet/);
    await click(button("Retry loading membership review"));
    assert.match(view.container.textContent, /No review requests yet/);
  } finally { await view.cleanup(); }
});

test("malformed submit and recovery responses keep member request locked until verified", async () => {
  let recovered = 0;
  const view = await mount({ transport: ({ action }) => {
    if (action === "member_change_context") return json(context());
    if (action === "member_change_preview") return json({ summary, fingerprint });
    if (action === "member_change_recover") return ++recovered === 1 ? json({}) : json({ record: record() });
    return new Response("unreadable", { status: 200 });
  } });
  try {
    await preview(); await click(document.querySelector('input[type="checkbox"]')); await click(button("Submit for review"));
    await click(button("Recover request outcome"));
    assert.ok(button("Recover request outcome"));
    assert.equal(button("Submit same request"), undefined);
    await click(button("Recover request outcome"));
    assert.match(view.container.textContent, /Pending review/);
  } finally { await view.cleanup(); window.sessionStorage.clear(); }
});

test("after recovery confirms no record, a stale preview may be deliberately discarded for a fresh quote", async () => {
  const view = await mount({ transport: ({ action }) => {
    if (action === "member_change_context") return json(context());
    if (action === "member_change_preview") return json({ summary, fingerprint });
    if (action === "member_change_recover") return json({ record: null });
    return json({ error: "The membership quote changed. Preview again." }, 409);
  } });
  try {
    await preview(); await click(document.querySelector('input[type="checkbox"]')); await click(button("Submit for review"));
    assert.equal(button("Discard unsubmitted preview"), undefined);
    await click(button("Recover request outcome"));
    await click(button("Discard unsubmitted preview"));
    assert.ok(button("Preview request"));
    assert.equal(button("Submit for review"), undefined);
    assert.equal(button("Submit same request"), undefined);
  } finally { await view.cleanup(); window.sessionStorage.clear(); }
});

test("monthly summary shows only supplied current monthly amount, alongside applicable dates and amounts", async () => {
  const monthlySummary = { ...summary, monthlyAmountMinor: 2783, renewalDate: "2028-06-19" };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(MemberChangeRequestSummary, { summary: monthlySummary })));
    const fields = [...container.querySelectorAll("dl > div")];
    const field = label => fields.find(node => node.querySelector("dt")?.textContent === label);
    assert.equal(field("Current monthly amount").querySelector("dd").textContent, "£27.83");
    assert.match(field("Current monthly amount").textContent, /not a guaranteed total/);
    assert.equal(field("Renewal date").querySelector("dd").textContent, "19/06/2028");
    assert.equal(field("Payment due for review").querySelector("dd").textContent, "£43.27");
    assert.equal(field("Eligible surplus for review").querySelector("dd").textContent, "Not supplied");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("monthly summary omits unknown or invalid amounts and displays a supplied zero without inventing a currency", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const monthlyAmountMinor of [undefined, null, "", "2783", NaN, Infinity]) {
      await act(async () => root.render(React.createElement(MemberChangeRequestSummary, { summary: { ...summary, monthlyAmountMinor } })));
      assert.doesNotMatch(container.textContent, /Current monthly amount/);
    }
    await act(async () => root.render(React.createElement(MemberChangeRequestSummary, { summary: { monthlyAmountMinor: 0 } })));
    assert.match(container.textContent, /Current monthly amount0\.00 \(currency not supplied\)/);
    assert.match(container.textContent, /Renewal dateNot supplied/);
    assert.match(container.textContent, /Payment due for reviewNot supplied/);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("eligible monthly member preview and administrator history share the supplied monthly summary", async () => {
  const monthlySummary = { ...summary, monthlyAmountMinor: 2783, renewalDate: "2028-06-19" };
  const memberView = await mount({ transport: ({ action }) => action === "member_change_context"
    ? json(context({ current: { paymentFrequency: "monthly" } }))
    : json({ summary: monthlySummary, fingerprint }) });
  try {
    await preview();
    assert.match(memberView.container.textContent, /Current monthly amount£27\.83/);
    assert.match(memberView.container.textContent, /19\/06\/2028/);
    assert.doesNotMatch(memberView.container.textContent, /Monthly changes are not supported|upfront membership change/);
    assert.equal(button("Submit for review").disabled, true);
  } finally { await memberView.cleanup(); }
  const adminView = await mount({ admin: true, transport: () => json({
    requests: [{ ...record("approved"), summary: monthlySummary }],
  }) });
  try {
    assert.match(adminView.container.textContent, /Current monthly amount£27\.83/);
    assert.match(adminView.container.textContent, /Approved for processing/);
    assert.match(adminView.container.textContent, /not evidence of payment, refund or an applied membership change/);
    assert.doesNotMatch(adminView.container.textContent, /Approved — not applied|member’s upfront request/);
  } finally { await adminView.cleanup(); }
});
