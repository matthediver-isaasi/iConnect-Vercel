import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestsReminderPaymentLink, resolveReminderPaymentQuote } from './reminderPaymentQuote.js';
import { deriveAnnualTerm } from './annualRenewalPolicy.js';

const source = readFileSync(new URL('./membershipReminders.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replace(/export (async )?function /g, '$1function ');
const load = new Function('supabase', 'requestsReminderPaymentLink', 'resolveReminderPaymentQuote',
  'prepareMembershipFeeToken', 'deriveAnnualTerm', 'simulateMembershipForMember', 'simulateMembershipForOrg',
  'getPausedMemberIdSet', 'sendTenantEmail', 'recordTransactionalInboxMessage', 'resolveCommunicationCategoryIdForLabel',
  'replacePlaceholders', 'assertRenewalBudget', 'loadAddonLines', 'computeAddonTotals', 'buildAddonDisplayLines',
  'getStripeCredentials',
  `${source}\nreturn processPaymentLinkReminders;`);

function setup(member = true, rolling = false) {
  const config = { id: 'config', tenant_id: 'tenant', billing_period: 'annual', renewal_open_days: 30, online_card_payment: true,
    renewal_grace_days: 7, ...(rolling ? { start_mode: 'immediate' } : {}) };
  const history = { id: 'current', tenant_id: 'tenant', config_id: 'config',
    ...(member ? { member_id: 'owner' } : { organization_id: 'owner' }),
    membership_year: '2025/2026', billing_period: 'annual', final_cost: 100,
    term_start_date: '2025-01-01', term_end_date: '2025-12-31',
    ...(rolling ? { term_key: 'rolling:2025-01-01', term_duration_months: 12, term_anchor_date: '2025-01-01',
      membership_renewal_date: '2026-01-01',
      commitment_snapshot: { config, start_mode: 'immediate', payment_frequency: 'upfront' } } : {}) };
  const owner = { id: 'owner', tenant_id: 'tenant', email: 'fixture@example.test', name: 'Fixture', role_id: 'role' };
  const recipient = member ? owner : { ...owner, id: 'recipient', organization_id: 'owner' };
  const histories = [history];
  const tables = {
    [member ? 'member_membership_history' : 'organisation_membership_history']: histories,
    [member ? 'organisation_membership_history' : 'member_membership_history']: [],
    member: [recipient], organization: member ? [] : [owner], membership_tier_config: [config],
    membership_billing_agreements: [], membership_tier_reminder_send: [],
    membership_tier_reminder: [{ id: 'reminder', tenant_id: 'tenant', config_id: 'config', is_active: true,
      email_template_id: 'template', recipient_role_ids: ['role'], offset_value: 30, offset_unit: 'days', direction: 'before' }],
    email_template: [{ id: 'template', tenant_id: 'tenant', is_active: true,
      subject: 'Renew {{membership_year}}', body: '{{final_cost}} {{renewal_date}} {{payment_link}}' }],
  };
  const db = { from(table) {
    let mode = 'select', payload, single = false, maximum = Infinity;
    const filters = [];
    const q = { select() { return q; }, eq(k,v) { filters.push(r => r[k] === v); return q; },
      in(k,v) { filters.push(r => v.includes(r[k])); return q; },
      limit(n) { maximum = n; return q; }, maybeSingle() { single = true; return q; },
      insert(v) { mode = 'insert'; payload = v; return q; }, update(v) { mode = 'update'; payload = v; return q; },
      then(resolve,reject) { return Promise.resolve().then(() => {
        const rows = tables[table] ||= [];
        let selected = rows.filter(r => filters.every(f => f(r))).slice(0,maximum);
        if (mode === 'insert') {
          if (rows.some(r => r.reminder_id === payload.reminder_id && r.membership_year === payload.membership_year)) {
            return { data: null, error: { code: '23505' } };
          }
          const row = { id: 'claim', ...payload }; rows.push(row); selected = [row];
        }
        if (mode === 'update') selected.forEach(r => Object.assign(r,payload));
        return { data: single ? selected[0] || null : selected, error: null };
      }).then(resolve,reject); },
    }; return q;
  } };
  const sends = [], inbox = [];
  let pause = false, failure = false;
  const simulation = async () => ({ success: true, config, finalCost: 125, annualCost: 125,
    totalWithVat: 125, vatAmount: 0, currency: 'GBP', tierLabel: 'Successor',
    previousTerm: rolling ? history : null,
    membershipYear: { label: rolling ? 'rolling:2026-01-01' : '2026/2027', start: '2026-01-01', end: '2026-12-31' } });
  const process = load(db, requestsReminderPaymentLink, resolveReminderPaymentQuote,
    async options => ({ success: true, paymentUrl: 'https://fixture.test/membership-fees/secret',
      finalCost: options.finalCost, currency: options.currency, tierLabel: options.tierLabel, costBreakdown: options.costBreakdown }),
    deriveAnnualTerm, simulation, simulation, async () => new Set(pause ? [recipient.id] : []),
    async message => { if (failure) return { success: false, error: 'Fixture delivery failure' }; sends.push(message); return { success: true }; },
    async message => { inbox.push(message); }, async () => 'category',
    (text, scope, data) => {
      assert.ok(!Object.values(data).some(v => String(v).includes('/membership-fees/')), 'bearer token must bypass diagnostic renderer');
      return text.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? '');
    }, () => {}, async () => [], () => ({ subtotal: 0, vat: 0, total: 0 }), () => [],
    async () => ({ is_enabled: true, secret_key: 'fixture', publishable_key: 'fixture' }));
  const run = async (date = '2025-12-15') => { const results = { details: [] }; await process('tenant', results, new Date(date)); return results; };
  return { run, tables, histories, sends, inbox, config, pause: () => { pause = true; }, fail: value => { failure = value; } };
}

for (const member of [true, false]) for (const rolling of [true, false]) {
  test(`linked reminder delivers one aligned successor email and inbox (${member}, ${rolling})`, async () => {
    const f = setup(member, rolling);
    await Promise.all([f.run(), f.run()]);
    assert.equal(f.sends.length, 1);
    assert.equal(f.inbox.length, 1);
    assert.match(f.sends[0].html, /125.00 2026-01-01 <a href="https:\/\/fixture.test\/membership-fees\/secret">/);
    assert.doesNotMatch(f.sends[0].html, /\{\{/);
    await f.run();
    assert.equal(f.sends.length, 1);
  });
}
test('before-window deferral is not logged sent and delivers when opened', async () => {
  const f = setup();
  f.config.renewal_open_days = 7;
  assert.equal((await f.run()).details[0].status, 'deferred');
  assert.equal(f.tables.membership_tier_reminder_send.length, 0);
  await f.run('2025-12-26');
  assert.equal(f.sends.length, 1);
});
test('pause, paid successor, recurring agreements and informational templates never mint linked delivery', async () => {
  const paused = setup(); paused.pause(); await paused.run(); assert.equal(paused.sends.length, 0);
  const paid = setup(); paid.histories.push({ id: 'next', tenant_id: 'tenant', member_id: 'owner', membership_year: '2026/2027', payment_status: 'paid' });
  assert.equal((await paid.run()).details[0].code, 'paid');
  const recurring = setup(); recurring.tables.membership_billing_agreements.push({ tenant_id: 'tenant', member_id: 'owner', status: 'active', provider: 'gocardless' });
  assert.equal((await recurring.run()).details[0].code, 'recurring');
  const info = setup(); info.tables.email_template[0].body = '{{renewal_date}}';
  await info.run(); assert.equal(info.tables.membership_tier_reminder_send.length, 0);
});
test('failed delivery remains retryable and is not counted sent', async () => {
  const f = setup(); f.fail(true);
  assert.equal((await f.run()).errors, 1);
  assert.equal(f.tables.membership_tier_reminder_send[0].status, 'error');
  f.fail(false); await f.run();
  assert.equal(f.sends.length, 1);
});

test('tier with upfront card disabled withholds payment-link reminder with visible diagnostic', async () => {
  const f = setup();
  f.config.online_card_payment = false;
  const results = await f.run();
  assert.equal(results.details[0].code, 'payment_method_unavailable');
  assert.equal(f.sends.length, 0);
  assert.equal(f.tables.membership_tier_reminder_send.length, 0);
});