import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDdLifecycleEmail, sendDdInvitationEmail, sendDdMigrationInviteEmail } from './gocardlessDdEmails.js';

function agreement(pricing = 'dynamic', end = 'continue') {
  return {
    id: 'agreement', tenant_id: 'tenant', organization_id: 'org', dd_payer: 'billing_contact',
    billing_contact_email: 'billing@example.test', billing_contact_name: 'Alex',
    metadata: { dd: {
      kind: 'monthly_direct_debit', membership_year: '2026/2027', monthly_amount: 10.66,
      currency: 'GBP', instalment_count: 12, plan_total: pricing === 'dynamic' ? null : 127.92,
      collection_policy: { version: 1, pricing_policy: pricing, end_policy: end },
    } },
  };
}

for (const end of ['stop', 'continue']) {
  for (const event of ['setup_started', 'mandate_active', 'first_collection_scheduled', 'membership_activated', 'renewal_notice', 'renewal_confirmation_required', 'renewal_confirmed', 'plan_completed']) {
    test(`dynamic ${end} ${event}: no fixed term-price or zero-total promise`, async () => {
      let mail;
      const result = await sendDdLifecycleEmail(event, agreement('dynamic', end), {
        send: async (value) => { mail = value; return { success: true }; },
        extraContext: { newMonthlyAmount: '15.00', newPlanTotal: null, newInstalmentCount: 12 },
      });
      assert.equal(result.sent, true);
      assert.doesNotMatch(mail.html, /12 (monthly )?(payments|instalments) of|total GBP 0\.00|fully paid/);
      assert.match(mail.html, /applicable active membership structure price/);
      assert.match(mail.html, end === 'stop' ? /stop at term end/ : /continue into each new membership term/);
    });
  }
}

test('variable-price receipt does not confuse original quote with the collected amount', async () => {
  let html;
  const send = async (mail) => { html = mail.html; return { success: true }; };
  await sendDdLifecycleEmail('payment_confirmed', agreement(), { send });
  assert.doesNotMatch(html, /10\.66|0\.00/);
  await sendDdLifecycleEmail('payment_confirmed', agreement(), { send, extraContext: { paymentAmount: 17.5 } });
  assert.match(html, /GBP 17\.50/);
});

test('fixed and legacy receipts retain agreed amounts without fabricated renewal authority', async () => {
  const saved = agreement('fixed');
  delete saved.metadata.dd.collection_policy;
  let html;
  await sendDdLifecycleEmail('mandate_active', saved, { send: async (mail) => { html = mail.html; return { success: true }; } });
  assert.match(html, /12 monthly payments of GBP 10\.66/);
  assert.match(html, /review is required/);
  assert.doesNotMatch(html, /continue into/);
});

test('organisation and migration invitations use dynamic consent wording without a total', async () => {
  let html;
  const send = async (mail) => { html = mail.html; return { success: true }; };
  const orgResult = await sendDdInvitationEmail({
    agreement: agreement(), invitation: { invited_email: 'billing@example.test' },
    setupUrl: 'https://example.test/consent', send,
  });
  assert.equal(orgResult.sent, true);
  assert.match(html, /indicative monthly price: GBP 10\.66/);
  assert.doesNotMatch(html, /total GBP|12 monthly payments of/);
  const migrationResult = await sendDdMigrationInviteEmail({
    tenantId: 'tenant', member: { id: 'member', email: 'member@example.test' },
    invite: { token: 'test-invite', switch_from_year: '2027/2028' }, setupUrl: 'https://example.test/consent',
    offer: { collectionPolicy: agreement().metadata.dd.collection_policy, monthlyAmount: 12, instalmentCount: 12, planTotal: null, currency: 'GBP' },
    send,
  });
  assert.equal(migrationResult.sent, true);
  assert.match(html, /indicative monthly price: GBP 12\.00/);
  assert.doesNotMatch(html, /total GBP|12 monthly payments of/);
});