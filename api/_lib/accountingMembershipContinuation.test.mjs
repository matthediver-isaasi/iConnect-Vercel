import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { continueMembershipNotification, freezeMembershipNotification } from './accountingMembershipContinuation.js';
import { processAccountingRequest } from './accountingRequestQueue.js';
import { supportsPreparedMembershipSource } from './accountingQueueIntegration.js';

function fixture(provider = 'xero', source = 'member_membership_history') {
  const row = {
    id: 'request', tenant_id: 'tenant', provider, source_type: source, source_id: 'history',
    payment_status: 'skipped', invoice_status: 'done', link_status: 'pending',
    invoice_result: { id: 'invoice', invoiceNumber: provider === 'xero' ? 'INV-1' : null,
      onlineInvoiceUrl: 'https://example.invalid/invoice' },
    snapshot: { payment: null, notification: { version: 1, recipients: ['a@example.invalid', 'b@example.invalid'],
      email: { membershipYear: '2026', finalCost: 100, currency: 'GBP' }, note: 'Renewal.' } },
    lease_token: 'lease', attempts: 1,
  };
  const deliveries = new Map();
  let notes = 0;
  let failFinish = false;
  let loseNoteResponse = false;
  const db = { async rpc(name, args) {
    if (name === 'accounting_membership_notification_receipts') {
      return { data: [...deliveries].map(([recipient, receipt]) => ({ recipient, status: receipt.status })) };
    }
    if (name === 'accounting_membership_notification_claim') {
      const old = deliveries.get(args.p_recipient);
      if (old && old.status !== 'pending') return { data: { ...old, claimed: false } };
      const claim = { token: 'send-token', status: 'sending' };
      deliveries.set(args.p_recipient, claim);
      return { data: { ...claim, claimed: true } };
    }
    if (name === 'accounting_membership_notification_finish') {
      if (failFinish) { failFinish = false; throw new Error('Lost persistence'); }
      deliveries.set(args.p_recipient, { status: args.p_status, messageId: args.p_message_id });
      return { data: true };
    }
    if (name === 'accounting_membership_notification_note') {
      assert.ok([...deliveries.values()].every(d => d.status === 'delivered'));
      notes = 1;
      if (loseNoteResponse) { loseNoteResponse = false; throw new Error('Lost note response'); }
      return { data: true };
    }
    if (name === 'accounting_request_checkpoint') {
      row[`${args.p_stage}_status`] = args.p_status;
      if (args.p_status === 'done') row[`${args.p_stage}_result`] = args.p_result;
    } else if (name === 'accounting_request_finish') {
      row.state = args.p_state;
      row.last_error = args.p_error;
    } else if (name === 'accounting_request_guard') return { data: true };
    else assert.equal(name, 'accounting_request_claim');
    return { data: structuredClone(row) };
  } };
  const sent = [];
  const deps = {
    renderAndSend: async args => {
      assert.equal(args.xeroInvoiceId, 'invoice');
      assert.equal(args.skipNote, true);
      assert.equal(args.xeroInvoiceNumber, provider === 'xero' ? 'INV-1' : null);
      return args.send({ tenantId: args.tenantId, to: args.memberEmail });
    },
    send: async message => { sent.push(message.to); return { success: true, messageId: `message-${sent.length}` }; },
  };
  const run = () => continueMembershipNotification({ db, row }, deps);
  return { db, row, deliveries, sent, deps, run, get notes() { return notes; },
    crashFinish: () => { failFinish = true; }, crashNote: () => { loseNoteResponse = true; } };
}

for (const provider of ['xero', 'quickbooks']) for (const source of [
  'member_membership_history', 'organisation_membership_history',
]) {
  test(`${provider}/${source}: partial retry skips delivered recipients and atomic note replay`, async () => {
    const f = fixture(provider, source);
    const originalSend = f.deps.send;
    let rejected = false;
    f.deps.send = async message => {
      if (message.to.startsWith('b') && !rejected) {
        rejected = true;
        return { success: false, ambiguousEffect: false };
      }
      return originalSend(message);
    };
    await assert.rejects(f.run(), /DELIVERY_PENDING/);
    assert.equal(f.notes, 0);
    f.crashNote();
    await assert.rejects(f.run(), /Lost note response/);
    await f.run();
    assert.deepEqual(f.sent, ['a@example.invalid', 'b@example.invalid']);
    assert.equal(f.notes, 1);
  });

  test(`${provider}/${source}: existing renderer uses guarded delivery without its legacy note`, async () => {
    const f = fixture(provider, source);
    f.db.from = table => {
      assert.ok(['tenant', 'email_template'].includes(table), `Unexpected table ${table}`);
      const result = { data: table === 'tenant' ? { name: 'Tenant' } : null };
      return { select() { return this; }, eq() { return this; },
        maybeSingle: async () => result, single: async () => result };
    };
    const renderer = source === 'member_membership_history'
      ? (await import('../membership/member-membership-invoicing.js')).sendMemberInvoiceEmail
      : (await import('./membershipInvoiceEmail.js')).sendMembershipInvoiceEmail;
    f.deps.renderAndSend = args => renderer({ ...args, buildInbox: async () => null });
    const send = f.deps.send;
    f.deps.send = message => {
      assert.match(message.html, /2026/);
      assert.match(message.html, /https:\/\/example.invalid\/invoice/);
      if (provider === 'quickbooks') assert.doesNotMatch(message.html, /Invoice Number/);
      return send(message);
    };
    await f.run();
    await f.run();
    assert.equal(f.sent.length, 2);
    assert.equal(f.notes, 1);
  });

  test(`${provider}/${source}: uncertain send and lost send checkpoint never resend`, async () => {
    const f = fixture(provider, source);
    f.crashFinish();
    await assert.rejects(f.run(), /Lost persistence/);
    await assert.rejects(f.run(), /REQUIRES_REVIEW/);
    await assert.rejects(f.run(), /REQUIRES_REVIEW/);
    assert.deepEqual(f.sent, ['a@example.invalid', 'b@example.invalid']);
    assert.equal(f.notes, 0);
  });

  test(`${provider}/${source}: worker retries only continuation, never invoice, payment or activation`, async () => {
    const f = fixture(provider, source);
    let financialWrites = 0;
    let failSend = true;
    const send = f.deps.send;
    f.deps.send = async message => {
      if (failSend) return { success: false, ambiguousEffect: false };
      return send(message);
    };
    const adapters = async () => ({
      assertBinding: async () => {},
      createInvoice: async () => { financialWrites++; throw new Error('Forbidden'); },
      createPayment: async () => { financialWrites++; throw new Error('Forbidden'); },
      linkSource: async row => {
        await continueMembershipNotification({ db: f.db, row }, f.deps);
        return { linked: true };
      },
    });
    const run = () => processAccountingRequest({ db: f.db, requestId: f.row.id, adapters });
    assert.equal((await run()).state, 'retry');
    failSend = false;
    assert.equal((await run()).state, 'complete');
    assert.equal((await run()).state, 'complete');
    assert.equal(financialWrites, 0);
    assert.equal(f.sent.length, 2);
    assert.equal(f.notes, 1);
  });
}

test('ambiguous responses, thrown transport errors and missing receipts require review', async () => {
  for (const send of [
    async () => ({ success: false, ambiguousEffect: true }),
    async () => { throw new Error('Timeout'); },
    async () => ({ success: true }),
  ]) {
    const f = fixture();
    let attempts = 0;
    f.deps.send = async m => { attempts++; return send(m); };
    await assert.rejects(f.run(), /REQUIRES_REVIEW/);
    await assert.rejects(f.run(), /REQUIRES_REVIEW/);
    assert.equal(attempts, 2);
  }
});

test('100 recipients make forward progress across worker budgets without resending completed prefixes', async () => {
  const f = fixture();
  f.row.snapshot.notification.recipients = Array.from({ length: 100 }, (_, i) => `recipient-${i}@example.invalid`);
  let runs = 0;
  while (f.notes === 0 && runs < 10) {
    runs++;
    let requests = 10; // Reserve the same budget for binding/financial/link calls.
    f.deps.beforeSend = async () => {
      if (++requests > 40) throw new Error('ACCOUNTING_QUEUE_REQUEST_BUDGET_EXHAUSTED');
    };
    try { await f.run(); }
    catch (error) { assert.match(error.message, /BUDGET_EXHAUSTED/); }
  }
  assert.equal(f.notes, 1);
  assert.ok(runs > 1 && runs < 10);
  assert.equal(f.sent.length, 100);
  assert.equal(new Set(f.sent).size, 100);
});

test('Mailgun server failures stay review-only through the real transport wrapper', async () => {
  const { sendTenantEmail } = await import('./tenantEmailService.js');
  for (const status of [500, 502, 503, 504, 408, undefined]) {
    const f = fixture();
    let attempts = 0;
    f.deps.send = message => sendTenantEmail({
      ...message, tenantId: null, subject: 'Test', html: '<p>Invoice</p>',
      mailgunClient: { messages: { create: async () => {
        attempts++;
        throw Object.assign(new Error('Provider response failed'), { status });
      } } },
    });
    await assert.rejects(f.run(), /REQUIRES_REVIEW/);
    await assert.rejects(f.run(), /REQUIRES_REVIEW/);
    assert.equal(attempts, 2, `No repeat transport for status ${status}`);
    assert.equal(f.notes, 0);
  }
});

test('failure before transport and deadline exhaustion never claim a send', async () => {
  const f = fixture();
  const render = f.deps.renderAndSend;
  f.deps.renderAndSend = async () => ({ success: false });
  await assert.rejects(f.run(), /DELIVERY_PENDING/);
  assert.equal(f.deliveries.size, 0);
  f.deps.renderAndSend = render;
  f.deps.beforeSend = async () => { throw new Error('Budget exhausted'); };
  await assert.rejects(f.run(), /Budget exhausted/);
  assert.equal(f.deliveries.size, 0);
  delete f.deps.beforeSend;
  await f.run();
});

test('missing historical notification authority and payment ownership fail closed', async () => {
  const f = fixture();
  f.row.payment_status = 'done';
  await assert.rejects(f.run(), /AUTHORITY_REQUIRED/);
  f.row.payment_status = 'skipped';
  delete f.row.snapshot.notification;
  await assert.rejects(f.run(), /AUTHORITY_REQUIRED/);
  assert.equal(f.sent.length, 0);
});

test('notification captures recipient selection once, deduplicates, and validates ownership', async () => {
  const args = { appTenantId: 'tenant', accountingSource: {
    sourceType: 'organisation_membership_history', linkage: { ownerId: 'org' },
    notification: { organizationId: 'org', membershipYear: '2026', note: 'Renewed.',
      tierConfig: { invoice_recipients: {} }, createdBy: 'actor' },
  } };
  const frozen = await freezeMembershipNotification({ args, db: {} }, {
    resolveRecipients: async () => ({ recipients: ['A@example.invalid', 'a@example.invalid', 'b@example.invalid'] }),
  });
  args.accountingSource.notification.note = 'Changed';
  assert.equal(frozen.note, 'Renewed.');
  assert.deepEqual(frozen.recipients, ['a@example.invalid', 'b@example.invalid']);
  assert.equal(frozen.email.tierConfig, undefined);
  args.accountingSource.notification.organizationId = 'foreign';
  await assert.rejects(freezeMembershipNotification({ args, db: {} }), /AUTHORITY_REQUIRED/);
});

test('new adoption requires explicit continuation and excludes separate settlement owners', () => {
  const args = { accountingSource: { sourceType: 'member_membership_history', sourceId: 'record',
    linkage: { ownerId: 'owner' }, notification: {} } };
  assert.equal(supportsPreparedMembershipSource(args), true);
  for (const extra of [{ markAsPaid: true }, { deferStripeSettlement: true }, { ddAccountingMigration: {} },
    { stripePaymentIntentId: 'pi' }, { extraLineItems: [{}] }]) {
    assert.equal(supportsPreparedMembershipSource({ ...args, ...extra }), false);
  }
  delete args.accountingSource.notification;
  assert.equal(supportsPreparedMembershipSource(args), false);
});

test('all manual producers hand off successful queue completions before legacy email/add-on/note code', () => {
  for (const file of ['member', 'org']) {
    const text = readFileSync(new URL(`../membership/${file}-membership-invoicing.js`, import.meta.url), 'utf8');
    const branches = text.match(/if \(xeroInvoice\?\.accounting_request_id\) \{[\s\S]*?\n\s*\}/g);
    assert.equal(branches.length, file === 'org' ? 2 : 1);
    for (const branch of branches) {
      assert.match(branch, /return res\.status\(xeroInvoice\.accounting_pending \? 202 : 200\)/);
    }
    assert.match(text, /if \(xeroErr\.accountingSourceRetained\)/);
  }
});
