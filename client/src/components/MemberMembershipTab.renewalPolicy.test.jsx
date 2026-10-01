import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
  Element: dom.window.Element, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
  Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { default: MemberMembershipTab } = await import("./MemberMembershipTab.jsx");
after(() => dom.window.close());

const policy = {
  policySource: "operator_assigned_expiry_only", configId: "approved-config",
  configName: "2026-2027 Full member", paidThroughDate: "2026-09-25",
  graceEndDate: "2026-12-24", renewalGraceDays: 90,
};
const historical = {
  id: "paid-history", membership_source: "personal", membership_year: "2025/2026",
  tier_label: "Full member", config_id: null, commitment_snapshot: null,
  term_start_date: null, term_end_date: "2026-09-25", membership_renewal_date: null,
  annual_cost: null, final_cost: null, total_with_vat: null, prorata_cost: null,
  payment_method: "upfront", billing_period: "annual", payment_status: "paid",
  status: "active", currency: "GBP",
};

async function mounted({ projection = {}, grace = true, paidAmount = null } = {}, callback) {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity, gcTime: 0 },
    mutations: { retry: false, gcTime: 0 },
  } });
  client.setQueryData(["member-membership", "member"], {
    config: null, currentYearCost: null, nextYearPreview: null,
    currentCommitments: [], commitments: [],
    legacyCurrentMembership: {
      id: historical.id, membershipYear: "2025/2026", tierLabel: "Full member",
      startDate: null, endDate: "2026-09-25", renewalDate: null, paidAmount, currency: "GBP",
      ...(grace ? { grace: { inGrace: true, graceEndDate: "2026-12-24",
        policySource: "display_only_renewal_boundary" } } : {}),
      ...projection,
    },
    history: [{ ...historical, ...projection }],
  });
  client.setQueryData(["membership-settings"], { require_approval: false });
  client.setQueryData(["member-membership-invoicing-settings", "member"], { settings: {} });
  client.setQueryData(["member-membership-override", "member", null], {});
  client.setQueryData(["historical-dd-payments", null, "member"], []);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    throw new Error(`Unexpected network request: ${url}`);
  };
  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}><MemberMembershipTab memberId="member" /></QueryClientProvider>,
    ));
    await callback(container, calls);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  }
}

test("approved policy is distinct from historical structure, amount, start and year in current panel and ledger", async () => {
  await mounted({ projection: { expiry_renewal_policy: policy } }, (container, calls) => {
    const current = container.querySelector('[data-testid="card-member-legacy-current"]');
    const ledger = container.querySelector('[data-testid="row-member-history-paid-history"]');
    for (const section of [current, ledger]) {
      assert.match(section.textContent, /Renewal policy: 2026-2027 Full member/);
      assert.match(section.textContent, /Grace through 24 Dec 2026 \(90-day grace period\)/);
      assert.match(section.textContent, /not the historical purchased structure or price/);
      assert.match(section.textContent, /Structure unknown/);
      assert.match(section.textContent, /2025\/2026/);
      assert.doesNotMatch(section.textContent, /DISPLAY ONLY/);
    }
    assert.equal(current.querySelector('[data-testid="text-legacy-current-start"]').textContent, "Unknown");
    assert.equal(current.querySelector('[data-testid="text-legacy-current-price"]').textContent, "Unknown");
    assert.match(current.querySelector('[data-testid="text-legacy-current-end"]').textContent, /25 Sept? 2026/);
    assert.match(current.textContent, /Paid recorded term · read-only/);
    assert.equal(container.querySelector('[data-testid="button-member-simulate-current-year"]'), null);
    assert.deepEqual(calls, []);
  });
});

test("assigned policy displays before expiry without inventing a future commitment or overwriting known paid amount", async () => {
  await mounted({ projection: { expiry_renewal_policy: policy }, grace: false, paidAmount: 123 },
    (container, calls) => {
      const current = container.querySelector('[data-testid="card-member-legacy-current"]');
      assert.match(current.textContent, /Renewal policy: 2026-2027 Full member/);
      assert.match(current.querySelector('[data-testid="text-legacy-current-price"]').textContent, /£123\.00/);
      assert.match(current.textContent, /No start date, renewal date, or future commitment was recorded/);
      assert.deepEqual(calls, []);
    });
});

test("absent assignment retains honest display-only warning and never borrows a renewal policy name", async () => {
  await mounted({}, container => {
    assert.match(container.textContent, /DISPLAY ONLY/);
    assert.equal(container.querySelector('[data-testid="renewal-policy-paid-history"]'), null);
    assert.doesNotMatch(container.textContent, /Renewal policy: 2026-2027 Full member/);
  });
});

test("unavailable policy is an explicit error, not a verified assignment", async () => {
  await mounted({ projection: { expiry_renewal_policy_error: "Renewal policy unavailable. The approved assignment could not be verified." }, grace: false },
    container => {
      const error = container.querySelector('[data-testid="renewal-policy-unavailable-paid-history"]');
      assert.equal(error.getAttribute("role"), "alert");
      assert.match(error.textContent, /Renewal policy unavailable/);
      assert.equal(container.querySelector('[data-testid="renewal-policy-paid-history"]'), null);
      assert.match(container.textContent, /Structure unknown/);
    });
});