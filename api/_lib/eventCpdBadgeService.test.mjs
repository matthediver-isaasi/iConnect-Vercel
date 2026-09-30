import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAttendanceEvidence,
  loadCurrentOnlineEvidence,
  loadCurrentQrEvidence,
  processCpdBadgeAward,
  resolveMember,
  resolveEffectiveCpdRule,
} from './eventCpdBadgeService.js';

function crossTriggerMockDb() {
  const calls = [];
  const db = {
    from(table) {
      calls.push({ table, queried: true });
      const state = { table, inserted: null, filters: [] };
      const chain = {
        select() { return this; },
        eq(key, value) { state.filters.push([key, value]); return this; },
        ilike() { return this; },
        is() { return this; },
        limit() { return this; },
        insert(row) { state.inserted = row; return this; },
        maybeSingle() {
          if (table === 'booking') return Promise.resolve({ data: {
            id: 'b1', tenant_id: 't1', event_id: 'e1', status: 'confirmed',
            member_id: 'm1', attendee_email: 'attendee@example.test',
            ticket_class_id: 'ticket-1', ticket_class_name: 'Ticket 1',
          }, error: null });
          if (table === 'member') return Promise.resolve({ data: { id: 'm1', email: 'attendee@example.test' }, error: null });
          throw new Error(`Unexpected maybeSingle ${table}`);
        },
        single() {
          calls.push({ table, inserted: state.inserted, filters: state.filters });
          return Promise.resolve({ data: { ...state.inserted, id: 'attempt-1' }, error: null });
        },
        then(resolve, reject) {
          if (table === 'event_cpd_badge_rule') {
            return Promise.resolve({
              data: [
                { id: 'wide', active: true, trigger_type: 'registration', ticket_id: null, badge_id: 'badge-1' },
                { id: 'ticket-attendance', active: true, trigger_type: 'attendance', ticket_id: 'ticket-1', badge_id: 'badge-2' },
              ], error: null,
            }).then(resolve, reject);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
    async rpc(name, args) {
      assert.equal(name, 'record_event_cpd_badge_award');
      calls.push({ table: 'rpc', inserted: args.p_attempt });
      return { data: { ...args.p_attempt, id: 'attempt-1' }, error: null };
    },
  };
  return { db, calls };
}

test('ticket rule overrides event-wide rule', () => {
  const rules = [
    { id: 'wide', trigger_type: 'registration', ticket_id: null, active: true },
    { id: 'ticket', trigger_type: 'registration', ticket_id: 't1', active: true },
  ];
  assert.equal(resolveEffectiveCpdRule(rules, 't1', 'registration').id, 'ticket');
  assert.equal(resolveEffectiveCpdRule(rules, 't2', 'registration').id, 'wide');
});

test('a ticket no-award override still wins precedence', () => {
  const effective = resolveEffectiveCpdRule([
    { id: 'wide', trigger_type: 'attendance', ticket_id: null, active: true },
    { id: 'none', trigger_type: 'attendance', ticket_id: 't1', active: true, is_no_award: true },
  ], 't1', 'attendance');
  assert.equal(effective.id, 'none');
  assert.equal(effective.is_no_award, true);
});

test('ticket override blocks event-wide fallback for its other trigger', () => {
  const rules = [
    { id: 'registration-wide', trigger_type: 'registration', ticket_id: null, active: true },
    { id: 't1-attendance', trigger_type: 'attendance', ticket_id: 't1', active: true },
  ];
  assert.equal(resolveEffectiveCpdRule(rules, 't1', 'registration'), null);
  assert.equal(resolveEffectiveCpdRule(rules, 't1', 'attendance').id, 't1-attendance');
  assert.equal(resolveEffectiveCpdRule(rules, 't2', 'registration').id, 'registration-wide');
});

test('award service defers locked rule and badge resolution to the atomic RPC', async () => {
  const { db, calls } = crossTriggerMockDb();
  const result = await processCpdBadgeAward({
    tenantId: 't1', bookingType: 'booking', bookingId: 'b1',
    triggerType: 'registration', idempotencyKey: 'registration:booking:b1',
  }, { db });
  assert.equal(result.status, 'granted');
  const rulesCall = calls.find(call => call.table === 'event_cpd_badge_rule');
  assert.equal(rulesCall, undefined); // rule query is awaited (not a write)
  const attempt = calls.find(call => call.table === 'rpc');
  assert.equal(attempt.inserted.status, 'granted');
  assert.equal(attempt.inserted.rule_id, null);
  assert.equal(attempt.inserted.badge_id, null);
});

test('recipient resolution prefers exact attendee email and does not trust purchaser member_id', async () => {
  let ilikePattern;
  const db = {
    from() {
      return {
        select() { return this; }, eq() { return this; }, limit() { return this; },
        ilike(column, pattern) { ilikePattern = pattern; return this; },
        then(resolve, reject) {
          return Promise.resolve({
            data: [{ id: 'attendee-member', email: 'A_%@Example.Test' }], error: null,
          }).then(resolve, reject);
        },
      };
    },
  };
  assert.equal(await resolveMember(db, 'tenant-1', {
    member_id: 'purchaser-member', attendee_email: 'a_%@example.test',
  }), 'attendee-member');
  assert.equal(ilikePattern, 'a\\_\\%@example.test');
  assert.equal(await resolveMember(db, 'tenant-1', {
    member_id: 'purchaser-member', attendee_email: '',
  }), null);
});

test('inactive and other-trigger rules do not resolve', () => {
  assert.equal(resolveEffectiveCpdRule([
    { trigger_type: 'registration', ticket_id: null, active: false },
    { trigger_type: 'attendance', ticket_id: null, active: true },
  ], null, 'registration'), null);
});

test('attendance evidence fails closed and recognizes all providers', () => {
  assert.equal(decideAttendanceEvidence(null).state, 'pending');
  assert.equal(decideAttendanceEvidence({ type: 'qr_checkin', checkedInAt: 'now' }).qualifies, true);
  assert.equal(decideAttendanceEvidence({ type: 'zoom', finalized: false, status: 'attended' }).qualifies, false);
  assert.equal(decideAttendanceEvidence({ type: 'zoom', finalized: true, status: 'attended' }).qualifies, true);
  assert.equal(decideAttendanceEvidence({ type: 'teams', finalized: true, status: 'absent' }).qualifies, false);
  assert.equal(decideAttendanceEvidence({ type: 'other', finalized: true, status: 'attended' }).qualifies, false);
  const malformed = decideAttendanceEvidence({ type: 'zoom', finalized: true, status: 'ATTENDED' });
  assert.equal(malformed.state, 'error');
  assert.equal(malformed.reason, 'invalid_outcome_status');
});

test('stale attended online evidence is reloaded and skipped after absent supersedes it', async () => {
  let recorded;
  const db = {
    from(table) {
      const chain = {
        select() { return this; }, eq() { return this; }, ilike() { return this; }, limit() { return this; },
        maybeSingle() {
          if (table === 'booking') return Promise.resolve({ data: {
            id: 'b1', tenant_id: 't1', event_id: 'e1', status: 'confirmed',
            attendee_email: 'attendee@example.test', ticket_class_id: 'ticket-1',
          }, error: null });
          if (table === 'attendance_current_outcome') return Promise.resolve({ data: {
            outcome_revision_id: 'revision-2', status: 'absent',
          }, error: null });
          throw new Error(`Unexpected maybeSingle ${table}`);
        },
        then(resolve, reject) {
          if (table === 'member') return Promise.resolve({
            data: [{ id: 'm1', email: 'attendee@example.test' }], error: null,
          }).then(resolve, reject);
          if (table === 'event_cpd_badge_rule') return Promise.resolve({
            data: [{ id: 'r1', active: true, trigger_type: 'attendance', ticket_id: null, badge_id: 'badge-1' }],
            error: null,
          }).then(resolve, reject);
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
    async rpc(name, args) {
      assert.equal(name, 'record_event_cpd_badge_award');
      recorded = args.p_attempt;
      return { data: recorded, error: null };
    },
  };
  const evidence = await loadCurrentOnlineEvidence(db, {
    tenantId: 't1', bookingType: 'booking', bookingId: 'b1',
    evidence: { type: 'zoom', finalized: true, status: 'attended', attendanceTargetId: 'target-1', revisionId: 'revision-1' },
  });
  assert.equal(evidence.currentMatchesQueued, false);
  assert.deepEqual(decideAttendanceEvidence(evidence), {
    state: 'final', qualifies: false, reason: 'outcome_absent',
  });
  await processCpdBadgeAward({
    tenantId: 't1', bookingType: 'booking', bookingId: 'b1', triggerType: 'attendance',
    idempotencyKey: 'attendance:zoom:b1:target-1:revision-1', evidence,
  }, { db });
  assert.equal(recorded.status, 'skipped_not_qualifying');
  assert.equal(recorded.detail, 'outcome_absent');
  assert.equal(recorded.evidence_snapshot.attendanceTargetId, 'target-1');
  assert.equal(recorded.evidence_snapshot.revisionId, 'revision-1');
});

test('QR evidence fails closed after reversal and reload preserves provenance', async () => {
  const db = {
    from(table) {
      assert.equal(table, 'booking');
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() {
          return { data: {
            id: 'b1', event_id: 'e1', checked_in_at: null,
            check_in_reversed_at: '2026-01-02T00:00:00Z',
            check_in_reversal_reason: 'scanned in error',
          }, error: null };
        },
      };
    },
  };
  const evidence = await loadCurrentQrEvidence(db, {
    tenantId: 't1', bookingType: 'booking',
    booking: { id: 'b1', event_id: 'e1' }, evidenceId: 'b1',
    snapshot: { enqueuedAt: '2026-01-01T00:00:00Z', custom: 'preserved' },
  });
  assert.equal(evidence.custom, 'preserved');
  assert.equal(evidence.checkInReversedAt, '2026-01-02T00:00:00Z');
  assert.deepEqual(decideAttendanceEvidence(evidence), {
    state: 'final', qualifies: false, reason: 'checkin_reversed',
  });
});

test('a later check-in generation qualifies after an earlier reversal', () => {
  assert.equal(decideAttendanceEvidence({
    type: 'qr_checkin',
    checkedInAt: '2026-01-03T00:00:00Z',
    checkInReversedAt: '2026-01-02T00:00:00Z',
  }).qualifies, true);
  assert.equal(decideAttendanceEvidence({
    type: 'qr_checkin',
    checkedInAt: '2026-01-02T00:00:00Z',
    checkInReversedAt: '2026-01-02T00:00:00Z',
  }).qualifies, false);
});