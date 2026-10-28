import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// All requests are mocked; these mounted tests never contact a provider.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const bundle = await build({
  entryPoints: ["client/src/components/MemberCancellationFinancialRecovery.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "isolated-cancellation-finances",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\// }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        loader: "js",
        contents: path.endsWith("adminFetch")
          ? "export const adminFetch = (url, options = {}, tenantId) => globalThis.fetch(url, {...options, credentials:'include', headers:{...options.headers, 'X-Tenant-Id':tenantId}});"
          : `import React from "react";
            const wrap = tag => ({children, variant, size, ...props}) => React.createElement(tag, props, children);
            export const Button = wrap("button"), Badge = wrap("span"), Label = wrap("label");`,
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/cancellation-finances-mounted.cjs`);
compiled.filename = `${process.cwd()}/cancellation-finances-mounted.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const id = "194e917e-e1ae-4bb6-9e8e-e3970ff1f8be";
const secondId = "294e917e-e1ae-4bb6-9e8e-e3970ff1f8be";
const record = (requestId = id) => ({ id: requestId, financial_state: "pending", effective_date: "2026-04-17", timing: "immediate", access_ended_at: "2026-04-17T12:05:00Z" });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const preview = (choice = "refund", memberId = "member-safe") => ({
  plan: {
    version: 1, requestId: id, memberId, currency: "GBP", choice,
    debtMinor: 0, surplusMinor: 4327, retainedPrepaidMinor: 0,
    returnAmount: { netMinor: 3606, vatMinor: 721, grossMinor: 4327 },
    steps: [{ kind: "credit_note", amount: { netMinor: 3606, vatMinor: 721, grossMinor: 4327 } }],
  },
  fingerprint: "a".repeat(64),
  evidence: { providerEvidence: "SENSITIVE_PROVIDER_EVIDENCE" },
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const button = label => [...document.querySelectorAll("button")].find(item => item.textContent === label);
async function click(element) {
  assert.ok(element);
  assert.equal(element.disabled, false);
  await act(async () => element.click());
}
async function waitFor(predicate) {
  for (let count = 0; count < 60; count++) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  assert.fail("Timed out waiting for cancellation financial UI");
}
async function changeChoice(value) {
  const select = document.querySelector("select");
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set.call(select, value);
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
async function mount({ get, post, actionsEnabled = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, "include");
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, payload, tenantId: options.headers["X-Tenant-Id"] });
    return payload ? (post ? post(payload) : json(preview())) : (get ? get(url) : json({ records: [record()], nextCursor: null }));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (props = {}) => root.render(React.createElement(Component, { memberId: "member-safe", tenantId: "tenant-safe", actionsEnabled, ...props }));
  await act(async () => render());
  return { calls, container, render, async cleanup() { await act(async () => root.unmount()); container.remove(); } };
}
const previewButton = () => button("Preview cancellation finances");
const confirmButton = () => button("Approve cancellation financial plan");
const recoverButton = () => button("Recover approved cancellation finances");
async function prepare() {
  await waitFor(previewButton);
  await click(previewButton());
  await waitFor(confirmButton);
}

test("explicit page loading, pagination cursor, empty state and list retry", async () => {
  const first = deferred();
  let fail = false;
  const mounted = await mount({ get: url => {
    if (!url.includes("after=")) return first.promise;
    if (fail) return json({ error: "Page temporarily unavailable" }, 503);
    return json({ records: [record(secondId)], nextCursor: null });
  } });
  try {
    assert.ok(document.querySelector('[aria-label="Loading cancellation finances"]'));
    assert.equal(mounted.calls.length, 1);
    await act(async () => first.resolve(json({ records: [record()], nextCursor: secondId })));
    await waitFor(() => button("Load more cancellations"));
    assert.equal(mounted.calls.length, 1, "pagination is not automatic");
    fail = true;
    await click(button("Load more cancellations"));
    await waitFor(() => button("Retry loading cancellation finances"));
    assert.match(mounted.container.textContent, /Page temporarily unavailable/);
    fail = false;
    await click(button("Retry loading cancellation finances"));
    await waitFor(() => document.querySelectorAll("article").length === 2);
    assert.equal(new URL(mounted.calls[1].url, "https://test.invalid").searchParams.get("after"), secondId);
    assert.equal(new URL(mounted.calls[0].url, "https://test.invalid").searchParams.get("action"), "cancellation_finances");
    assert.equal(new URL(mounted.calls[0].url, "https://test.invalid").searchParams.get("memberId"), "member-safe");
  } finally { await mounted.cleanup(); }
  const empty = await mount({ get: () => json({ records: [], nextCursor: null }) });
  try {
    await waitFor(() => empty.container.textContent.includes("No applied cancellations"));
    assert.equal(previewButton(), undefined);
  } finally { await empty.cleanup(); }
});

test("preview summary hides provider evidence and requires checkbox; choice clears approval and preview", async () => {
  const mounted = await mount();
  try {
    await prepare();
    assert.equal(confirmButton().disabled, true);
    assert.match(mounted.container.textContent, /£43.27/);
    assert.match(mounted.container.textContent, /£36.06/);
    assert.match(mounted.container.textContent, /£7.21/);
    assert.doesNotMatch(mounted.container.textContent, /SENSITIVE_PROVIDER_EVIDENCE|netMinor|providerEvidence/);
    assert.match(mounted.container.textContent, /does not send a cash refund/);
    await click(document.querySelector('input[type="checkbox"]'));
    assert.equal(confirmButton().disabled, false);
    await changeChoice("credit");
    assert.equal(confirmButton(), undefined);
    await click(previewButton());
    assert.equal(mounted.calls.at(-1).payload.choice, "credit");
  } finally { await mounted.cleanup(); }
});

test("confirmation payload binds choice and fingerprint and duplicate clicks are blocked", async () => {
  const confirmation = deferred();
  const mounted = await mount({ post: payload => payload.action === "preview_cancellation_finance" ? json(preview()) : confirmation.promise });
  try {
    await prepare();
    await click(document.querySelector('input[type="checkbox"]'));
    const confirm = confirmButton();
    await act(async () => { confirm.click(); confirm.click(); });
    const writes = mounted.calls.filter(call => call.payload?.action === "confirm_cancellation_finance");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].payload, {
      action: "confirm_cancellation_finance", memberId: "member-safe", requestId: id,
      choice: "refund", expectedFingerprint: "a".repeat(64), approve: true,
    });
    assert.equal(writes[0].tenantId, "tenant-safe");
    assert.equal(recoverButton().disabled, true);
    await act(async () => confirmation.resolve(json({ state: "pending", balanceState: "awaiting_refund", message: "Waiting for bank reconciliation." })));
    await waitFor(() => !recoverButton().disabled);
    assert.match(mounted.container.textContent, /awaiting refund/);
    assert.equal(confirmButton(), undefined);
    assert.equal(previewButton(), undefined);
  } finally { await mounted.cleanup(); }
});

test("unknown confirmation never retries approval; recovery has no approval fields", async () => {
  const mounted = await mount({ post: payload => {
    if (payload.action === "preview_cancellation_finance") return json(preview());
    if (payload.action === "confirm_cancellation_finance") throw new Error("Network connection lost");
    return json({ state: "pending", needsApproval: true, message: "Review and approve the financial outcome." });
  } });
  try {
    await prepare();
    await click(document.querySelector('input[type="checkbox"]'));
    await click(confirmButton());
    await waitFor(() => mounted.container.textContent.includes("Network connection lost"));
    assert.equal(confirmButton(), undefined);
    assert.equal(previewButton(), undefined);
    await click(recoverButton());
    assert.deepEqual(mounted.calls.at(-1).payload, { action: "recover_cancellation_finance", memberId: "member-safe", requestId: id });
    await waitFor(previewButton);
    assert.equal(document.querySelector('input[type="checkbox"]'), null, "a fresh preview is required");
    assert.equal(mounted.calls.filter(call => call.payload?.approve).length, 1);
  } finally { await mounted.cleanup(); }
});

test("malformed successful confirmation and review results remain recovery-only", async () => {
  const mounted = await mount({ post: payload => {
    if (payload.action === "preview_cancellation_finance") return json(preview());
    if (payload.action === "confirm_cancellation_finance") return json({ unexpected: true });
    return json({ state: "pending", needsReview: true, message: "Accounting needs reconciliation." });
  } });
  try {
    await prepare();
    await click(document.querySelector("input"));
    await click(confirmButton());
    await waitFor(() => mounted.container.textContent.includes("Financial outcome is not confirmed"));
    assert.equal(previewButton(), undefined);
    await click(recoverButton());
    await waitFor(() => mounted.container.textContent.includes("Finance review"));
    assert.equal(previewButton(), undefined);
    assert.equal(confirmButton(), undefined);
  } finally { await mounted.cleanup(); }
});

test("recovery without preview can finish an approved plan and never approves treatment", async () => {
  const mounted = await mount({ post: () => json({ state: "done" }) });
  try {
    await waitFor(recoverButton);
    await click(recoverButton());
    await waitFor(() => mounted.container.textContent.includes("Cancellation finances completed"));
    assert.equal(mounted.calls.filter(call => call.payload).length, 1);
    assert.equal(mounted.calls.at(-1).payload.approve, undefined);
    assert.equal(previewButton(), undefined);
    assert.equal(recoverButton(), undefined);
  } finally { await mounted.cleanup(); }
});

test("unsupported monthly and mixed funding server errors remain explicit", async () => {
  for (const message of [
    "Monthly earned-service and receipt evidence needs its dedicated resolver.",
    "Return funded value to its original owner before allocating personal cancellation credit.",
  ]) {
    const mounted = await mount({ post: () => json({ error: { message } }, 409) });
    try {
      await waitFor(previewButton);
      await click(previewButton());
      await waitFor(() => mounted.container.textContent.includes(message));
      assert.equal(confirmButton(), undefined);
      assert.equal(mounted.calls.at(-1).payload.action, "preview_cancellation_finance");
    } finally { await mounted.cleanup(); }
  }
});

test("permissions disable every financial action and invalid bound preview cannot be approved", async () => {
  const disabled = await mount({ actionsEnabled: false });
  try {
    await waitFor(previewButton);
    assert.equal(previewButton().disabled, true);
    assert.equal(recoverButton().disabled, true);
    assert.equal(document.querySelector("select").disabled, true);
    assert.equal(disabled.calls.filter(call => call.payload).length, 0);
  } finally { await disabled.cleanup(); }
  const invalid = await mount({ post: () => json(preview("refund", "other-member")) });
  try {
    await waitFor(previewButton);
    await click(previewButton());
    await waitFor(() => invalid.container.textContent.includes("valid financial preview"));
    assert.equal(confirmButton(), undefined);
  } finally { await invalid.cleanup(); }
});

test("late list and preview responses are fenced across tenant/member changes", async () => {
  const oldList = deferred();
  const mounted = await mount({ get: url => url.includes("member-safe") ? oldList.promise : json({ records: [], nextCursor: null }) });
  try {
    await act(async () => mounted.render({ memberId: "member-other", tenantId: "tenant-other" }));
    await waitFor(() => mounted.container.textContent.includes("No applied cancellations"));
    await act(async () => oldList.resolve(json({ records: [record()], nextCursor: null })));
    assert.equal(document.querySelector("article"), null);
    assert.equal(mounted.calls.at(-1).tenantId, "tenant-other");
  } finally { await mounted.cleanup(); }
  const latePreview = deferred();
  const second = await mount({ post: () => latePreview.promise });
  try {
    await waitFor(previewButton);
    await click(previewButton());
    await act(async () => second.render({ memberId: "member-other", tenantId: "tenant-other" }));
    await waitFor(previewButton);
    await act(async () => latePreview.resolve(json(preview())));
    assert.equal(confirmButton(), undefined);
    assert.equal(document.querySelector('input[type="checkbox"]'), null);
  } finally { await second.cleanup(); }
});

test("permission changes discard previews and fence an in-flight preview even after permission returns", async () => {
  const response = deferred();
  const mounted = await mount({ post: () => response.promise });
  try {
    await waitFor(previewButton);
    await click(previewButton());
    await act(async () => mounted.render({ actionsEnabled: false }));
    await act(async () => mounted.render({ actionsEnabled: true }));
    await act(async () => response.resolve(json(preview())));
    await waitFor(() => !previewButton()?.disabled);
    assert.equal(confirmButton(), undefined);
    assert.equal(document.querySelector('input[type="checkbox"]'), null);
  } finally { await mounted.cleanup(); }
});

test("late confirmation completion cannot settle a different tenant/member record", async () => {
  const response = deferred();
  const mounted = await mount({ post: payload => payload.action === "preview_cancellation_finance" ? json(preview()) : response.promise });
  try {
    await prepare();
    await click(document.querySelector("input"));
    await click(confirmButton());
    await act(async () => mounted.render({ memberId: "member-other", tenantId: "tenant-other" }));
    await waitFor(previewButton);
    await act(async () => response.resolve(json({ state: "done" })));
    assert.doesNotMatch(mounted.container.textContent, /Cancellation finances completed|Financially settled/);
    assert.ok(previewButton());
    assert.equal(mounted.calls.find(call => call.payload?.approve)?.tenantId, "tenant-safe");
  } finally { await mounted.cleanup(); }
});

test("unreadable confirmation response offers recovery instead of a repeat confirmation", async () => {
  const mounted = await mount({ post: payload => payload.action === "preview_cancellation_finance"
    ? json(preview())
    : new Response("not-json", { status: 200 }) });
  try {
    await prepare();
    await click(document.querySelector("input"));
    await click(confirmButton());
    await waitFor(() => mounted.container.textContent.includes("unreadable response"));
    assert.equal(previewButton(), undefined);
    assert.equal(confirmButton(), undefined);
    assert.ok(recoverButton());
    assert.equal(mounted.calls.filter(call => call.payload?.approve).length, 1);
  } finally { await mounted.cleanup(); }
});

test("request lifecycle refresh rediscovers cancellation finances without discarding a current plan", async () => {
  const mounted = await mount();
  try {
    await prepare();
    await click(document.querySelector('input[type="checkbox"]'));
    const lists = () => mounted.calls.filter(call => !call.payload).length;
    const before = lists();
    await act(async () => mounted.render({ refreshVersion: 1 }));
    await waitFor(() => lists() > before);
    assert.ok(confirmButton());
    assert.equal(document.querySelector('input[type="checkbox"]').checked, true);
    assert.equal(confirmButton().disabled, false);
    assert.equal(mounted.calls.filter(call => call.payload?.approve).length, 0);
  } finally { await mounted.cleanup(); }
});
