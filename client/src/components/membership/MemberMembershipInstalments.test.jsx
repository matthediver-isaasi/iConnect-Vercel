import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MemberMembershipTab from "../MemberMembershipTab.jsx";
import MemberMembershipInstalments, {
  MemberMembershipInstalmentsToggle,
  getMembershipSource,
  isMonthlyMembershipRecord,
  isDynamicMonthlyCommitment,
  normalizeCollection,
} from "./MemberMembershipInstalments.jsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/member-detail",
});
Object.assign(globalThis, {
  React,
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { act } = React;

test("scheduled dynamic monthly plans use normal collection history without annual fee cards", () => {
  const memberId = "dynamic-monthly-test";
  const commitment = {
    id: "management-period",
    source: "personal",
    lifecycle: "scheduled",
    startDate: "2026-10-01",
    endDate: "2027-09-30",
    renewalDate: "2027-10-01",
    durationMonths: 12,
    paymentMethod: "direct_debit",
    paymentFrequency: "monthly",
    collectionPolicy: { pricing_policy: "dynamic", end_policy: "continue" },
  };
  assert.equal(isDynamicMonthlyCommitment(commitment), true);
  assert.equal(isDynamicMonthlyCommitment({ ...commitment, paymentFrequency: "annual" }), false);
  assert.equal(isMonthlyMembershipRecord({
    payment_method: "direct_debit",
    billing_agreement_id: "test-agreement",
    billing_period: "annual",
    commitment_snapshot: { collection_frequency: "monthly" },
  }), true);

  function render(policy) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["member-membership", memberId], {
      config: { name: "Test structure", billing_period: "annual", currency: "GBP" },
      currentCommitments: [{ ...commitment, collectionPolicy: policy,
        mandatePresentation: { mandateStatus: "active", awaitingFirstPayment: true, collectionHeld: false } }],
      currentYearCost: { membershipYear: "2026/2027", yearNumber: 1, annualCost: 120 },
      history: [],
    });
    // Test fixtures only; production renders only authenticated API evidence.
    client.setQueryData(["historical-dd-payments", null, memberId], Array.from({ length: 9 }, (_, index) => ({
      id: `import-${index}`,
      period: `2026-${String(index + 1).padStart(2, "0")}-01`,
      charge_date: `2026-${String(index + 1).padStart(2, "0")}-06`,
      amount_minor: 1304,
      currency: "GBP",
      provider_status: "paid_out",
      xero_invoice_number: `INV-TEST-${index}`,
      xero_invoice_url: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=test-${index}`,
      historical_only: true,
      invoice_available: true,
    })));
    const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(MemberMembershipTab, { memberId }),
    ));
    client.clear();
    return html;
  }
  const monthly = render(commitment.collectionPolicy);
  assert.doesNotMatch(monthly, /Current Year|Next Year|>Year 1</);
  assert.match(monthly, /Management Period Start/);
  assert.match(monthly, /1 Oct 2026/);
  assert.match(monthly, /30 Sept? 2027/);
  assert.match(monthly, /Monthly instalment history/);
  assert.equal((monthly.match(/data-testid="row-historical-dd-/g) || []).length, 9);
  assert.equal((monthly.match(/data-testid="button-view-historical-dd-invoice-/g) || []).length, 9);
  assert.equal((monthly.match(/data-testid="button-download-historical-dd-invoice-/g) || []).length, 9);
  assert.match(monthly, /January 2026/);
  assert.match(monthly, /September 2026/);
  assert.match(monthly, /£13\.04/);
  assert.match(monthly, /Paid out/);
  assert.match(monthly, /Imported historical payment/);
  assert.match(monthly, /Existing Direct Debit mandate active/);
  assert.match(monthly, /awaiting its first payment/);
  assert.match(monthly, /do not settle an upcoming term or establish current membership entitlement/);
  assert.doesNotMatch(monthly, /card-historical-dd/);
  const annual = render({ pricing_policy: "fixed", end_policy: "stop" });
  assert.match(annual, />Year 1</);
  assert.match(annual, /Next Year/);
});

test("monthly history predicate recognizes canonical card and Direct Debit records", () => {
  const records = [
    { payment_method: "card_monthly", billing_agreement_id: "agreement-1" },
    { payment_method: "monthly_card", billing_agreement_id: "agreement-2" },
    { billing_period: "monthly_card", billing_agreement_id: "agreement-3" },
    {
      payment_method: "direct_debit",
      billing_period: "monthly_direct_debit",
      billing_agreement_id: "agreement-4",
    },
  ];
  for (const record of records) {
    assert.equal(isMonthlyMembershipRecord(record), true, JSON.stringify(record));
  }
});

test("monthly history predicate requires an agreement and excludes annual Direct Debit", () => {
  assert.equal(isMonthlyMembershipRecord({ payment_method: "card_monthly" }), false);
  assert.equal(isMonthlyMembershipRecord({
    payment_method: "direct_debit",
    billing_period: "annual",
    billing_agreement_id: "annual-agreement",
  }), false);
  assert.equal(isMonthlyMembershipRecord({
    billing_period: "monthly_direct_debit",
  }), false);
});

test("history source tags survive the summary-to-ledger handoff", () => {
  assert.equal(getMembershipSource({
    id: "personal-history",
    membership_source: "personal",
    organization_id: "org-1",
  }), "personal");
  assert.equal(getMembershipSource({
    id: "organisation-history",
    membership_source: "organisation",
  }), "organisation");
  assert.equal(getMembershipSource({
    id: "legacy-organisation-history",
    organization_id: "org-1",
  }), "organisation");
});

test("confirmed GoCardless collection is not rendered as pending when sync is null", () => {
  const entry = normalizeCollection({
    id: "payment-1",
    provider: "gocardless",
    status: "confirmed",
    accountingSyncStatus: null,
    amount: 12,
  });
  assert.equal(entry.collectionStatus, "collected");
  assert.equal(entry.accountingStatus, "not_recorded");
  assert.equal(entry.status, "not_recorded");

  const html = renderToStaticMarkup(React.createElement(
    MemberMembershipInstalmentsToggle,
    {
      record: {
        id: "history-1",
        payment_method: "direct_debit",
        billing_period: "monthly_direct_debit",
        billing_agreement_id: "agreement-1",
      },
      expanded: false,
      onToggle: () => {},
    },
  ));
  assert.match(html, /Monthly instalments/);
  assert.match(html, /aria-expanded="false"/);
  assert.ok(!renderToStaticMarkup(React.createElement(
    MemberMembershipInstalmentsToggle,
    {
      record: { id: "annual-1", payment_method: "direct_debit", billing_period: "annual", billing_agreement_id: "agreement-2" },
      expanded: false,
      onToggle: () => {},
    },
  )));
});

test("a Stripe accounting ledger row represents a collected card payment", () => {
  const entry = normalizeCollection({
    id: "instalment-1",
    provider: "stripe",
    status: "pending",
    accountingSyncStatus: "pending",
    amount: 10,
  });
  assert.equal(entry.collectionStatus, "collected");
  assert.equal(entry.accountingStatus, "pending");
});

test("expanded details remain a table row and do not fetch while collapsed", () => {
  const html = renderToStaticMarkup(React.createElement(MemberMembershipInstalments, {
    record: {
      id: "history-2",
      payment_method: "monthly_card",
      billing_agreement_id: "agreement-2",
    },
    expanded: false,
  }));
  assert.equal(html, "");
});

test("organisation history remains visible when the member has no personal config", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("/api/membership/member-membership?memberId=")) {
      return {
        ok: true,
        json: async () => ({
          member: { id: "member-org-only", email: "org-only@example.test" },
          config: null,
          currentYearCost: null,
          nextYearPreview: null,
          history: [{
            id: "org-only-history",
            membership_source: "organisation",
            organization_id: "org-1",
            membership_year: "2027/2028",
            tier_label: "Organisation tier",
            annual_cost: 100,
            final_cost: 100,
            total_with_vat: 100,
            currency: "GBP",
            payment_method: "invoice",
            billing_agreement_id: null,
            status: "active",
            payment_status: "paid",
          }],
        }),
      };
    }
    if (requestUrl.includes("/api/membership/member-membership-invoicing")) {
      return { ok: true, json: async () => ({ settings: {} }) };
    }
    if (requestUrl.includes("/api/membership/member-membership-override")) {
      return { ok: true, json: async () => ({}) };
    }
    if (requestUrl.includes("/api/membership/membership-settings")) {
      return { ok: true, json: async () => ({ require_approval: false }) };
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(MemberMembershipTab, {
            memberId: "member-org-only",
            memberEmail: "org-only@example.test",
          }),
        ),
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.match(container.textContent, /No member-scoped membership tier structure has been configured/);
    assert.match(container.textContent, /Membership Fee History/);
    assert.match(container.textContent, /Organisation tier/);
    assert.ok(container.querySelector('[data-testid="row-member-history-org-only-history"]'));
    assert.equal(container.querySelector('[data-testid="text-member-no-current-tier"]'), null);
    assert.equal(container.querySelector('[data-testid="button-member-simulate-current-year"]'), null);
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

test("paid historical snapshot is visibly read-only and exposes no pricing controls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("/api/membership/member-membership?memberId=")) {
      return {
        ok: true,
        json: async () => ({
          member: { id: "member-paid-snapshot", email: "paid@example.test" },
          config: {
            id: "historical-config",
            name: "Historical member tier",
            source: "paid_history",
            currency: "GBP",
            billing_period: "annual",
          },
          pricingCapability: {
            mode: "historical_read_only",
            status: "paid_snapshot",
            readOnly: true,
            canSimulate: false,
            canEmail: false,
            canOverride: false,
            canRenew: false,
            canInvoice: false,
          },
          currentYearCost: {
            membershipYear: "2026/2027",
            yearNumber: 1,
            tierLabel: "Flat Rate",
            annualCost: 128,
            finalCost: 128,
            totalWithVat: 128,
            currency: "GBP",
            billingPeriod: "annual",
          },
          nextYearPreview: null,
          history: [{
            id: "paid-snapshot-history",
            membership_source: "personal",
            membership_year: "2026/2027",
            tier_label: "Flat Rate",
            annual_cost: 128,
            final_cost: 128,
            total_with_vat: 128,
            currency: "GBP",
            payment_method: "stripe",
            payment_status: "paid",
            billing_period: "annual",
            status: "active",
          }],
        }),
      };
    }
    if (requestUrl.includes("/api/membership/member-membership-invoicing")) {
      return { ok: true, json: async () => ({ settings: {} }) };
    }
    if (requestUrl.includes("/api/membership/member-membership-override")) {
      return { ok: true, json: async () => ({}) };
    }
    if (requestUrl.includes("/api/membership/membership-settings")) {
      return { ok: true, json: async () => ({ require_approval: false }) };
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(MemberMembershipTab, {
            memberId: "member-paid-snapshot",
            memberEmail: "paid@example.test",
          }),
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    assert.ok(container.querySelector('[data-testid="badge-member-paid-snapshot-current-year"]'));
    assert.ok(container.querySelector('[data-testid="card-member-paid-snapshot-future"]'));
    assert.match(container.textContent, /Future pricing is unavailable/);
    assert.match(container.textContent, /Paid by card/);
    assert.match(container.textContent, /Flat Rate/);
    assert.equal(container.querySelector('[data-testid="button-member-simulate-current-year"]'), null);
    assert.equal(container.querySelector('[data-testid="button-member-email-fees-current-year"]'), null);
    assert.equal(container.querySelector('[data-testid="button-member-override-current-year"]'), null);
    assert.equal(container.querySelector('[data-testid="button-member-renew-now-current-year"]'), null);
    assert.equal(container.querySelector('[data-testid="button-member-save-invoicing-current-year"]'), null);
    assert.equal(container.querySelector('[data-testid="radio-member-invoicing-mode-current-year"]'), null);
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

test("collapsing an in-flight page clears its guard so re-expand retries", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url) => new Promise((resolve) => requests.push({
    resolve,
    url: String(url),
  }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const record = {
    id: "history-pending",
    payment_method: "monthly_card",
    billing_agreement_id: "agreement-pending",
  };
  const renderDetails = (expanded, source = "personal") => React.createElement(
    "table",
    null,
    React.createElement(
      "tbody",
      null,
      React.createElement(MemberMembershipInstalments, { record, expanded, source }),
    ),
  );

  try {
    await act(async () => {
      root.render(renderDetails(true));
      await Promise.resolve();
    });
    assert.equal(requests.length, 1);

    await act(async () => {
      root.render(renderDetails(false));
      await Promise.resolve();
    });
    await act(async () => {
      root.render(renderDetails(true));
      await Promise.resolve();
    });
    assert.equal(requests.length, 2, "re-expanding must issue a fresh request");
    assert.match(requests[0].url, /source=personal/);

    await act(async () => {
      requests[1].resolve({
        ok: true,
        json: async () => ({
          instalments: [],
          ledger: { state: "empty", missing: false },
          pagination: { page: 1, pageSize: 25, totalCount: 0, hasNextPage: false },
        }),
      });
      await Promise.resolve();
    });
    assert.match(container.textContent, /No monthly collections recorded/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

test("changing membership source clears the page cache and requests the scoped ledger", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url) => {
    requests.push({
      url: String(url),
      resolve: null,
    });
    return new Promise((resolve) => {
      requests[requests.length - 1].resolve = resolve;
    });
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const record = {
    id: "history-shared-id",
    membership_source: "personal",
    payment_method: "monthly_card",
    billing_agreement_id: "agreement-personal",
  };
  const renderDetails = (source) => React.createElement(
    "table",
    null,
    React.createElement(
      "tbody",
      null,
      React.createElement(MemberMembershipInstalments, {
        record,
        source,
        expanded: true,
      }),
    ),
  );

  try {
    await act(async () => {
      root.render(renderDetails("personal"));
      await Promise.resolve();
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /source=personal/);

    await act(async () => {
      requests[0].resolve({
        ok: true,
        json: async () => ({
          instalments: [],
          ledger: { state: "empty", missing: false },
          pagination: { page: 1, pageSize: 25, totalCount: 0, hasNextPage: false },
        }),
      });
      await Promise.resolve();
    });

    await act(async () => {
      root.render(renderDetails("organisation"));
      await Promise.resolve();
    });
    assert.equal(requests.length, 2, "changing source must not reuse the personal ledger page");
    assert.match(requests[1].url, /source=organisation/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    globalThis.fetch = originalFetch;
  }
});