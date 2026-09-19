import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { resolveReminderPaymentQuote, requestsReminderPaymentLink, reminderRenewalSnapshot } from './reminderPaymentQuote.js';

const config = { id: 'config', billing_period: 'annual', renewal_open_days: 30, renewal_grace_days: 7, online_card_payment: true };
function fixture(member = true, rolling = false) {
  const history = { id: 'current', tenant_id: 'tenant', ...(member ? { member_id: 'member' } : { organization_id: 'org' }),
    config_id: 'config', membership_year: '2025/2026', billing_period: 'annual',
    term_start_date: '2025-01-01', term_end_date: '2025-12-31', final_cost: 100 };
  if (rolling) Object.assign(history, { term_key: 'rolling:2025-01-01', membership_renewal_date: '2026-01-01',
    term_duration_months: 12, term_anchor_date: '2025-01-01',
    commitment_snapshot: { config: { ...config, start_mode: 'immediate', pricing_model: 'flat', flat_cost: 125 },
      start_mode: 'immediate', payment_frequency: 'upfront' } });
  let agreements = [], calls = [], credentials = { is_enabled: true, secret_key: 'fixture', publishable_key: 'fixture' };
  const histories = [history];
  const client = { from(table) {
    const q = { select() { return q; }, eq() { return q; }, in() { return q; },
      maybeSingle() { return Promise.resolve({ data: config }); },
      then(resolve) { return Promise.resolve({ data: agreements }).then(resolve); } };
    return q;
  } };
  const simulate = async (tenant, owner, options) => {
    calls.push(['simulate', tenant, owner, options]);
    return { success: true, config: rolling ? history.commitment_snapshot.config : config,
      membershipYear: { label: rolling ? 'rolling:2026-01-01' : '2026/2027', start: '2026-01-01', end: '2026-12-31' },
      previousTerm: rolling ? history : null, finalCost: 125, annualCost: 125, totalWithVat: 150, vatAmount: 25, currency: 'GBP', tierLabel: 'New tier' };
  };
  const prepare = async options => { calls.push(['prepare', options]); return { success: true, paymentUrl: 'https://example.test/membership-fees/fixture',
    finalCost: options.finalCost, currency: options.currency, tierLabel: options.tierLabel, costBreakdown: options.costBreakdown,
    historyRecordId: options.historyRecordId, xeroInvoiceId: options.xeroInvoiceId }; };
  return { history, histories, calls, setAgreements: value => { agreements = value; },
    setCredentials: value => { credentials = value; },
    run: (now = '2025-12-15') => resolveReminderPaymentQuote({ client, tenantId: 'tenant', history, histories,
      now: new Date(now), simulate, prepare, resolveStripeCredentials: async () => credentials,
      recipients: [{ email: 'fixture@example.test' }] }) };
}

for (const member of [true, false]) for (const rolling of [false, true]) {
  test(`successor quote aligns dates and changed price (${member ? 'member' : 'org'}, ${rolling ? 'rolling' : 'fixed'})`, async () => {
    const f = fixture(member, rolling), result = await f.run();
    assert.equal(result.success, true);
    assert.equal(result.finalCost, 125);
    assert.equal(result.quote.membershipYear.start, '2026-01-01');
    assert.equal(result.quote.membershipYear.end, '2026-12-31');
    assert.equal(f.history.final_cost, 100);
    const payload = f.calls.find(c => c[0] === 'prepare')[1];
    assert.equal(payload.memberId, member ? 'member' : null);
    assert.equal(payload.organizationId, member ? null : 'org');
    assert.equal(payload.reminderQuote, true);
    if (rolling) assert.equal(payload.costBreakdown.commitment.term_start_date, '2026-01-01');
  });
}

test('before-open is deferred and grace expiry does not prepare any token', async () => {
  const f = fixture();
  assert.equal((await f.run('2025-11-01')).code, 'annual_renewal_not_open');
  assert.equal((await f.run('2026-01-08')).code, 'annual_renewal_grace_expired');
  assert.equal(f.calls.length, 0);
});

test('missing, disabled or incomplete upfront credentials withhold new links; linked invoice PO remains supported', async () => {
  for (const credentials of [null, { is_enabled: false, secret_key: 'fixture', publishable_key: 'fixture' },
    { is_enabled: true, secret_key: 'fixture' }, { is_enabled: true, publishable_key: 'fixture' }]) {
    const f = fixture();
    f.setCredentials(credentials);
    assert.equal((await f.run()).code, 'payment_method_unavailable');
    assert.equal(f.calls.filter(c => c[0] === 'prepare').length, 0);
  }
  const f = fixture(false);
  f.setCredentials(null);
  f.histories.push({ id: 'next', membership_year: '2026/2027', final_cost: 120,
    annual_cost: 120, currency: 'GBP', xero_invoice_id: 'existing-invoice' });
  assert.equal((await f.run()).success, true);
});

test('recurring agreement and paid successor suppress payment preparation', async () => {
  const f = fixture();
  f.setAgreements([{ provider: 'stripe', status: 'active' }]);
  assert.equal((await f.run()).code, 'recurring');
  f.setAgreements([]);
  f.histories.push({ id: 'next', membership_year: '2026/2027', payment_status: 'paid' });
  assert.equal((await f.run()).code, 'paid');
  assert.equal(f.calls.length, 0);
});

test('existing unpaid invoice retains price and invoice/history linkage', async () => {
  const f = fixture(false);
  f.histories.push({ id: 'next', membership_year: '2026/2027', payment_status: 'unpaid',
    final_cost: 119, annual_cost: 119, total_with_vat: 142.8, vat_amount: 23.8,
    currency: 'GBP', tier_label: 'Agreed', xero_invoice_id: 'invoice' });
  const result = await f.run();
  assert.equal(result.finalCost, 119);
  const payload = f.calls.find(c => c[0] === 'prepare')[1];
  assert.equal(payload.historyRecordId, 'next');
  assert.equal(payload.xeroInvoiceId, 'invoice');
});

test('detects whitespace placeholder without changing informational templates', () => {
  assert.equal(requestsReminderPaymentLink({ body: '{{ payment_link }}' }), true);
  assert.equal(requestsReminderPaymentLink({ body: '{{renewal_date}}' }), false);
});

test('renewal snapshot excludes arbitrary simulation, owner, configuration and history internals', () => {
  const result = reminderRenewalSnapshot({
    config: { ...config, invoice_recipients: { email: 'private@example.test' }, admin_notes: 'private', online_card_payment: true },
    membershipYear: { label: '2026', start: '2026-01-01', end: '2026-12-31', secret: 'private' },
    internal: 'private', org: { name: 'private' }, invoicingSettings: { notes: 'private' },
  }, { id: 'history', membership_year: '2025', billing_period: 'annual', term_start_date: '2025-01-01',
    term_end_date: '2025-12-31', notes: 'private', member_id: 'private',
    commitment_snapshot: { config: { ...config, admin_notes: 'private' }, pricing: { note: 'private' }, start_mode: 'immediate' } });
  assert.doesNotMatch(JSON.stringify(result), /private|invoicingSettings|admin_notes|invoice_recipients/);
  assert.equal(result.config.online_card_payment, true);
  assert.equal(result.previousTerm.term_end_date, '2025-12-31');
  assert.equal(result.previousTerm.commitment_snapshot.config.renewal_open_days, 30);
});

// Exercise the actual extracted preparation and unchanged delivery renderer,
// replacing every external effect rather than importing configured mailers.
const source = readFileSync(new URL('./membershipFeeTokenEmail.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replace(/export async function /g, 'async function ')
  .replace("await import('./rollingFeeCommitment.js')", 'await deps()');
const load = new Function('crypto', 'defaultSupabase', 'sendTenantEmail', 'buildInboxDelivery', 'resolveTierRecipients', 'deps',
  `${source}\nreturn {prepareMembershipFeeToken,sendMembershipFeeTokenEmail};`);
test('preparation emits no email; ordinary Email Fees still sends its original template', async () => {
  let sends = 0;
  const client = { rpc: async (name, args) => ({ data: { ...(args?.p_snapshot || {}),
      outcome: 'claimed', id: 'id', token: 'fixture', expires_at: '2099-01-01' } }),
    from(table) { const q = { select() { return q; }, limit() { return Promise.resolve({ data: [] }); },
      eq() { return q; }, maybeSingle() { return Promise.resolve({ data: { name: 'Fixture', slug: 'fixture' } }); } }; return q; } };
  const helpers = load(crypto, client, async ({ html }) => { sends++; assert.match(html, /membership-fees\/fixture/); return { success: true }; },
    async () => ({}), async () => ({ recipients: [] }), async () => ({ snapshotRollingFeeQuote: async (_, o) => o.costBreakdown }));
  const options = { client, tenantId: 'tenant', memberId: 'member', organizationName: 'Member',
    membershipYear: '2026', finalCost: 120, currency: 'GBP', recipientEmails: ['fixture@example.test'], costBreakdown: {} };
  assert.equal((await helpers.prepareMembershipFeeToken(options)).success, true);
  assert.equal(sends, 0);
  assert.equal((await helpers.sendMembershipFeeTokenEmail(options)).success, true);
  assert.equal(sends, 1);
  assert.equal((await helpers.sendMembershipFeeTokenEmail({ ...options, memberId: null, organizationId: 'org' })).success, true);
  assert.equal(sends, 2);
});