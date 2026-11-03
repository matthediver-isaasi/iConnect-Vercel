import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizePostGraceRecordDates } from './postGraceFinalization.js';

function mock({ receipt = null, error = null, journal = true } = {}) {
  const calls = [];
  const saved = { id: 'reservation', tenant_id: 'tenant', member_id: 'member', election_id: 'election',
    previous_term_id: 'prior', status: 'reserved', payment_method: 'upfront', first_payment_minor: 7100,
    currency: 'GBP', created_at: '2026-11-01T00:00:00Z', grace_end_date: '2026-10-21' };
  const tables = {
    membership_post_grace_renewal: journal ? saved : null,
    membership_post_grace_date_application: receipt,
    member_membership_history: { id: 'history', tenant_id: 'tenant', member_id: 'member',
      previous_term_id: 'prior', membership_successor_election_id: 'election',
      status: 'pending', payment_status: 'unpaid', commitment_snapshot: { price: 71 } },
  };
  return {
    calls,
    from(table) {
      const filters = [];
      return { select() { return this; }, eq(...args) { filters.push(args); return this; }, neq() { return this; },
        async maybeSingle() { calls.push({ table, filters }); return { data: tables[table], error: null }; } };
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return { error, data: error ? null : { state: 'applied', reservation_id: 'reservation',
        tenant_id: 'tenant', member_id: 'member', before_rows: args.p_expected } };
    },
  };
}
function input() {
  return { tenantId: 'tenant', memberId: 'member', electionId: 'election', now: '2026-11-09T00:00:00Z',
    evidence: { tenantId: 'tenant', memberId: 'member', reservationId: 'reservation',
      provider: 'stripe', status: 'succeeded', id: 'pi-paid', paidAt: '2026-11-07T10:00:00Z',
      amountMinor: 7100, currency: 'GBP' } };
}
test('uses one atomic RPC, exact before image, and never releases collection hold', async () => {
  const db = mock();
  const result = await finalizePostGraceRecordDates(db, input());
  assert.equal(result.applicable, true);
  assert.equal(result.releaseCollectionHold, false);
  const calls = db.calls.filter(x => x.name);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'apply_post_grace_record_dates');
  assert.deepEqual(calls[0].args.p_expected.history.commitment_snapshot, { price: 71 });
});
test('ordinary successor without late-renewal reservation is untouched', async () => {
  const db = mock({ journal: false });
  assert.deepEqual(await finalizePostGraceRecordDates(db, input()), { applicable: false });
  assert.equal(db.calls.length, 1);
});
test('replay submits the stored before image for database evidence validation', async () => {
  const before = { history: { id: 'original' }, agreement: null, plan: null };
  const db = mock({ receipt: { state: 'applied', before_rows: before } });
  await finalizePostGraceRecordDates(db, input());
  assert.deepEqual(db.calls.at(-1).args.p_expected, before);
  assert.equal(db.calls.some(x => x.table === 'member_membership_history'), false);
});
test('missing migration or denied RPC never falls back to partial row updates', async () => {
  const db = mock({ error: { code: 'PGRST202', message: 'function missing' } });
  await assert.rejects(finalizePostGraceRecordDates(db, input()), /not finalized/);
  assert.equal(db.calls.filter(x => x.name).length, 1);
});
test('wrong member evidence is rejected before loading or writing membership', async () => {
  const db = mock(), args = input(); args.evidence.memberId = 'other';
  await assert.rejects(finalizePostGraceRecordDates(db, args), /does not belong/);
  assert.equal(db.calls.length, 1);
});
