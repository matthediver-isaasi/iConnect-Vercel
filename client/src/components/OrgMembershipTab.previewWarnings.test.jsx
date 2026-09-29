import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: callback => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");
const { default: OrgMembershipTab } = await import("./OrgMembershipTab.jsx");
after(() => dom.window.close());

const year = (membershipYear, yearNumber, finalCost) => ({
  membershipYear, yearNumber, finalCost, annualCost: finalCost,
  annualCostBeforeDiscounts: finalCost, currency: "GBP",
});
const current = year("2026/2027", 1, 123.45);
const next = year("2027/2028", 2, 678.90);
const warning = (membershipYear, message) => ({
  membershipYear, code: "new_member_incentive_review_required", message,
});

async function mounted(data, callback) {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity, gcTime: 0 },
    mutations: { retry: false, gcTime: 0 },
  } });
  client.setQueryData(["org-membership", "org"], {
    config: { id: "config", name: "Structure", currency: "GBP", billing_period: "annual",
      pricing_model: "flat", flat_cost: 555 },
    currentYear: { label: "2026/2027" },
    currentYearCost: current,
    nextYearPreview: next,
    previewWarnings: { currentYear: null, nextYear: null },
    history: [{ id: "old", membership_year: "2025/2026", final_cost: 42, currency: "GBP",
      status: "active", payment_status: "paid" }],
    bands: [],
    ...data,
  });
  client.setQueryData(["membership-settings"], { require_approval: false });
  client.setQueryData(["org-membership-invoicing", "org"], { settings: {} });
  client.setQueryData(["member-join-form-setting"], null);
  client.setQueryData(["member-join-forms-by-org-type-setting"], null);
  client.setQueryData(["org-preference-fields-for-join-link"], []);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/membership/simulate-renewal" && options?.method === "POST") {
      return { ok: true, json: async () => ({ success: true, steps: [], membershipYear: JSON.parse(options.body).targetYear }) };
    }
    throw new Error(`Unexpected network request: ${url}`);
  };
  try {
    await act(async () => root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}><OrgMembershipTab organizationId="org" /></QueryClientProvider>
      </MemoryRouter>,
    ));
    await callback({ container, calls });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  }
}

function section(container, suffix) {
  return container.querySelector(`[data-testid="section-${suffix}"]`);
}

test("current-year review warns locally without displaying a fee or blocking next-year simulation and history", async () => {
  await mounted({
    currentYearCost: null,
    previewWarnings: { currentYear: warning("2026/2027", "Joining evidence needs review."), nextYear: null },
  }, async ({ container, calls }) => {
    const currentWarning = container.querySelector('[data-testid="preview-warning-current-year"]');
    assert.equal(currentWarning.getAttribute("role"), "alert");
    assert.match(currentWarning.textContent, /Fees cannot yet be verified for 2026\/2027/);
    assert.match(currentWarning.textContent, /Joining evidence needs review/);
    assert.equal(section(container, "current-year"), null);
    assert.equal(container.querySelector('[data-testid="text-annual-cost"]'), null);
    assert.equal(container.querySelector('[data-testid="button-record-current"]'), null);
    assert.equal(container.querySelector('[data-testid="button-simulate-current-year"]'), null);
    assert.equal(container.querySelector('[data-testid="button-email-fees-current-year"]'), null);
    assert.match(section(container, "next-year").textContent, /£678\.90/);
    assert.ok(container.querySelector('[data-testid="table-history"]'));
    assert.ok(container.querySelector('[data-testid="text-structure-name"]'));
    await act(async () => container.querySelector('[data-testid="button-simulate-next-year"]').click());
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      organizationId: "org", mode: "manual", targetYear: "2027/2028",
    });
    assert.equal(calls.length, 1);
  });
});

test("next-year review leaves current-year fee and simulation available but no future financial controls", async () => {
  await mounted({
    nextYearPreview: null,
    previewWarnings: { currentYear: null, nextYear: warning("2027/2028", "Original entitlement is unavailable.") },
  }, async ({ container, calls }) => {
    const nextWarning = container.querySelector('[data-testid="preview-warning-next-year"]');
    assert.equal(nextWarning.getAttribute("role"), "alert");
    assert.match(nextWarning.textContent, /2027\/2028.*Original entitlement is unavailable/);
    assert.equal(section(container, "next-year"), null);
    for (const action of ["simulate", "override", "email-fees", "renew-now", "invoice-now", "save-invoicing"]) {
      assert.equal(container.querySelector(`[data-testid="button-${action}-next-year"]`), null);
    }
    assert.match(section(container, "current-year").textContent, /£123\.45/);
    assert.ok(container.querySelector('[data-testid="button-record-current"]'));
    assert.ok(container.querySelector('[data-testid="table-history"]'));
    await act(async () => container.querySelector('[data-testid="button-simulate-current-year"]').click());
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      organizationId: "org", mode: "manual", targetYear: "2026/2027",
    });
    assert.equal(calls.length, 1);
  });
});

test("successful previews keep both fee cards and their actions, without review alerts", async () => {
  await mounted({}, async ({ container, calls }) => {
    assert.equal(container.querySelectorAll('[data-testid^="preview-warning-"]').length, 0);
    assert.match(section(container, "current-year").textContent, /£123\.45/);
    assert.match(section(container, "next-year").textContent, /£678\.90/);
    assert.ok(container.querySelector('[data-testid="button-record-current"]'));
    assert.ok(container.querySelector('[data-testid="button-simulate-next-year"]'));
    assert.ok(container.querySelector('[data-testid="table-history"]'));
    assert.equal(calls.length, 0);
  });
});