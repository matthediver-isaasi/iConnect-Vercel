import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { url: "https://portal.example.test/History" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "CustomEvent", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, {
    value: key === "window" ? dom.window : key === "getComputedStyle" ? dom.window.getComputedStyle : dom.window[key],
    configurable: true, writable: true,
  });
}
globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { default: HistoryMandateReplacement, hostedMandateUrl } = await import("./HistoryMandateReplacement.jsx");
const { mandateReplacementKey, requestMandateReplacement } = await import("./useMandateReplacement.js");
const eligible = { eligible: true, canStart: true, canResume: false };
const memberInfo = { id: "member-7", tenant_id: "tenant-3" };
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const button = (text) => [...document.querySelectorAll("button")].find(node => node.textContent === text);

async function fixture(payload = eligible, member = memberInfo, handler) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const result = handler ? await handler(options, calls.length) : payload;
    return { ok: true, json: async () => result };
  };
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 }, mutations: { gcTime: 0 } } });
  const root = createRoot(document.getElementById("root"));
  await React.act(async () => { root.render(<QueryClientProvider client={client}><HistoryMandateReplacement memberInfo={member} /></QueryClientProvider>); });
  await React.act(pause);
  return {
    calls, client,
    async close() {
      await React.act(async () => root.unmount());
      client.clear();
      globalThis.fetch = originalFetch;
      delete window.GoCardlessDropin;
    },
  };
}

test("request contract uses credentials, tenant and exact action; rejects unsafe hosted URLs", async () => {
  await requestMandateReplacement({
    action: "refresh", tenantId: "tenant-3",
    request: async (url, options) => {
      assert.equal(url, "/api/membership/mandate-replacement");
      assert.equal(options.credentials, "include");
      assert.equal(options.headers["X-Tenant-Id"], "tenant-3");
      assert.deepEqual(JSON.parse(options.body), { action: "refresh" });
      return { ok: true, json: async () => eligible };
    },
  });
  assert.notDeepEqual(mandateReplacementKey("a", "m"), mandateReplacementKey("b", "m"));
  assert.notDeepEqual(mandateReplacementKey("a", "m"), mandateReplacementKey("a", "n"));
  assert.equal(hostedMandateUrl("javascript:alert(1)"), null);
  assert.equal(hostedMandateUrl("http://example.test"), null);
  assert.equal(hostedMandateUrl("https://pay.gocardless.com/flow"), "https://pay.gocardless.com/flow");
});

test("no member means no request; non-DD eligibility hides CTA", async () => {
  let f = await fixture(eligible, null);
  try { assert.equal(f.calls.length, 0); assert.equal(button("Change Direct Debit"), undefined); }
  finally { await f.close(); }
  f = await fixture({ ...eligible, eligible: false });
  try { assert.equal(button("Change Direct Debit"), undefined); }
  finally { await f.close(); }
});

test("eligible blocked member sees reason and confirmation but cannot start", async () => {
  const f = await fixture({ ...eligible, canStart: false, reason: "Please contact the membership team." });
  try {
    await React.act(async () => button("Change Direct Debit").click());
    const text = document.querySelector('[role="dialog"]').textContent;
    assert.match(text, /exclusively on GoCardless/);
    assert.match(text, /old working mandate remains in place until a verified handover/);
    assert.match(text, /Please contact the membership team/);
    assert.equal(button("Continue to GoCardless"), undefined);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("double start is blocked and fail-closed action_required never claims completion", async () => {
  const f = await fixture(eligible, memberInfo, async options => {
    if (!options.method) return eligible;
    await pause();
    return { ...eligible, canStart: false, operation: { id: "op-1", status: "action_required", message: "Safe handover could not be verified." } };
  });
  try {
    await React.act(async () => button("Change Direct Debit").click());
    await React.act(async () => {
      const start = button("Continue to GoCardless");
      start.click();
      start.click();
      await pause();
    });
    await React.act(pause);
    assert.equal(f.calls.filter(call => call.options.method === "POST").length, 1);
    assert.deepEqual(JSON.parse(f.calls[1].options.body), { action: "start" });
    assert.match(document.body.textContent, /Action required — change not confirmed/);
    assert.match(document.body.textContent, /Safe handover could not be verified/);
    assert.doesNotMatch(document.body.textContent, /Direct Debit change verified/);
  } finally { await f.close(); }
});

test("resume uses shared Drop-in; browser success only reports pending and refreshes provider state", async () => {
  let callbacks;
  window.GoCardlessDropin = { create: options => {
    callbacks = options;
    return { open() {}, exit() {} };
  } };
  let posts = 0;
  const f = await fixture(eligible, memberInfo, options => {
    if (!options.method) return { ...eligible, canStart: false, canResume: true };
    posts++;
    if (JSON.parse(options.body).action === "start") return {
      ...eligible, canStart: false, canResume: true,
      operation: { id: "op-1", status: "authorizing" },
      flowId: "BRF-test", environment: "sandbox", authorisationUrl: "https://pay.gocardless.com/flow",
    };
    return { ...eligible, canStart: false, operation: { id: "op-1", status: "action_required", message: "Handover needs review." } };
  });
  try {
    await React.act(async () => button("Change Direct Debit").click());
    await React.act(async () => { button("Resume with GoCardless").click(); await pause(); });
    assert.equal(callbacks.billingRequestFlowID, "BRF-test");
    await React.act(async () => { callbacks.onSuccess({}, {}); await pause(); });
    await React.act(pause);
    assert.match(document.body.textContent, /pending verified confirmation; it is not yet complete/);
    assert.match(document.body.textContent, /Action required — change not confirmed/);
    assert.equal(document.querySelector('a[href="https://pay.gocardless.com/flow"]'), null);
    assert.ok(posts >= 2);
    assert.doesNotMatch(document.body.textContent, /Direct Debit change verified/);
  } finally { await f.close(); }
});

test("existing operation is verified on mount and page return", async () => {
  const payload = { ...eligible, canStart: false, operation: { id: "op-1", status: "awaiting_confirmation" } };
  const f = await fixture(payload);
  try {
    await React.act(pause);
    assert.ok(f.calls.some(call => call.options.body === '{"action":"refresh"}'));
    const count = f.calls.length;
    await React.act(async () => { window.dispatchEvent(new window.Event("pageshow")); await pause(); });
    assert.ok(f.calls.length > count);
    assert.equal(f.calls.at(-1).options.body, '{"action":"refresh"}');
  } finally { await f.close(); }
});

test("Drop-in exit refreshes without claiming cancellation and offers explicit hosted resume", async () => {
  let callbacks;
  window.GoCardlessDropin = { create: options => {
    callbacks = options;
    return { open() {}, exit() {} };
  } };
  const operation = { id: "op-1", status: "authorizing" };
  const f = await fixture(eligible, memberInfo, options => {
    if (!options.method) return eligible;
    return {
      ...eligible, canStart: false, canResume: true, operation,
      ...(JSON.parse(options.body).action === "start" ? {
        flowId: "BRF-test", environment: "sandbox", authorisationUrl: "https://pay.gocardless.com/flow",
      } : {}),
    };
  });
  try {
    await React.act(async () => button("Change Direct Debit").click());
    await React.act(async () => { button("Continue to GoCardless").click(); await pause(); });
    await React.act(async () => { callbacks.onExit(null, {}); await pause(); });
    assert.match(document.body.textContent, /GoCardless was closed/);
    assert.match(document.body.textContent, /your change is not confirmed/);
    assert.ok(document.querySelector('a[href="https://pay.gocardless.com/flow"]'));
    assert.equal(f.calls.at(-1).options.body, '{"action":"refresh"}');
    assert.doesNotMatch(document.body.textContent, /Direct Debit change cancelled|Direct Debit change verified/);
  } finally { await f.close(); }
});
