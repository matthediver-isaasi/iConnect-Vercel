// Tests for the pure/injectable parts of the member membership pause helpers
// (Task #3586).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBER_PAUSE_FIELDS,
  stripMemberPauseFields,
  isMemberPaused,
  isRestartDue,
  getPausedMemberIdSet,
} from './memberPause.js';

test('stripMemberPauseFields removes every pause field and reports them', () => {
  const body = {
    first_name: 'Jo',
    membership_paused: true,
    membership_paused_at: '2026-01-01T00:00:00Z',
    membership_pause_restart_date: '2026-06-01',
    membership_paused_by: 'Admin',
    membership_pause_reason: 'nope',
    membership_pause_gc_subscriptions: ['SB1'],
  };
  const stripped = stripMemberPauseFields(body);
  assert.deepEqual(new Set(stripped), new Set(MEMBER_PAUSE_FIELDS));
  assert.deepEqual(body, { first_name: 'Jo' });
});

test('stripMemberPauseFields tolerates non-object bodies', () => {
  assert.deepEqual(stripMemberPauseFields(null), []);
  assert.deepEqual(stripMemberPauseFields('x'), []);
});

test('isMemberPaused only true for explicit true (missing column => false)', () => {
  assert.equal(isMemberPaused({ membership_paused: true }), true);
  assert.equal(isMemberPaused({ membership_paused: false }), false);
  assert.equal(isMemberPaused({}), false);
  assert.equal(isMemberPaused(null), false);
});

test('isRestartDue compares restart date against now (UTC date)', () => {
  const paused = { membership_paused: true, membership_pause_restart_date: '2026-08-16' };
  assert.equal(isRestartDue(paused, new Date('2026-08-16T00:00:01Z')), true);
  assert.equal(isRestartDue(paused, new Date('2026-08-15T23:59:00Z')), false);
  // No restart date => never auto-due.
  assert.equal(isRestartDue({ membership_paused: true }, new Date()), false);
  // Not paused => never due.
  assert.equal(isRestartDue({ membership_paused: false, membership_pause_restart_date: '2020-01-01' }), false);
  // Garbage date => never due.
  assert.equal(isRestartDue({ membership_paused: true, membership_pause_restart_date: 'nonsense' }), false);
});

function fakeDb(result) {
  return {
    from() {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        then(resolve) { resolve(result); },
      };
      return chain;
    },
  };
}

test('getPausedMemberIdSet returns ids as a Set', async () => {
  const db = fakeDb({ data: [{ id: 'a' }, { id: 'b' }], error: null });
  const set = await getPausedMemberIdSet('t1', db);
  assert.deepEqual([...set].sort(), ['a', 'b']);
});

test('getPausedMemberIdSet fails open to empty set on missing column (42703)', async () => {
  const db = fakeDb({ data: null, error: { code: '42703', message: 'column does not exist' } });
  const set = await getPausedMemberIdSet('t1', db);
  assert.equal(set.size, 0);
});

// ---------------------------------------------------------------------------
// Ordering / failure-path tests for pauseMember / resumeMember.
// Local pause state must be persisted BEFORE any GoCardless call, and resume
// must clear access state BEFORE resuming payments, so the two can never
// silently diverge.
// ---------------------------------------------------------------------------

/**
 * Table-driven fake supabase client. `handlers` maps table name to
 * { select: fn(chain) -> result, update: fn(chain) -> result, insert: fn(row) -> result }.
 * Every call is logged to `calls`.
 */
function fakeSupabase(handlers, calls) {
  function makeChain(table) {
    const chain = {
      table,
      op: null,
      payload: null,
      filters: [],
      selectCols: null,
      select(cols) {
        if (!chain.op) chain.op = 'select';
        chain.selectCols = cols;
        return chain;
      },
      update(payload) { chain.op = 'update'; chain.payload = payload; return chain; },
      insert(payload) { chain.op = 'insert'; chain.payload = payload; return chain; },
      eq(col, val) { chain.filters.push(['eq', col, val]); return chain; },
      in(col, vals) { chain.filters.push(['in', col, vals]); return chain; },
      not(col, op, val) { chain.filters.push(['not', col, op, val]); return chain; },
      maybeSingle() { return chain; },
      then(resolve, reject) {
        calls.push({ table, op: chain.op, payload: chain.payload });
        const handler = handlers[table]?.[chain.op];
        try {
          resolve(handler ? handler(chain) : { data: null, error: null });
        } catch (e) {
          reject(e);
        }
      },
    };
    return chain;
  }
  return { from: (table) => makeChain(table) };
}

function fakeGcFactory(log, { failPause = false, failResume = false } = {}) {
  return async () => ({
    async pauseSubscription(id) {
      log.push(['gc-pause', id]);
      if (failPause) throw new Error('gc pause failed');
      return { status: 'paused' };
    },
    async resumeSubscription(id) {
      log.push(['gc-resume', id]);
      if (failResume) throw new Error('gc resume failed');
      return { status: 'active' };
    },
  });
}

const { pauseMember, resumeMember } = await import('./memberPause.js');

const baseMember = { id: 'm1', tenant_id: 't1', membership_paused: false };

test('pauseMember: if the state write fails, no GoCardless call is made', async () => {
  const calls = [];
  const gcLog = [];
  const db = fakeSupabase({
    member: {
      select: () => ({ data: { ...baseMember }, error: null }),
      update: () => ({ data: null, error: { message: 'db down' } }),
    },
  }, calls);
  const result = await pauseMember({
    tenantId: 't1', memberId: 'm1', reason: 'leave',
    db, gcFactory: fakeGcFactory(gcLog), invalidateSessions: async () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Failed to record pause/);
  assert.equal(gcLog.length, 0, 'GoCardless must not be touched when the pause was not recorded');
});

test('pauseMember: persists state, pauses GC subs, records ids and note', async () => {
  const calls = [];
  const gcLog = [];
  const updates = [];
  const db = fakeSupabase({
    member: {
      select: () => ({ data: { ...baseMember }, error: null }),
      update: (chain) => { updates.push(chain.payload); return { data: [{ id: 'm1' }], error: null }; },
    },
    membership_payment_plans: {
      select: () => ({ data: [{ id: 'p1', status: 'active', gocardless_subscription_id: 'SB1' }], error: null }),
    },
    member_note: { insert: () => ({ data: null, error: null }) },
  }, calls);
  let sessionsInvalidated = false;
  const result = await pauseMember({
    tenantId: 't1', memberId: 'm1', reason: 'maternity leave', restartDate: '2026-12-01',
    actorName: 'Admin A',
    db, gcFactory: fakeGcFactory(gcLog), invalidateSessions: async () => { sessionsInvalidated = true; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(sessionsInvalidated, true);
  assert.deepEqual(gcLog, [['gc-pause', 'SB1']]);
  // First update = pause state (before GC), second = recorded sub ids.
  assert.equal(updates[0].membership_paused, true);
  assert.equal(updates[0].membership_pause_reason, 'maternity leave');
  assert.ok(!('membership_pause_gc_subscriptions' in updates[0]));
  assert.deepEqual(updates[1], { membership_pause_gc_subscriptions: ['SB1'] });
  const noteInsert = calls.find(c => c.table === 'member_note' && c.op === 'insert');
  assert.match(noteInsert.payload.content, /maternity leave/);
  assert.match(noteInsert.payload.content, /Scheduled restart: 2026-12-01/);
});

test('pauseMember: GC pause failure still leaves the member paused, with a warning', async () => {
  const calls = [];
  const gcLog = [];
  const db = fakeSupabase({
    member: {
      select: () => ({ data: { ...baseMember }, error: null }),
      update: () => ({ data: [{ id: 'm1' }], error: null }),
    },
    membership_payment_plans: {
      select: () => ({ data: [{ id: 'p1', status: 'active', gocardless_subscription_id: 'SB1' }], error: null }),
    },
    member_note: { insert: () => ({ data: null, error: null }) },
  }, calls);
  const result = await pauseMember({
    tenantId: 't1', memberId: 'm1', reason: 'leave',
    db, gcFactory: fakeGcFactory(gcLog, { failPause: true }), invalidateSessions: async () => {},
  });
  assert.equal(result.ok, true, 'access pause must not be rolled back by a GC failure');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Failed to pause GoCardless subscription SB1/);
});

test('resumeMember: if clearing state fails, GC subscriptions are NOT resumed', async () => {
  const calls = [];
  const gcLog = [];
  const db = fakeSupabase({
    member: {
      select: () => ({ data: { ...baseMember, membership_paused: true, membership_pause_gc_subscriptions: ['SB1'] }, error: null }),
      update: () => ({ data: null, error: { message: 'db down' } }),
    },
  }, calls);
  const result = await resumeMember({ tenantId: 't1', memberId: 'm1', db, gcFactory: fakeGcFactory(gcLog) });
  assert.equal(result.ok, false);
  assert.equal(gcLog.length, 0, 'payments must not restart while access remains blocked');
});

test('resumeMember: clears state then resumes recorded subs; GC failure surfaces as warning + note', async () => {
  const calls = [];
  const gcLog = [];
  const db = fakeSupabase({
    member: {
      select: () => ({ data: { ...baseMember, membership_paused: true, membership_pause_gc_subscriptions: ['SB1'] }, error: null }),
      update: () => ({ data: [{ id: 'm1' }], error: null }),
    },
    member_note: { insert: () => ({ data: null, error: null }) },
  }, calls);
  const result = await resumeMember({ tenantId: 't1', memberId: 'm1', db, gcFactory: fakeGcFactory(gcLog, { failResume: true }) });
  assert.equal(result.ok, true);
  assert.deepEqual(gcLog, [['gc-resume', 'SB1']]);
  assert.equal(result.warnings.length, 1);
  const noteInsert = calls.find(c => c.table === 'member_note' && c.op === 'insert');
  assert.match(noteInsert.payload.content, /manual GoCardless attention/);
});

test('resumeMember: falls back to active plans when no sub ids were recorded', async () => {
  const calls = [];
  const gcLog = [];
  const db = fakeSupabase({
    member: {
      select: () => ({ data: { ...baseMember, membership_paused: true, membership_pause_gc_subscriptions: [] }, error: null }),
      update: () => ({ data: [{ id: 'm1' }], error: null }),
    },
    membership_payment_plans: {
      select: () => ({ data: [{ gocardless_subscription_id: 'SB9' }], error: null }),
    },
    member_note: { insert: () => ({ data: null, error: null }) },
  }, calls);
  const result = await resumeMember({ tenantId: 't1', memberId: 'm1', db, gcFactory: fakeGcFactory(gcLog) });
  assert.equal(result.ok, true);
  assert.deepEqual(gcLog, [['gc-resume', 'SB9']]);
});

test('resumeMember: not-paused member is a successful no-op (no GC calls, no note)', async () => {
  const calls = [];
  const gcLog = [];
  const db = fakeSupabase({
    member: { select: () => ({ data: { ...baseMember }, error: null }) },
  }, calls);
  const result = await resumeMember({ tenantId: 't1', memberId: 'm1', db, gcFactory: fakeGcFactory(gcLog) });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyResumed, true);
  assert.equal(gcLog.length, 0);
  assert.equal(calls.some(c => c.table === 'member_note'), false);
});
