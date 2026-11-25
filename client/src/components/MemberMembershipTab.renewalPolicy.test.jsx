import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { historyStructureFixtures } from "./membership/historyStructureFixtures";

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
const { setActiveTenantId } = await import("../api/base44Client.js");

// Optional private receipt: verifies real repaired rows without committing member data.
const repairReceipt = 'generated-artifacts/bnms-invoice-date-repair/priced-verify.json';
const singleRepairReceipt = 'generated-artifacts/bnms-membership-5734/verification.json';
const olderRepairReceipt = 'generated-artifacts/bnms-membership-5737/handlers-after.json';
test('recovered older annual term renders alongside unchanged current term with both invoice links',
  { skip: !existsSync(olderRepairReceipt) }, async () => {
    const { payload } = JSON.parse(readFileSync(olderRepairReceipt, 'utf8'));
    await mounted({ dataOverrides: payload }, (container, calls) => {
      for (const [id, start, end, invoice] of [
        ['36d03663-c9e3-5cad-a630-53f0a4776f9f', '6 October 2025', '5 October 2026', '300004583'],
        ['586d4e57-598b-4dd2-ab9f-120f0be539a3', '6 October 2026', '5 October 2027', '300005516'],
      ]) {
        const row = container.querySelector(`[data-testid="row-member-history-${id}"]`);
        assert.ok(row);
        assert.ok(row.textContent.includes(start));
        assert.ok(row.textContent.includes(end));
        assert.match(row.textContent, /2026-2027 Overseas full member/);
        assert.match(row.textContent, /£156\.00/);
        assert.match(row.textContent, /12 months/);
        assert.match(row.textContent, /Paid/);
        assert.doesNotMatch(row.textContent, /Structure unknown|Uncommitted/);
        assert.equal(row.querySelector(`[data-testid="button-view-invoice-${id}"]`).title, `View invoice ${invoice}`);
      }
      assert.deepEqual(calls, []);
    });
  });
test('approved single-member invoice term renders actual API evidence without replacing the older history',
  { skip: !existsSync(singleRepairReceipt) }, async () => {
    const { payload } = JSON.parse(readFileSync(singleRepairReceipt, 'utf8'));
    await mounted({ dataOverrides: payload }, (container, calls) => {
      const current = container.querySelector('[data-testid="row-member-history-586d4e57-598b-4dd2-ab9f-120f0be539a3"]');
      assert.ok(current);
      assert.match(current.textContent, /2026-2027 Overseas full member/);
      assert.match(current.textContent, /£156\.00/);
      assert.match(current.textContent, /6 October 2026/);
      assert.match(current.textContent, /5 October 2027/);
      assert.match(current.textContent, /12 months/);
      assert.match(current.textContent, /Paid/);
      assert.doesNotMatch(current.textContent, /Structure unknown|Uncommitted/);
      assert.equal(current.querySelector('[data-testid="button-view-invoice-586d4e57-598b-4dd2-ab9f-120f0be539a3"]').title,
        'View invoice 300005516');
      assert.ok(container.querySelector('[data-testid="row-member-history-36d03663-c9e3-5cad-a630-53f0a4776f9f"]'));
      assert.deepEqual(calls, []);
    });
  });
test('verified reconstruction receipts render complete priced membership history', { skip: !existsSync(repairReceipt) }, async () => {
  const { results, held } = JSON.parse(readFileSync(repairReceipt, 'utf8'));
  assert.equal(held.length, 0);
  assert.equal(results.length, 45);
  for (const result of results) {
    const history = { ...result.expected, id: 'verified-history', member_id: 'member' };
    await mounted({ dataOverrides: {
      config: history.commitment_snapshot.config,
      legacyCurrentMembership: null,
      history: [history],
      commitments: [],
      currentCommitments: [],
    } }, container => {
      const row = container.querySelector('[data-testid="row-member-history-verified-history"]');
      assert.ok(row);
      assert.ok(row.textContent.includes(result.structure));
      assert.ok(row.textContent.includes(result.prices.agreed.text));
      assert.match(row.textContent, /12 months/);
      assert.match(row.textContent, /upfront/);
      assert.doesNotMatch(row.textContent, /Uncommitted|Structure unknown|Frequency unknown|Duration unknown|Renewal: Unknown/);
    });
  }
});

test('personal and organisation-sourced ledger rows separate classification from structure without changing financial evidence', async () => {
  for (const membership_source of ['personal', 'organisation']) {
    const history = historyStructureFixtures.map(({ expected, ...row }) => ({
      ...row, membership_source, membership_year: '2025/2026', currency: 'GBP',
      term_start_date: '2026-01-14', term_end_date: '2027-01-12',
      final_cost: 61, total_with_vat: 61, payment_status: 'paid',
      accounting_invoice_id: 'saved-invoice', accounting_invoice_number: '300004834',
    }));
    const before = structuredClone(history);
    await mounted({ dataOverrides: {
      config: { id: 'config', name: 'Today’s matching structure', currency: 'GBP' },
      history,
    } }, (container, calls) => {
      for (const fixture of historyStructureFixtures) {
        const row = container.querySelector(`[data-testid="row-member-history-${fixture.id}"]`);
        assert.equal(row.children[1].textContent, fixture.expected);
        assert.match(row.textContent, /£61\.00/);
        assert.match(row.textContent, /Paid/);
        assert.match(row.textContent, /14 January 2026/);
        assert.match(row.textContent, /12 January 2027/);
        assert.equal(row.querySelector(`[data-testid="button-view-invoice-${fixture.id}"]`).title, 'View invoice 300004834');
        assert.doesNotMatch(row.children[1].textContent, /Today’s matching structure/);
      }
      assert.deepEqual(history, before);
      assert.deepEqual(calls, []);
    });
  }
});

test('organisational history shows saved invoice references without changing individual or monthly rows', async () => {
  await mounted({ dataOverrides: { history: [
    { id: 'org-generic', membership_source: 'organisation', accounting_invoice_id: 'accounting-id',
      accounting_invoice_number: 'INV-ORG-42', xero_invoice_number: 'OLD-42' },
    { id: 'org-legacy', membership_source: 'organisation', xero_invoice_id: 'xero-id',
      xero_invoice_number: 'XERO-43' },
    { id: 'org-unnumbered', membership_source: 'organisation', accounting_invoice_id: 'private-database-id' },
    { id: 'org-unlinked', membership_source: 'organisation' },
    { id: 'org-unverified', membership_source: 'organisation', payment_status: 'unverified',
      accounting_invoice_id: 'hidden-id', accounting_invoice_number: 'HIDDEN-44' },
    { id: 'org-queued', membership_source: 'organisation', start_invoice_state: 'pending' },
    { id: 'personal-invoice', membership_source: 'personal', accounting_invoice_id: 'personal-id',
      accounting_invoice_number: 'PERSONAL-45' },
    { id: 'org-monthly', membership_source: 'organisation', payment_method: 'stripe_monthly_card',
      billing_agreement_id: 'monthly-agreement',
      accounting_invoice_id: 'monthly-id', accounting_invoice_number: 'MONTHLY-46' },
  ] } }, container => {
    const cell = id => container.querySelector(`[data-testid="row-member-history-${id}"]`).lastElementChild;
    assert.equal(cell('org-generic').querySelector('p').textContent, 'INV-ORG-42');
    assert.doesNotMatch(cell('org-generic').textContent, /OLD-42/);
    assert.equal(cell('org-legacy').querySelector('p').textContent, 'XERO-43');
    assert.equal(cell('org-unnumbered').querySelector('p'), null);
    assert.doesNotMatch(cell('org-unnumbered').textContent, /undefined|private-database-id/);
    assert.ok(cell('org-unnumbered').querySelector('[data-testid="button-view-invoice-org-unnumbered"]'));
    assert.equal(cell('org-unlinked').textContent, '-');
    assert.equal(cell('org-unverified').textContent, 'Payment evidence unavailable');
    assert.match(cell('org-queued').textContent, /Invoice creation queued/);
    for (const [id, number] of [['personal-invoice', 'PERSONAL-45'], ['org-monthly', 'MONTHLY-46']]) {
      assert.doesNotMatch(cell(id).textContent, new RegExp(number));
      assert.equal(cell(id).querySelector(`[data-testid="button-view-invoice-${id}"]`).title, `View invoice ${number}`);
    }
  });
});

test('organisational invoice view and download preserve membership source and history identity', async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  const downloads = [];
  URL.createObjectURL = () => 'blob:invoice-preview';
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  try {
    await mounted({ invoiceResponses: true, dataOverrides: { history: [
      { id: 'org-history', membership_source: 'organisation', accounting_invoice_id: 'not-the-record-id',
        accounting_invoice_number: 'INV-ORG-42' },
    ] } }, async (container, calls) => {
      await act(async () => container.querySelector('[data-testid="button-view-invoice-org-history"]').click());
      assert.equal(document.querySelector('[data-testid="text-invoice-modal-title"]').textContent, 'Invoice INV-ORG-42');
      assert.match(document.querySelector('[data-testid="iframe-invoice-pdf"]').src, /^blob:invoice-preview#/);
      await act(async () => container.querySelector('[data-testid="button-download-invoice-org-history"]').click());
      assert.deepEqual(calls.map(call => call.url), [
        '/api/membership-invoice/org-history?inline=true&source=organisation',
        '/api/membership-invoice/org-history?source=organisation',
      ]);
      assert.ok(calls.every(call => call.options.credentials === 'include'));
      assert.deepEqual(downloads, ['membership-invoice-INV-ORG-42.pdf']);
    });
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  }
});

test('history displays the saved structure and tier together without substituting current pricing', async () => {
  await mounted({ dataOverrides: { history: [
    { id: 'manual', tier_label: 'Flat Rate', commitment_snapshot: { config: { name: '2026-2027 Full member with NMC' } } },
    { id: 'older', tier_label: 'Flat Rate', commitment_snapshot: { structure_name: '2025-2026 Full member with NMC' } },
    { id: 'same-label', tier_label: 'Student', commitment_snapshot: { config: { name: 'Student' } } },
    { id: 'reconstructed', tier_label: 'Retired', reconstructed_structure_name: 'Historical retired schedule' },
    { id: 'unknown', tier_label: 'Flat Rate' },
  ] } }, async container => {
    const structure = id => container.querySelector(`[data-testid="row-member-history-${id}"]`).children[1].textContent;
    assert.equal(structure('manual'), '2026-2027 Full member with NMC · Flat Rate');
    assert.equal(structure('older'), '2025-2026 Full member with NMC · Flat Rate');
    assert.equal(structure('same-label'), 'Student');
    assert.equal(structure('reconstructed'), 'Historical retired schedule · Retired');
    assert.equal(structure('unknown'), 'Structure unknownRecorded tier / classification: Flat Rate');
  });
});

test('No charge history requires explicit evidence and unpaid invoices retain their processing state', async () => {
  await mounted({ dataOverrides: { history: [
    { id: 'waived', member_id: 'member', payment_status: 'paid', payment_method: null, total_with_vat: 0, admin_no_charge: true },
    { id: 'legacy', member_id: 'member', payment_status: 'paid', payment_method: null, total_with_vat: 0 },
    { id: 'queued', member_id: 'member', payment_status: 'unpaid', payment_method: 'invoice', start_invoice_state: 'pending' },
    { id: 'uncertain', member_id: 'member', payment_status: 'unpaid', payment_method: 'invoice', start_invoice_state: 'unknown' },
    { id: 'linked', member_id: 'member', payment_status: 'unpaid', payment_method: 'invoice', accounting_invoice_id: 'invoice-1', accounting_invoice_number: 'INV-1' },
  ] } }, async container => {
    assert.match(container.querySelector('[data-testid="cell-member-history-method-waived"]').textContent, /Free membership period \/ No charge/);
    assert.match(container.querySelector('[data-testid="cell-member-history-method-legacy"]').textContent, /Unknown/);
    assert.match(container.querySelector('[data-testid="row-member-history-queued"]').textContent, /Invoice creation queued/);
    assert.match(container.querySelector('[data-testid="row-member-history-uncertain"]').textContent, /outcome uncertain/);
    assert.equal(container.querySelector('[data-testid="button-view-invoice-linked"]').title, 'View invoice INV-1');
    assert.match(container.querySelector('[data-testid="row-member-history-linked"]').textContent, /Unpaid/);
  });
});

test('accounting recovery progress preserves paid status and never retries on render', async () => {
  for (const [state, label] of [
    ['waiting', 'Accounting waiting to retry'],
    ['pending', 'Accounting retry pending'],
    ['attention', 'Accounting needs manual attention'],
    ['unavailable', 'Accounting progress unavailable'],
  ]) {
    for (const invoiceId of [null, 'invoice-existing']) {
    await mounted({
      dataOverrides: { history: [{ id: 'accounting-row', member_id: 'member',
        payment_status: 'paid', payment_method: 'stripe', accounting_sync_status: 'failed',
        accounting_invoice_id: invoiceId,
        accounting_progress: { state, retryAt: '2026-10-23T12:15:00Z' } }] },
    }, async (container, calls) => {
      assert.ok(container.textContent.includes(label));
      assert.ok(container.textContent.includes('Membership remains paid'));
      assert.equal(container.querySelector('[data-testid="button-retry-invoice-accounting-row"]'), null);
      assert.equal(!!container.querySelector('[data-testid="button-view-invoice-accounting-row"]'), !!invoiceId);
      assert.ok(!calls.some(call => call.options?.method === 'POST'));
      if (state === 'waiting' || state === 'pending') {
        assert.equal(container.querySelector('time')?.dateTime, '2026-10-23T12:15:00Z');
      }
    });
    }
  }
});
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

test('unpaid upfront card history describes the method without claiming full payment', async () => {
  await mounted({ dataOverrides: {
    history: [{ ...historical, payment_method: 'stripe',
      status: 'pending_payment_setup', payment_status: 'unpaid',
      annual_cost: 156, final_cost: 156, total_with_vat: 156 }],
  } }, container => {
    const row = container.querySelector('[data-testid="row-member-history-paid-history"]');
    assert.ok(row);
    assert.match(row.textContent, /Card \(upfront\)/);
    assert.match(row.textContent, /Unpaid/);
    assert.match(row.textContent, /Awaiting payment/);
    assert.doesNotMatch(row.textContent, /pending_payment_setup/);
    assert.doesNotMatch(row.textContent, /paid in full/i);
  });
});

async function mounted({ projection = {}, grace = true, paidAmount = null, dataOverrides = {}, memberTenantId = null, selectedTenantId = null, invoiceResponses = false } = {}, callback) {
  setActiveTenantId(selectedTenantId);
  const tenantId = selectedTenantId || memberTenantId || null;
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity, gcTime: 0 },
    mutations: { retry: false, gcTime: 0 },
  } });
  // The adjacent benefits panel has its own tests and must not make real
  // requests while these tests verify membership history and renewal policy.
  client.setQueryData(["funnel-membership-entitlements", "member", "member"], { items: [] });
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
    ...dataOverrides,
  });
  client.setQueryData(["membership-settings"], { require_approval: false });
  client.setQueryData(["member-membership-invoicing-settings", "member"], { settings: {} });
  client.setQueryData(["member-membership-override", "member", null], {});
  client.setQueryData(["historical-dd-payments", null, "member"], []);
  client.setQueryData(["member-amendments", null, "member"], { history: [], structures: [], capabilities: {} });
  client.setQueryData(["member-amendments", tenantId, "member"], { history: [], structures: [], capabilities: {} });
  client.setQueryData(["historical-dd-payments", tenantId, "member"], []);
  client.setQueryData(["member-start", tenantId, "member"], {
    structures: [{ id: "personal-structure", name: `Structure for ${tenantId}`, pricing_model: "flat", bands: [], paymentModes: ["free"] }],
    blockers: [], requests: [], capabilities: { paymentModes: ["free"] },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("action=cancellation_finances")) {
      return new Response(JSON.stringify({ records: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    calls.push({ url, options });
    if (invoiceResponses && String(url).startsWith('/api/membership-invoice/')) {
      return new Response('synthetic invoice PDF', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    }
    throw new Error(`Unexpected network request: ${url}`);
  };
  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}><MemberMembershipTab memberId="member" memberTenantId={memberTenantId} /></QueryClientProvider>,
    ));
    await callback(container, calls);
  } finally {
    await act(async () => root.unmount());
    setActiveTenantId(null);
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  }
}

test("direct member page shows start controls using member tenant without dashboard selector", async () => {
  await mounted({ memberTenantId: "tenant-direct" }, (container, calls) => {
    const panel = container.querySelector('[data-testid="member-membership-start"]');
    assert.match(panel.textContent, /Start \/ Renew membership/);
    assert.match(panel.textContent, /Structure for tenant-direct/);
    assert.match(panel.textContent, /Preview membership/);
    assert.equal(calls.length, 0);
  });
});

test("explicit dashboard tenant remains authoritative instead of silently switching to member tenant", async () => {
  await mounted({ memberTenantId: "tenant-member", selectedTenantId: "tenant-dashboard" }, (container, calls) => {
    const panel = container.querySelector('[data-testid="member-membership-start"]');
    assert.match(panel.textContent, /Structure for tenant-dashboard/);
    assert.doesNotMatch(panel.textContent, /Structure for tenant-member/);
    assert.equal(calls.length, 0);
  });
});

test("missing tenant shows an explanation, not a silently absent start panel", async () => {
  await mounted({}, (container, calls) => {
    const panel = container.querySelector('[data-testid="member-membership-start"]');
    assert.match(panel.textContent, /unavailable until the member’s tenant has loaded/);
    assert.equal(panel.querySelector('button'), null);
    assert.equal(calls.length, 0);
  });
});

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

for (const previews of [false, true]) {
  test(`individual rolling history hides year cards without a commitment (preview data: ${previews})`, async () => {
    await mounted({ dataOverrides: {
      config: { name: "Individual membership", start_mode: "immediate", structure_scope_type: "member", currency: "GBP" },
      legacyCurrentMembership: null,
      currentYearCost: previews ? { membershipYear: "rolling:2026-01-14", yearNumber: 1 } : null,
      nextYearPreview: previews ? { membershipYear: "rolling:2027-01-14", yearNumber: 2 } : null,
    } }, (container, calls) => {
      assert.equal(container.querySelector('[data-testid="member-fixed-year-previews"]'), null);
      assert.doesNotMatch(container.textContent, /Year 1|Year 2|Current Year|Next Year/);
      assert.ok(container.querySelector('[data-testid="row-member-history-paid-history"]'));
      assert.match(container.textContent, /Membership Fee History/);
      assert.equal(container.querySelector('[data-testid="text-member-structure-name"]').textContent, "Individual membership");
      assert.equal(calls.length, 0);
    });
  });
}

test("missing API start mode does not imply fixed-year membership", async () => {
  await mounted({ dataOverrides: {
    config: { name: "Individual membership", currency: "GBP" },
    legacyCurrentMembership: null,
    currentYearCost: null,
    nextYearPreview: null,
  } }, container => {
    assert.equal(container.querySelector('[data-testid="member-fixed-year-previews"]'), null);
    assert.ok(container.querySelector('[data-testid="row-member-history-paid-history"]'));
  });
});

test("fixed-year member structures retain their preview cards", async () => {
  await mounted({ dataOverrides: {
    config: { name: "Fixed membership", start_mode: "fixed_date", structure_scope_type: "member", currency: "GBP" },
    legacyCurrentMembership: null,
  } }, (container, calls) => {
    assert.ok(container.querySelector('[data-testid="member-fixed-year-previews"]'));
    assert.match(container.textContent, /Current Year/);
    assert.match(container.textContent, /Next Year/);
    assert.ok(container.querySelector('[data-testid="row-member-history-paid-history"]'));
    assert.equal(calls.length, 0);
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