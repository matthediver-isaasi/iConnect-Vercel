import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeDynamicTerm, notifyDynamicTermCompletion, reconcileDynamicTermCompletions,
} from './gocardlessDynamicCompletion.js';

function fixture() {
  const plan = { id: 'plan', tenant_id: 'tenant', provider: 'gocardless', status: 'active',
    completed_at: null, metadata: { collection_mode: 'dynamic' } };
  const completion = { plan_id: plan.id, tenant_id: 'tenant', billing_agreement_id: 'agreement',
    notification_status: 'pending', notification_next_check_at: '2027-01-01T00:00:00Z', notification_messages: null };
  const rows = {
    membership_payment_plans: [plan],
    membership_billing_agreements: [{ id: 'agreement', tenant_id: 'tenant' }],
    gocardless_dynamic_term_completions: [completion],
  };
  const deliveries = new Map();
  Object.defineProperty(rows, 'gocardless_dynamic_completion_deliveries', { get: () => [...deliveries.values()] });
  const f = { plan, completion, rows, deliveries, messages: [], calls: [], paid: true, crashFinish: false, expireLease: false,
    now: () => new Date('2027-01-02T12:00:00Z') };
  const copy = data => ({ data: structuredClone(data), error: null });
  f.db = {
    from(table) {
      let filters = [], patch, single = false;
      const q = {
        select() { return this; }, order() { return this; }, limit() { return this; }, or() { return this; },
        eq(key, value) { filters.push(row => key.includes('->>') ? row.metadata.collection_mode === value : row[key] === value); return this; },
        neq(key, value) { filters.push(row => row[key] !== value); return this; },
        is(key, value) { filters.push(row => (row[key] ?? null) === value); return this; },
        lte(key, value) { filters.push(row => row[key] <= value); return this; },
        update(value) { patch = value; return this; },
        single() { single = true; return this; },
        then(resolve, reject) {
          const matched = (rows[table] || []).filter(row => filters.every(fn => fn(row)));
          if (patch) matched.forEach(row => Object.assign(row, patch));
          return Promise.resolve(copy(single ? matched[0] : matched)).then(resolve, reject);
        },
      };
      return q;
    },
    async rpc(name, p) {
      f.calls.push(name);
      if (name === 'complete_gocardless_dynamic_term') {
        if (!f.paid) return copy({ completed: false });
        plan.status = 'expired'; plan.completed_at ||= f.now().toISOString();
        return copy({ completed: true, completion });
      }
      if (name === 'prepare_gocardless_dynamic_completion_notice') {
        completion.notification_messages ||= structuredClone(p.p_messages);
        return copy(completion);
      }
      if (name === 'claim_gocardless_dynamic_completion_delivery') {
        const d = deliveries.get(p.p_recipient) || {
          id: p.p_recipient, plan_id: plan.id, tenant_id: 'tenant', recipient: p.p_recipient,
          status: 'pending', message: p.p_message, claim_token: `claim-${p.p_recipient}`,
        };
        deliveries.set(p.p_recipient, d);
        if (d.status === 'sending' && f.expireLease) d.status = 'uncertain';
        if (['sending', 'sent', 'uncertain'].includes(d.status)) return copy({ claimed: false, delivery: d });
        d.status = 'sending';
        return copy({ claimed: true, delivery: d });
      }
      if (name === 'finish_gocardless_dynamic_completion_delivery') {
        if (f.crashFinish) return { error: { message: 'database interruption after provider accepted' } };
        const d = deliveries.get(p.p_delivery_id);
        d.status = p.p_status; d.provider_evidence = p.p_evidence;
        return copy(null);
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  f.emailLifecycle = async (_key, _agreement, { send }) => {
    for (const to of ['billing@example.test', 'primary@example.test']) {
      await send({ tenantId: 'tenant', to, subject: 'Term complete', html: 'The eligible monthly collections are complete.' });
    }
    return { sent: true };
  };
  f.sendEmail = async message => { f.messages.push(message); return { success: true, messageId: `mail-${f.messages.length}` }; };
  return f;
}

test('completion dispatch is recipient-idempotent across webhook and reconciliation replay', async () => {
  const f = fixture();
  const results = await Promise.all([completeDynamicTerm(f.plan, f), completeDynamicTerm(f.plan, f)]);
  assert.ok(results.every(result => result.completed));
  assert.equal(f.messages.length, 2);
  assert.equal(f.completion.notification_status, 'sent');
  await completeDynamicTerm(f.plan, f);
  assert.equal(f.messages.length, 2);
});

test('partial organisation delivery retries only definitely rejected recipient with retained message', async () => {
  const f = fixture();
  let reject = true;
  const send = f.sendEmail;
  f.sendEmail = async message => {
    if (message.to.startsWith('primary') && reject) return { success: false, error: 'provider rejected before acceptance', ambiguousEffect: false };
    return send(message);
  };
  await completeDynamicTerm(f.plan, f);
  assert.equal(f.messages.length, 1);
  assert.equal(f.completion.notification_status, 'pending');
  reject = false;
  f.emailLifecycle = async () => { throw new Error('must not rerender after recipient contacts changed'); };
  await completeDynamicTerm(f.plan, f);
  assert.equal(f.messages.length, 2);
  assert.equal(f.completion.notification_status, 'sent');
});

test('ambiguous provider acceptance is retained for review and never blindly resent', async () => {
  const f = fixture();
  f.sendEmail = async message => {
    f.messages.push(message);
    return { success: false, ambiguousEffect: true, error: 'socket disconnected after acceptance' };
  };
  await completeDynamicTerm(f.plan, f);
  assert.equal(f.completion.notification_status, 'review');
  await completeDynamicTerm(f.plan, f);
  assert.equal(f.messages.length, 2);
  assert.match(f.completion.notification_error, /uncertain/);
  assert.ok([...f.deliveries.values()].every(d => d.status === 'uncertain'));
});

test('crash after provider acceptance cannot cause duplicate email on outbox recovery', async () => {
  const f = fixture();
  f.crashFinish = true;
  await assert.rejects(completeDynamicTerm(f.plan, f), /database interruption/);
  assert.equal(f.messages.length, 1);
  assert.equal(f.plan.status, 'expired');
  f.crashFinish = false; f.expireLease = true;
  await notifyDynamicTermCompletion(f.completion, f);
  assert.equal(f.messages.filter(m => m.to === 'billing@example.test').length, 1);
  assert.equal(f.completion.notification_status, 'review');
});

test('reconciliation recovers an uncompleted term without requiring another webhook', async () => {
  const f = fixture();
  const result = await reconcileDynamicTermCompletions(f);
  assert.equal(result.completed, 1);
  assert.equal(f.plan.status, 'expired');
  assert.equal(f.messages.length, 2);
});

test('notification outbox recovers a committed, expired term excluded from live-plan scan', async () => {
  const f = fixture();
  f.plan.status = 'expired'; f.plan.completed_at = '2027-01-01T00:00:00Z';
  const result = await reconcileDynamicTermCompletions(f);
  assert.equal(result.completed, 0);
  assert.equal(result.notified, 1);
  assert.equal(f.calls.includes('complete_gocardless_dynamic_term'), false);
  assert.equal(f.messages.length, 2);
});

test('incomplete and failed evidence produce no notice; recovery is bounded and scheduled fairly', async () => {
  const f = fixture();
  f.paid = false; f.rows.gocardless_dynamic_term_completions = [];
  assert.deepEqual(await completeDynamicTerm(f.plan, f), { completed: false });
  assert.equal(f.messages.length, 0);
  await reconcileDynamicTermCompletions(f);
  assert.equal(f.plan.dynamic_completion_next_check_at, '2027-01-02T13:00:00.000Z');
  let ticks = 0;
  const result = await reconcileDynamicTermCompletions({ ...f, clock: () => ticks++ * 10000 });
  assert.equal(result.completed, 0);
});