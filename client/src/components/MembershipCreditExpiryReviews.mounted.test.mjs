import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Mounted with the same esbuild/jsdom boundary as membership amendment tests.
// All requests and access hooks are replaced before the component is imported.
// node scripts/run-isolated-tests.mjs node --test client/src/components/MembershipCreditExpiryReviews.mounted.test.mjs
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/MembershipCreditExpiryReviews.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "expiry-review-isolated-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\// }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        loader: "js",
        contents: path.endsWith("adminFetch")
          ? "export const adminFetch = (url, options = {}, tenantId) => globalThis.fetch(url, {...options, credentials:'include', headers:{...options.headers, 'X-Tenant-Id':tenantId}});"
          : path.endsWith("useMemberAccess")
            ? "export const useMemberAccess = () => globalThis.expiryAccess;"
            : path.endsWith("useTicketViewerKey")
              ? "export const useTicketViewerKey = member => [globalThis.expiryTenant, member?.id || null];"
              : `import React from "react";
                const wrap = tag => ({children, variant, size, ...props}) => React.createElement(tag, props, children);
                export const Card = wrap("div"), CardContent = wrap("div"), Button = wrap("button"), Badge = wrap("span"), Label = wrap("label"), Textarea = wrap("textarea");`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/credit-expiry-mounted-isolated.cjs`);
compiled.filename = `${process.cwd()}/credit-expiry-mounted-isolated.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const { QueryClient, QueryClientProvider } = compiled.require("@tanstack/react-query");
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); delete globalThis.expiryAccess; delete globalThis.expiryTenant; });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const access = (overrides = {}) => ({
  isAdmin: true, isAccessReady: true, sessionValidated: true, roleStatus: "ready",
  memberInfo: { id: "finance-viewer", tenant_id: "tenant-finance", role_id: "finance-admin-role" },
  isFeatureExcluded: () => false, ...overrides,
});
const item = (overrides = {}) => ({
  amendmentId: "amendment-expired", memberId: "member-credit-owner", voucherCode: "MC-7K43",
  currency: "GBP", availableMinor: 4327, expiresAt: "2020-04-17T00:00:00Z",
  lastReview: null, needsReview: true, ...overrides,
});
const review = (overrides = {}) => ({
  note: "Liability confirmed; expiry does not extinguish the balance.",
  reviewedAt: "2026-01-23T14:32:17Z", actorId: "finance-auditor", availableMinor: 4327, ...overrides,
});
const header = () => document.querySelector('button[aria-controls="membership-credit-expiry-review-content"]');
const button = (text, scope = document) => [...scope.querySelectorAll("button")].find(node => node.textContent === text);
const row = id => document.querySelector(`[data-testid="credit-expiry-review-${id || "amendment-expired"}"]`);
const click = async node => {
  assert.ok(node, "button exists");
  assert.equal(node.disabled, false);
  await act(async () => node.click());
};
async function waitFor(predicate) {
  for (let i = 0; i < 70; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.fail("Timed out waiting for mounted expiry-review UI");
}
async function note(value, id) {
  const input = row(id).querySelector("textarea");
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function mount({ items = [item()], get, post, permission = access(), tenantId = "tenant-finance" } = {}) {
  globalThis.expiryAccess = permission;
  globalThis.expiryTenant = tenantId;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    const payload = options.body ? JSON.parse(options.body) : null;
    if (!payload) assert.match(url, /^\/api\/membership\/member-amendments\?action=credit_expiry_reviews(?:&after=.+)?$/);
    else assert.equal(url, "/api/membership/member-amendments");
    calls.push({ url, payload, tenantId: options.headers["X-Tenant-Id"] });
    return payload ? post ? post(payload) : json({ review: review({ note: payload.note }) }) : get ? get(url, options) : json({ items, nextCursor: null });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: 3, gcTime: Infinity, refetchOnWindowFocus: true } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = version => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Component, { key: version || "initial" })));
  await act(async () => render());
  return { calls, client, container, render, async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}
async function expand() { await click(header()); await waitFor(() => row() || document.querySelector('[role="alert"]') || document.body.textContent.includes("No outstanding expired")); }

test("collapsed by default, lazy query, clear audit-only explanation and composed empty state", async () => {
  const view = await mount({ items: [] });
  try {
    assert.equal(header().getAttribute("aria-expanded"), "false");
    assert.equal(view.calls.length, 0);
    assert.match(view.container.textContent, /never writes off liability/);
    await expand();
    assert.equal(header().getAttribute("aria-expanded"), "true");
    assert.match(view.container.textContent, /No outstanding expired membership-change credits to review/);
    assert.match(view.container.textContent, /restores spendability/);
    assert.equal(view.calls.length, 1);
    await click(header());
    assert.equal(document.querySelector("#membership-credit-expiry-review-content").hidden, true);
  } finally { await view.cleanup(); }
});

test("denied, non-admin, unvalidated and unresolved viewers never mount or query the finance queue", async () => {
  for (const permission of [
    access({ isAdmin: false }), access({ isAccessReady: false }), access({ sessionValidated: false }),
    access({ roleStatus: "error" }), access({ memberInfo: null }),
    access({ isFeatureExcluded: feature => feature === "commerce.monthly-finance-report" }),
    access({ isFeatureExcluded: feature => feature === "page_VoucherManagement" }),
  ]) {
    const view = await mount({ permission });
    try {
      assert.equal(header(), null);
      assert.equal(view.container.textContent, "");
      assert.equal(view.calls.length, 0);
    } finally { await view.cleanup(); }
  }
  const view = await mount({ tenantId: "other-tenant" });
  try { assert.equal(header(), null); assert.equal(view.calls.length, 0); }
  finally { await view.cleanup(); }
});

test("only positive outstanding expired credits appear; no-expiry, future and exhausted credits are excluded", async () => {
  const view = await mount({ items: [
    item(), item({ amendmentId: "no-expiry", expiresAt: null }),
    item({ amendmentId: "future", expiresAt: "2099-01-01T00:00:00Z" }),
    item({ amendmentId: "exhausted", availableMinor: 0 }),
  ] });
  try {
    await expand();
    assert.equal(document.querySelectorAll("article").length, 1);
    assert.match(row().textContent, /£43.27/);
    assert.match(row().textContent, /expired, not spendable/);
    assert.equal(row().querySelector("a").getAttribute("href"), "/members/member-credit-owner?tab=membership");
    assert.match(row().textContent, /No finance review recorded/);
    assert.match(row().textContent, /Finance review required/);
    assert.equal(row("future"), null);
    assert.equal(row("no-expiry"), null);
  } finally { await view.cleanup(); }
});

test("previous review shows note, actor, UTC timestamp and historical versus current balances", async () => {
  const view = await mount({ items: [item({ needsReview: false, lastReview: review({ availableMinor: 5183 }), availableMinor: 4327 })] });
  try {
    await expand();
    assert.match(row().textContent, /Review recorded/);
    assert.match(row().textContent, /Liability confirmed/);
    assert.match(row().textContent, /finance-auditor/);
    assert.match(row().textContent, /2026-01-23T14:32:17.000Z \(UTC\)/);
    assert.match(row().textContent, /Available balance at review: £51.83. Current balance remains £43.27/);
  } finally { await view.cleanup(); }
});

test("required nonempty <=2000 note saves against pinned tenant/member/amendment and invalidates the list", async () => {
  const data = [item()];
  let gets = 0;
  const view = await mount({
    get: () => { gets += 1; return json({ items: data, nextCursor: null }); },
    post: payload => {
      data[0] = { ...data[0], lastReview: review({ note: payload.note }), needsReview: false };
      return json({ review: data[0].lastReview });
    },
  });
  try {
    await expand();
    const textarea = row().querySelector("textarea");
    assert.equal(textarea.required, true);
    assert.equal(textarea.maxLength, 2000);
    assert.match(row().querySelector("label").textContent, /required/);
    assert.equal(button("Save finance review").disabled, true);
    await note("   ");
    assert.equal(button("Save finance review").disabled, true);
    await note("x".repeat(2001));
    assert.equal(button("Save finance review").disabled, true);
    await note("  Reviewed with accounts; retain outstanding liability.  ");
    await click(button("Save finance review"));
    await waitFor(() => gets >= 2 && row().textContent.includes("Finance review recorded."));
    assert.deepEqual(view.calls.find(call => call.payload).payload, {
      action: "review_credit_expiry", memberId: "member-credit-owner", amendmentId: "amendment-expired", note: "Reviewed with accounts; retain outstanding liability.",
    });
    assert.ok(view.calls.every(call => call.tenantId === "tenant-finance"));
    assert.equal(row().querySelector("textarea").value, "");
    assert.match(row().textContent, /Liability and spendability are unchanged/);
    assert.ok(view.calls.every(call => !call.payload || call.payload.action === "review_credit_expiry"));
  } finally { await view.cleanup(); }
});

test("403 list denial hides cached rows and never retries on reopen, focus or remount", async () => {
  let gets = 0;
  const view = await mount({ get: () => ++gets === 1 ? json({ items: [item()], nextCursor: null }) : json({ error: "Membership finance permission required" }, 403) });
  try {
    await expand();
    await click(button("Refresh expiry reviews"));
    await waitFor(() => view.container.textContent.includes("Finance access was denied"));
    assert.equal(row(), null);
    assert.equal(button("Retry loading expiry reviews"), undefined);
    await click(header()); await click(header());
    await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); await new Promise(resolve => setTimeout(resolve, 25)); });
    assert.equal(gets, 2);
    await act(async () => view.render("remounted"));
    await click(header());
    await waitFor(() => view.container.textContent.includes("Finance access was denied"));
    assert.equal(gets, 2);
    assert.equal(row(), null);
  } finally { await view.cleanup(); }
});

test("POST 403 removes all protected records and prevents further queries or audit saves", async () => {
  const view = await mount({ post: () => json({ error: "Finance permission revoked" }, 403) });
  try {
    await expand();
    await note("Review attempt after role changed");
    await click(button("Save finance review"));
    await waitFor(() => view.container.textContent.includes("Finance access was denied"));
    assert.equal(row(), null);
    assert.equal(button("Save finance review"), undefined);
    await click(header()); await click(header());
    assert.equal(view.calls.length, 2);
    await act(async () => view.render("remounted-after-post-denial"));
    await click(header());
    assert.match(view.container.textContent, /Finance access was denied/);
    assert.equal(row(), null);
    assert.equal(view.calls.length, 2);
  } finally { await view.cleanup(); }
});

test("transient GET errors do not auto-retry, provide explicit retry and never imply empty success", async () => {
  let gets = 0;
  const view = await mount({ get: () => ++gets === 1 ? json({ error: "Expiry audit storage unavailable" }, 503) : json({ items: [item()], nextCursor: null }) });
  try {
    await expand();
    assert.match(view.container.textContent, /Expiry audit storage unavailable/);
    assert.doesNotMatch(view.container.textContent, /No outstanding expired/);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.equal(gets, 1);
    await click(button("Retry loading expiry reviews"));
    await waitFor(() => row());
    assert.equal(gets, 2);
  } finally { await view.cleanup(); }
});

test("server validation error remains visible and does not claim a recorded review", async () => {
  const view = await mount({ post: () => json({ error: { message: "Expired credit ownership could not be verified" } }, 422) });
  try {
    await expand(); await note("Check owner evidence");
    await click(button("Save finance review"));
    await waitFor(() => row().textContent.includes("Expired credit ownership could not be verified"));
    assert.doesNotMatch(row().textContent, /Finance review recorded\./);
    assert.equal(row().querySelector("textarea").value, "Check owner evidence");
  } finally { await view.cleanup(); }
});

test("uncertain audit save locks repeat POST and resolves through read-only current review evidence", async () => {
  let saved = null;
  const view = await mount({
    get: () => json({ items: [item({ lastReview: saved, needsReview: !saved })], nextCursor: null }),
    post: payload => { saved = review({ note: payload.note }); throw new Error("Review response connection lost"); },
  });
  try {
    await expand(); await note("Keep the outstanding liability under review");
    await click(button("Save finance review"));
    await waitFor(() => row().textContent.includes("Review outcome unconfirmed"));
    assert.equal(button("Save finance review").disabled, true);
    assert.equal(row().querySelector("textarea").disabled, true);
    await click(button("Check review outcome"));
    await waitFor(() => row().textContent.includes("Finance review recorded."));
    assert.equal(view.calls.filter(call => call.payload).length, 1);
    assert.doesNotMatch(row().textContent, /Review outcome unconfirmed/);
    assert.match(row().textContent, /Liability and spendability are unchanged/);
  } finally { await view.cleanup(); }
});

test("malformed review response cannot report success or permit automatic duplicate submission", async () => {
  const view = await mount({ post: () => json({ review: { note: "missing evidence" } }) });
  try {
    await expand(); await note("Review the liability");
    await click(button("Save finance review"));
    await waitFor(() => row().textContent.includes("complete matching review audit record"));
    assert.equal(button("Save finance review").disabled, true);
    assert.doesNotMatch(row().textContent, /Finance review recorded\./);
  } finally { await view.cleanup(); }
});

test("tenant/account switches reset the form and ignore late GET/POST results", async () => {
  for (const action of ["get", "post"]) {
    let resolve;
    const gate = new Promise(done => { resolve = done; });
    const view = await mount({
      get: action === "get" ? () => gate : undefined,
      post: action === "post" ? () => gate : undefined,
    });
    try {
      await click(header());
      if (action === "post") {
        await waitFor(() => row());
        await note("Private note for the original tenant only");
        await click(button("Save finance review"));
      }
      globalThis.expiryTenant = "tenant-next";
      globalThis.expiryAccess = access({ memberInfo: { id: "viewer-next", tenant_id: "tenant-next", role_id: "role-next" } });
      await act(async () => view.render());
      assert.equal(header().getAttribute("aria-expanded"), "false");
      assert.equal(row(), null);
      await act(async () => resolve(action === "get" ? json({ items: [item()], nextCursor: null }) : json({ review: review({ note: "Private note for the original tenant only" }) })));
      assert.equal(row(), null);
      assert.doesNotMatch(view.container.textContent, /Private note|MC-7K43|Finance review recorded\./);
      assert.ok(view.calls.every(call => call.tenantId === "tenant-finance"));
    } finally { await view.cleanup(); }
  }
});

test("permission revocation unmounts cached finance content without further requests", async () => {
  const view = await mount();
  try {
    await expand(); assert.ok(row());
    globalThis.expiryAccess = access({ isFeatureExcluded: feature => feature === "commerce.monthly-finance-report" });
    await act(async () => view.render());
    assert.equal(view.container.textContent, "");
    assert.equal(view.calls.length, 1);
  } finally { await view.cleanup(); }
});

test("loading skeleton and invalid list/balance evidence are distinct from a valid empty queue", async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  let view = await mount({ get: () => gate });
  try {
    await click(header());
    assert.ok(document.querySelector('[aria-label="Loading expired membership-change credits"]'));
    await act(async () => resolve(json({ malformed: [] })));
    await waitFor(() => view.container.textContent.includes("valid expiry-review list"));
    assert.doesNotMatch(view.container.textContent, /No outstanding expired/);
  } finally { await view.cleanup(); }
  view = await mount({ items: [item({ currency: null })] });
  try {
    await expand();
    assert.match(view.container.textContent, /incomplete balance, currency or expiry evidence/);
    assert.equal(row(), null);
    assert.doesNotMatch(view.container.textContent, /£43.27/);
  } finally { await view.cleanup(); }
});

test("Load more appends pages, encodes cursors, preserves earlier notes, deduplicates overlap and suppresses double clicks", async () => {
  const firstCursor = "next/one+?=";
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const view = await mount({ get: url => {
    const after = new URL(url, "https://isolated.example.test").searchParams.get("after");
    if (!after) return json({ items: [item()], nextCursor: firstCursor });
    if (after === firstCursor) return gate;
    assert.equal(after, "next-two");
    return json({ items: [item({ amendmentId: "amendment-third", voucherCode: "MC-THIRD" })], nextCursor: null });
  } });
  try {
    await expand();
    await note("Unsaved note on the original page");
    const more = button("Load more");
    await act(async () => { more.click(); more.click(); });
    assert.equal(view.calls.length, 2);
    assert.equal(view.calls[1].url, `/api/membership/member-amendments?action=credit_expiry_reviews&after=${encodeURIComponent(firstCursor)}`);
    assert.ok(row());
    assert.equal(row().querySelector("textarea").value, "Unsaved note on the original page");
    assert.ok(document.querySelector('[aria-label="Loading more expired membership-change credits"]'));
    await act(async () => resolve(json({
      items: [
        item({ lastReview: review(), needsReview: false }),
        item({ amendmentId: "amendment-second", voucherCode: "MC-SECOND" }),
      ],
      nextCursor: "next-two",
    })));
    await waitFor(() => row("amendment-second"));
    assert.equal(document.querySelectorAll("article").length, 2);
    assert.equal(row().querySelector("textarea").value, "Unsaved note on the original page");
    assert.match(row().textContent, /Liability confirmed/);
    await click(button("Load more"));
    await waitFor(() => row("amendment-third"));
    assert.equal(document.querySelectorAll("article").length, 3);
    assert.equal(button("Load more"), undefined);
    assert.equal(view.calls.length, 3);
    assert.equal(row().querySelector("textarea").value, "Unsaved note on the original page");
  } finally { await view.cleanup(); }
});

test("repeated or cyclic next cursors stop pagination without discarding loaded rows", async () => {
  for (const cycle of [false, true]) {
    const view = await mount({ get: url => {
      const after = new URL(url, "https://isolated.example.test").searchParams.get("after");
      if (!after) return json({ items: [item()], nextCursor: "cursor-a" });
      if (after === "cursor-a") return json({ items: [item({ amendmentId: "amendment-second" })], nextCursor: cycle ? "cursor-b" : "cursor-a" });
      assert.equal(after, "cursor-b");
      return json({ items: [item({ amendmentId: "amendment-third" })], nextCursor: "cursor-a" });
    } });
    try {
      await expand(); await click(button("Load more"));
      await waitFor(() => row("amendment-second"));
      if (cycle) { await click(button("Load more")); await waitFor(() => row("amendment-third")); }
      assert.match(view.container.textContent, /previously used cursor/);
      assert.equal(button("Load more"), undefined);
      assert.ok(row());
      const requested = view.calls.map(call => new URL(call.url, "https://isolated.example.test").searchParams.get("after")).filter(Boolean);
      assert.equal(new Set(requested).size, requested.length);
      assert.equal(view.calls.length, cycle ? 3 : 2);
      await click(header()); await click(header());
      assert.equal(view.calls.length, cycle ? 3 : 2);
    } finally { await view.cleanup(); }
  }
});

test("a failed next page retains prior rows and permits only explicit retry of that page", async () => {
  let attempts = 0;
  const view = await mount({ get: url => {
    if (!url.includes("&after=")) return json({ items: [item()], nextCursor: "cursor-more" });
    return ++attempts === 1 ? json({ error: "Next-page storage unavailable" }, 503)
      : json({ items: [item({ amendmentId: "amendment-second" })], nextCursor: null });
  } });
  try {
    await expand(); await click(button("Load more"));
    await waitFor(() => button("Retry loading more expiry reviews"));
    assert.ok(row());
    assert.match(view.container.textContent, /Next-page storage unavailable/);
    assert.equal(view.calls.length, 2);
    assert.equal(button("Save finance review").disabled, true);
    await click(button("Retry loading more expiry reviews"));
    await waitFor(() => row("amendment-second"));
    assert.equal(document.querySelectorAll("article").length, 2);
    assert.equal(view.calls.length, 3);
    assert.equal(view.calls[1].url, view.calls[2].url);
    assert.equal(button("Load more"), undefined);
  } finally { await view.cleanup(); }
});

test("saving after loading multiple pages invalidates and refreshes all loaded evidence without removing earlier rows", async () => {
  let latest = null;
  const view = await mount({
    get: url => url.includes("&after=")
      ? json({ items: [item({ amendmentId: "amendment-second" })], nextCursor: null })
      : json({ items: [item({ lastReview: latest, needsReview: !latest })], nextCursor: "cursor-more" }),
    post: payload => { latest = review({ note: payload.note }); return json({ review: latest }); },
  });
  try {
    await expand(); await click(button("Load more"));
    await waitFor(() => row("amendment-second"));
    await note("Audit the first credit after loading more");
    await click(button("Save finance review", row()));
    await waitFor(() => view.calls.filter(call => !call.payload).length >= 4 && row().textContent.includes("Finance review recorded."));
    assert.ok(row("amendment-second"));
    assert.equal(document.querySelectorAll("article").length, 2);
    assert.match(row().textContent, /Audit the first credit after loading more/);
  } finally { await view.cleanup(); }
});

test("late load-more response cannot append old tenant records or cursors after a tenant/account switch", async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const view = await mount({ get: (url, options) => {
    if (options.headers["X-Tenant-Id"] === "tenant-next") {
      return json({ items: [item({ amendmentId: "next-tenant-credit", voucherCode: "MC-NEXT", memberId: "next-owner" })], nextCursor: null });
    }
    return url.includes("&after=") ? gate : json({ items: [item()], nextCursor: "old-tenant-cursor" });
  } });
  try {
    await expand(); await note("Original tenant unsaved note"); await click(button("Load more"));
    assert.equal(view.calls.length, 2);
    globalThis.expiryTenant = "tenant-next";
    globalThis.expiryAccess = access({ memberInfo: { id: "viewer-next", tenant_id: "tenant-next", role_id: "next-role" } });
    await act(async () => view.render());
    assert.equal(header().getAttribute("aria-expanded"), "false");
    assert.equal(row(), null);
    await click(header());
    await waitFor(() => row("next-tenant-credit"));
    await act(async () => resolve(json({ items: [item({ amendmentId: "old-tenant-late", voucherCode: "MC-OLD-LATE" })], nextCursor: "another-old-cursor" })));
    assert.equal(row(), null);
    assert.equal(row("old-tenant-late"), null);
    assert.equal(document.querySelectorAll("article").length, 1);
    assert.equal(row("next-tenant-credit").querySelector("textarea").value, "");
    assert.doesNotMatch(view.container.textContent, /Original tenant unsaved note|MC-OLD-LATE|MC-7K43/);
    assert.equal(button("Load more"), undefined);
    assert.deepEqual(view.calls.map(call => call.tenantId), ["tenant-finance", "tenant-finance", "tenant-next"]);
    assert.equal(view.calls.at(-1).url, "/api/membership/member-amendments?action=credit_expiry_reviews");
  } finally { await view.cleanup(); }
});

test("next-page 403 hides all loaded finance records and stops pagination retries", async () => {
  const view = await mount({ get: url => url.includes("&after=")
    ? json({ error: "Finance permission revoked" }, 403)
    : json({ items: [item()], nextCursor: "cursor-denied" }) });
  try {
    await expand(); await click(button("Load more"));
    await waitFor(() => view.container.textContent.includes("Finance access was denied"));
    assert.equal(row(), null);
    assert.equal(button("Load more"), undefined);
    assert.equal(button("Retry loading more expiry reviews"), undefined);
    await click(header()); await click(header());
    assert.equal(view.calls.length, 2);
  } finally { await view.cleanup(); }
});
