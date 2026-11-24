import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { historyStructureFixtures } from "./membership/historyStructureFixtures";

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

test('organisation ledger uses historical structure evidence, never the current configuration', async () => {
  const history = historyStructureFixtures.map(({ expected, ...row }) => ({
    ...row, membership_year: '2025/2026', currency: 'GBP',
    annual_cost: 61, final_cost: 61, payment_status: 'paid',
    accounting_invoice_id: 'saved-invoice', accounting_invoice_number: '300004834',
  }));
  const before = structuredClone(history);
  await mounted({ history }, ({ container, calls }) => {
    for (const fixture of historyStructureFixtures) {
      const row = container.querySelector(`[data-testid="row-history-${fixture.id}"]`);
      assert.equal(row.children[1].textContent, fixture.expected);
      assert.match(row.textContent, /£61\.00/);
      assert.match(row.textContent, /Paid/);
      assert.match(row.textContent, /2025\/2026/);
      assert.ok(row.querySelector(`[data-testid="button-view-invoice-${fixture.id}"]`));
    }
    assert.deepEqual(history, before);
    assert.deepEqual(calls, []);
  });
});

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
  client.setQueryData(["org-membership", "org", "proposal-entitlements"], { items: [], enabled: false });
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
    if (String(url).startsWith("/api/membership-invoice/")) {
      return new Response("synthetic invoice PDF", { status: 200, headers: { "Content-Type": "application/pdf" } });
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

test("organisation invoice cells show saved references and retain unnumbered actions and missing-invoice explanations", async () => {
  const history = [
    { id: "generic", accounting_invoice_id: "private-accounting-id",
      accounting_invoice_number: "INV-ORG-42", xero_invoice_number: "OLD-42",
      accounting_sync_status: "failed", accounting_sync_error: "Payment sync needs review" },
    { id: "legacy", xero_invoice_id: "private-xero-id", accounting_invoice_number: "",
      xero_invoice_number: "XERO-43" },
    { id: "unnumbered", accounting_invoice_id: "private-unnumbered-id" },
    { id: "unlinked", accounting_invoice_number: "UNLINKED-REFERENCE",
      invoice_availability: { status: "missing", message: "This historical fee has no linked invoice." } },
  ].map(record => ({ membership_year: "2025/2026", final_cost: 42, currency: "GBP", ...record }));
  const before = structuredClone(history);
  await mounted({ history }, ({ container, calls }) => {
    const cell = id => container.querySelector(`[data-testid="row-history-${id}"]`).lastElementChild;
    assert.equal(cell("generic").querySelector("p").textContent, "INV-ORG-42");
    assert.doesNotMatch(cell("generic").textContent, /OLD-42|private-accounting-id/);
    assert.equal(cell("legacy").querySelector("p").textContent, "XERO-43");
    assert.doesNotMatch(cell("legacy").textContent, /private-xero-id/);
    assert.equal(cell("unnumbered").querySelector("p"), null);
    assert.doesNotMatch(cell("unnumbered").textContent, /undefined|null|private-unnumbered-id|INV-|XERO-/);
    for (const id of ["generic", "legacy", "unnumbered"]) {
      for (const action of ["view-invoice", "download-invoice", "reconcile-payment"]) {
        assert.ok(cell(id).querySelector(`[data-testid="button-${action}-${id}"]`));
      }
    }
    assert.match(cell("generic").textContent, /Accounting: failed/);
    assert.match(cell("generic").textContent, /Payment sync needs review/);
    assert.match(cell("unlinked").textContent, /No invoice linked/);
    assert.match(cell("unlinked").textContent, /This historical fee has no linked invoice/);
    assert.doesNotMatch(cell("unlinked").textContent, /UNLINKED-REFERENCE/);
    assert.equal(cell("unlinked").querySelector("button"), null);
    assert.deepEqual(history, before);
    assert.deepEqual(calls, []);
  });
});

test("organisation invoice view and download keep targeting the history record for every linked reference variant", async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  const downloads = [];
  URL.createObjectURL = () => "blob:invoice-preview";
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  try {
    for (const [id, fields, number] of [
      ["generic", { accounting_invoice_id: "provider-id", accounting_invoice_number: "INV-42",
        xero_invoice_number: "OLD-42" }, "INV-42"],
      ["legacy", { xero_invoice_id: "legacy-provider-id", xero_invoice_number: "XERO-43" }, "XERO-43"],
      ["unnumbered", { accounting_invoice_id: "unnumbered-provider-id" }, null],
    ]) {
      await mounted({ history: [{ id, membership_year: "2025/2026", ...fields }] }, async ({ container, calls }) => {
        await act(async () => container.querySelector(`[data-testid="button-view-invoice-${id}"]`).click());
        assert.equal(document.querySelector('[data-testid="text-invoice-modal-title"]').textContent,
          number ? `Invoice ${number}` : "Invoice Preview");
        assert.match(document.querySelector('[data-testid="iframe-invoice-pdf"]').src, /^blob:invoice-preview#/);
        await act(async () => container.querySelector(`[data-testid="button-download-invoice-${id}"]`).click());
        assert.deepEqual(calls.map(call => call.url), [
          `/api/membership-invoice/${id}?inline=true`,
          `/api/membership-invoice/${id}`,
        ]);
        assert.ok(calls.every(call => call.options.credentials === "include"));
        assert.equal(downloads.at(-1), `membership-invoice-${number || id}.pdf`);
      });
    }
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  }
});

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

test("unrecorded Year 1 and prospective Year 2 display both figures but only Year 1 has financial controls", async () => {
  await mounted({
    currentYearCost: { ...current, overrideType: "price", overridePrice: 1, finalCost: 1, totalWithVat: 1.2 },
    nextYearPreview: { ...next, previewOnly: true, rolloverDiscount: 50,
      incentiveRollover: { source: "prospective_year1_projection", appliedDiscount: 50 } },
  }, async ({ container, calls }) => {
    assert.match(section(container, "current-year").textContent, /£1\.00/);
    assert.match(section(container, "next-year").textContent, /£678\.90/);
    assert.match(container.querySelector('[data-testid="prospective-estimate-next-year"]').textContent,
      /not a purchased entitlement/);
    assert.equal(container.querySelector('[data-testid="prospective-estimate-current-year"]'), null);
    for (const action of ["simulate", "override", "remove-override", "email-fees", "renew-now", "invoice-now",
      "save-invoicing", "approve", "unapprove"]) {
      assert.equal(container.querySelector(`[data-testid="button-${action}-next-year"]`), null, action);
    }
    assert.equal(container.querySelector('[data-testid="radio-invoicing-mode-next-year"]'), null);
    assert.ok(container.querySelector('[data-testid="button-record-current"]'));
    assert.ok(container.querySelector('[data-testid="button-simulate-current-year"]'));
    await act(async () => container.querySelector('[data-testid="button-simulate-current-year"]').click());
    assert.equal(JSON.parse(calls[0].options.body).targetYear, "2026/2027");
  });
});

test("prospective current-year price has no record button even when the card requests it", async () => {
  await mounted({
    currentYearCost: { ...current, previewOnly: true },
  }, async ({ container, calls }) => {
    assert.ok(section(container, "current-year"));
    assert.equal(container.querySelector('[data-testid="button-record-current"]'), null);
    assert.equal(container.querySelector('[data-testid="button-simulate-current-year"]'), null);
    assert.deepEqual(calls, []);
  });
});

test("prospective Year 2 note names its assumed joining date when no joining date is set", async () => {
  await mounted({
    goLiveDate: null,
    currentYearCost: { ...current, previewAssumedJoinDate: null },
    nextYearPreview: { ...next, previewOnly: true, previewAssumedJoinDate: "2026-09-24" },
    history: [],
  }, async ({ container }) => {
    const note = container.querySelector('[data-testid="prospective-estimate-next-year"]');
    assert.match(note.textContent, /Joining date is not set/);
    assert.match(note.textContent, /estimate assumes a joining date of 2026-09-24/);
    assert.equal(container.querySelector('[data-testid="assumed-joining-date-current-year"]'), null);
    assert.equal(container.querySelector('[data-testid="button-simulate-next-year"]'), null);
  });
});

test("recorded Year 1 and verified Year 2 preserve the ordinary actions and no prospective label", async () => {
  await mounted({
    nextYearPreview: { ...next, previewOnly: false,
      incentiveRollover: { source: "commitment_snapshot", appliedDiscount: 50 } },
    history: [{ id: "current", membership_year: "2026/2027", final_cost: 123.45 }],
  }, async ({ container }) => {
    assert.equal(container.querySelector('[data-testid="prospective-estimate-next-year"]'), null);
    assert.ok(container.querySelector('[data-testid="button-simulate-next-year"]'));
    assert.ok(container.querySelector('[data-testid="button-override-next-year"]'));
    assert.ok(container.querySelector('[data-testid="button-save-invoicing-next-year"]'));
  });
});