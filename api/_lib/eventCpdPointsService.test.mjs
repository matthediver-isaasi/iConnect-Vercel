import test from 'node:test';
import assert from 'node:assert/strict';
import {
  processCpdPointsAward,
  processCpdPointsOutbox,
  RetryableCpdPointsOutcomeError,
  resolveEffectiveCpdPointsRule,
} from './eventCpdPointsService.js';

test('points ticket precedence applies across triggers and supports no-award', () => {
  const rules = [
    { id: 'wide', active: true, trigger_type: 'registration', ticket_id: null, points_value: '2.5' },
    { id: 'ticket', active: true, trigger_type: 'attendance', ticket_id: 'vip', points_value: '7' },
    { id: 'none', active: true, trigger_type: 'attendance', ticket_id: 'free', is_no_award: true },
  ];
  assert.equal(resolveEffectiveCpdPointsRule(rules, 'vip', 'attendance').id, 'ticket');
  assert.equal(resolveEffectiveCpdPointsRule(rules, 'vip', 'registration'), null);
  assert.equal(resolveEffectiveCpdPointsRule(rules, 'standard', 'registration').id, 'wide');
  assert.equal(resolveEffectiveCpdPointsRule(rules, 'free', 'attendance').id, 'none');
});

function awardDb({ table = 'booking', status = 'confirmed', memberRows, currentOutcome } = {}) {
  let recorded;
  const booking = {
    id: 'b1', tenant_id: 't1', event_id: 'e1', status,
    member_id: 'buyer', attendee_email: 'attendee@example.test',
    ticket_class_id: 'vip', ticket_class_name: 'VIP',
  };
  const db = {
    from(name) {
      const chain = {
        select() { return this; }, eq() { return this; }, ilike() { return this; }, limit() { return this; },
        maybeSingle() {
          if (name === table) return Promise.resolve({ data: booking, error: null });
          if (name === 'attendance_current_outcome') {
            return Promise.resolve({ data: currentOutcome || null, error: null });
          }
          if (name === 'member') return Promise.resolve({ data: null, error: null });
          throw new Error(`Unexpected table ${name}`);
        },
        then(resolve, reject) {
          if (name === 'member') {
            return Promise.resolve({ data: memberRows ?? [{
              id: 'm1', email: 'attendee@example.test',
            }], error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
    async rpc(name, args) {
      assert.equal(name, 'record_event_cpd_points_award');
      recorded = args.p_attempt;
      return { data: recorded, error: null };
    },
  };
  return { db, get recorded() { return recorded; } };
}

for (const [bookingType, eventType] of [
  ['booking', 'event'],
  ['complex_event_booking', 'complex_event'],
]) {
  test(`registration processing supports ${eventType}`, async () => {
    const mock = awardDb({ table: bookingType });
    const result = await processCpdPointsAward({
      tenantId: 't1', bookingType, bookingId: 'b1',
      triggerType: 'registration', idempotencyKey: `registration:${bookingType}:b1`,
    }, { db: mock.db });
    assert.equal(result.status, 'awarded');
    assert.equal(result.event_type, eventType);
    assert.equal(result.ticket_id, 'vip');
    assert.equal(result.member_id, 'm1');
  });
}

test('cancelled and unmatched registrations are explicit non-awards', async () => {
  const cancelled = awardDb({ status: 'cancelled' });
  assert.equal((await processCpdPointsAward({
    tenantId: 't1', bookingType: 'booking', bookingId: 'b1',
    triggerType: 'registration', idempotencyKey: 'cancelled',
  }, { db: cancelled.db })).status, 'skipped_cancelled');

  const unmatched = awardDb({ memberRows: [] });
  assert.equal((await processCpdPointsAward({
    tenantId: 't1', bookingType: 'booking', bookingId: 'b1',
    triggerType: 'registration', idempotencyKey: 'unmatched',
  }, { db: unmatched.db })).status, 'skipped_unmatched');
});

for (const provider of ['zoom', 'teams']) {
  test(`${provider} attendance is normalized and revalidated`, async () => {
    const mock = awardDb({
      currentOutcome: { outcome_revision_id: 'r1', status: 'attended' },
    });
    const result = await processCpdPointsAward({
      tenantId: 't1', bookingType: 'booking', bookingId: 'b1',
      triggerType: 'attendance', idempotencyKey: `${provider}:b1:r1`,
      evidenceId: 'r1',
      evidence: {
        type: provider, finalized: true, status: 'attended',
        attendanceTargetId: 'target', revisionId: 'r1',
      },
    }, { db: mock.db });
    assert.equal(result.status, 'awarded');
    assert.equal(result.evidence_type, provider);
    assert.equal(result.evidence_snapshot.currentMatchesQueued, true);
  });
}

test('outbox retries failed points independently and uses lock token', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === 'claim_event_cpd_points_outbox') return {
        data: [{
          id: 'o1', tenant_id: 't1', booking_type: 'booking', booking_id: 'missing',
          trigger_type: 'registration', idempotency_key: 'key', lock_token: 'lock',
          evidence_snapshot: {},
        }],
        error: null,
      };
      if (name === 'record_event_cpd_points_award') {
        return { data: null, error: { message: 'temporary failure' } };
      }
      return { data: true, error: null };
    },
    from() {
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
      };
    },
  };
  const result = await processCpdPointsOutbox(db, { maxAttempts: 4 });
  assert.deepEqual(result, { claimed: 1, completed: 0, failed: 1 });
  const failure = calls.find(([name]) => name === 'fail_event_cpd_points_outbox');
  assert.equal(failure[1].p_lock_token, 'lock');
  assert.equal(failure[1].p_max_attempts, 4);
});

test('pending and error attempt outcomes remain retryable', async () => {
  for (const status of ['pending_evidence', 'error']) {
    const mock = awardDb();
    mock.db.rpc = async () => ({ data: { status }, error: null });
    await assert.rejects(
      processCpdPointsAward({
        tenantId: 't1', bookingType: 'booking', bookingId: 'b1',
        triggerType: 'registration', idempotencyKey: `retry:${status}`,
      }, { db: mock.db }),
      error => error instanceof RetryableCpdPointsOutcomeError
        && error.outcome.status === status,
    );
  }
});
