import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSucceededMembershipPaymentIntent } from './membershipPaymentReconciliation.js';
import { buildRollingCommitment } from './rollingMembershipCommitment.js';

function fixture({ method = 'invoice', startDate = '2099-09-15', member = true } = {}) {
  const commitment = buildRollingCommitment({
    config: { id: 'tier-a', start_mode: 'immediate', billing_period: 'annual', currency: 'GBP' },
    startDate, paymentMethod: method, paymentFrequency: 'upfront',
    amounts: { annual_cost: 240, final_cost: 240, vat_amount: 48, total_with_vat: 288, currency: 'GBP' },
  });
  const owner = member ? { member_id: 'owner-a' } : { organization_id: 'owner-a' };
  const token = {
    id: 'token-a', tenant_id: 'tenant-a', ...owner,
    membership_year: commitment.term_key, status: 'pending',
    final_cost: 240, currency: 'GBP', cost_breakdown: { commitment, totalWithVat: 288, vatAmount: 48 },
  };
  const pi = {
    id: 'pi-a', status: 'succeeded', amount: 28800, currency: 'gbp',
    metadata: { tenant_id: 'tenant-a', ...owner, membership_year: commitment.term_key, token_id: token.id },
  };
  return { commitment, token, pi, owner, table: member ? 'member_membership_history' : 'organisation_membership_history' };
}
function database(f, existing = []) {
  const tables = {
    membership_fee_token: [structuredClone(f.token)],
    [f.table]: structuredClone(existing),
    member: [{ id: 'owner-a', tenant_id: 'tenant-a' }],
    organization: [{ id: 'owner-a', tenant_id: 'tenant-a' }],
  };
  const writes = [];
  return {
    tables, writes,
    from(table) {
      tables[table] ||= [];
      const predicates = [];
      let insert, update;
      function execute(single = false) {
        let data = tables[table].filter(row => predicates.every(predicate => predicate(row)));
        if (insert) {
          const row = { id: `new-${table}`, ...structuredClone(insert) };
          tables[table].push(row);
          writes.push({ table, insert: row });
          data = [row];
        } else if (update) {
          for (const row of data) Object.assign(row, structuredClone(update));
          writes.push({ table, update: structuredClone(update) });
        }
        return { data: structuredClone(single ? data[0] || null : data), error: null };
      }
      return {
        select() { return this; },
        eq(key, value) { predicates.push(row => row[key] === value); return this; },
        neq(key, value) { predicates.push(row => row[key] !== value); return this; },
        or() { return this; },
        insert(row) { insert = row; return this; },
        update(row) { update = row; return this; },
        async maybeSingle() { return execute(true); },
        async single() { return execute(true); },
        then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
      };
    },
  };
}

for (const member of [true, false]) {
  test(`${member ? 'member' : 'organisation'} fee-token reconciliation restores frozen commitment, not callback date`, async () => {
    const f = fixture({ member });
    const db = database(f);
    let fired = 0;
    const deps = { db, fireWorkflow: async () => { fired++; return { fired: true }; } };
    const result = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, deps);
    assert.equal(result.status, 'recorded');
    const row = db.tables[f.table][0];
    assert.equal(row.term_start_date, '2099-09-15');
    assert.equal(row.membership_renewal_date, '2100-09-15');
    assert.equal(row.status, 'scheduled');
    assert.equal(row.scheduled_activation_date, '2099-09-15');
    assert.equal(row.payment_status, 'paid');
    assert.equal(row.payment_method, 'invoice');
    assert.equal(row.stripe_payment_intent_id, 'pi-a');
    assert.equal(row.final_cost, 240);
    assert.equal(row.vat_amount, 48);
    assert.equal(row.total_with_vat, 288);
    const replay = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, deps);
    assert.equal(replay.status, 'already-recorded');
    assert.equal(db.tables[f.table].length, 1);
    assert.equal(fired, 1);
  });
}

test('upfront reserved invoice settles without changing immutable agreed method', async () => {
  const f = fixture({ startDate: '2020-09-15' });
  const existing = {
    id: 'history-a', ...f.commitment, ...f.owner, tenant_id: 'tenant-a',
    membership_year: f.commitment.term_key, payment_method: 'invoice',
    payment_status: 'unpaid', status: 'pending_payment_setup', total_with_vat: 288, currency: 'GBP',
  };
  const db = database(f, [existing]);
  const result = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, {
    db, fireWorkflow: async () => ({ fired: true }),
  });
  assert.equal(result.status, 'recorded');
  assert.equal(db.tables[f.table][0].payment_method, 'invoice');
  assert.equal(db.tables[f.table][0].status, 'active');
});

test('a charged payment with mismatched amount cannot activate or reprice a commitment', async () => {
  const f = fixture();
  f.pi.amount = 30000;
  const db = database(f);
  const result = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, {
    db, fireWorkflow: async () => { throw new Error('must not fire'); },
  });
  assert.equal(result.status, 'conflict');
  assert.equal(db.writes.length, 0);
});

test('legacy rolling payment without evidence is reported, never guessed from payment time', async () => {
  const f = fixture();
  delete f.token.cost_breakdown.commitment;
  const db = database(f);
  const result = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, { db });
  assert.equal(result.status, 'unmatched');
  assert.match(result.detail, /no (?:authoritative )?saved membership|no saved commitment/);
  assert.equal(db.writes.length, 0);
});

test('fee token pointing to another owner is not allowed to redirect settlement', async () => {
  const f = fixture();
  f.token.member_id = 'another-member';
  const db = database(f);
  const result = await recordSucceededMembershipPaymentIntent({ tenantId: 'tenant-a', paymentIntent: f.pi }, { db });
  assert.equal(result.status, 'conflict');
  assert.equal(db.writes.length, 0);
});