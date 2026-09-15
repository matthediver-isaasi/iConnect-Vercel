import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MemberMembershipInstalments, {
  MemberMembershipInstalmentsToggle,
  isMonthlyMembershipRecord,
  normalizeCollection,
} from "./MemberMembershipInstalments.jsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/member-detail",
});
Object.assign(globalThis, {
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

test("collapsing an in-flight page clears its guard so re-expand retries", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = () => new Promise((resolve) => requests.push(resolve));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const record = {
    id: "history-pending",
    payment_method: "monthly_card",
    billing_agreement_id: "agreement-pending",
  };
  const renderDetails = (expanded) => React.createElement(
    "table",
    null,
    React.createElement(
      "tbody",
      null,
      React.createElement(MemberMembershipInstalments, { record, expanded }),
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

    await act(async () => {
      requests[1]({
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