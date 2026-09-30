import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attendanceTriggerMatches,
  attendanceWorkflowDeliveryKey,
  buildChainedWorkflowContext,
  evaluateConditionOperator,
  isAttendanceConditionField,
  normalizeAttendanceResultTransition,
} from './workflows.js';

const transition = {
  id: 'transition-1',
  tenant_id: 'tenant-1',
  attendance_target_id: 'target-1',
  outcome_revision_id: 'revision-2',
  revision_number: 2,
  booking_id: 'booking-1',
  booking_type: 'event_booking',
  member_id: 'member-1',
  provider: 'zoom',
  status: 'attended',
  duration_seconds: 3720,
  threshold_minutes: 45,
  event_id: 'event-1',
  target_type: 'agenda_item',
  target_id: 'agenda-1',
  metadata: { forged_condition: 'must not leak' },
};

test('normalizes the durable attendance transition into an allowlisted context', () => {
  const result = normalizeAttendanceResultTransition(transition);
  assert.equal(result.transitionId, 'transition-1');
  assert.equal(result.outcome, 'attended');
  assert.equal(result.conditionContext.attendance_duration_minutes, 62);
  assert.equal(result.conditionContext.attendance_revision_number, 2);
  assert.equal(result.conditionContext.attendance_target_record_id, 'agenda-1');
  assert.equal(result.conditionContext.forged_condition, undefined);
  assert.equal(result.conditionContext.metadata, undefined);
});

test('rejects pending, errored and unmatched results', () => {
  for (const status of ['pending', 'error', 'unmatched']) {
    assert.throws(
      () => normalizeAttendanceResultTransition({ ...transition, status }),
      /non-final outcome/,
    );
  }
});

test('requires durable transition, revision, target and booking identities', () => {
  for (const field of ['id', 'outcome_revision_id', 'attendance_target_id', 'booking_id']) {
    const invalid = { ...transition };
    delete invalid[field];
    assert.throws(() => normalizeAttendanceResultTransition(invalid), /required/);
  }
});

test('matches outcome arrays and optional target scope', () => {
  const context = normalizeAttendanceResultTransition(transition).conditionContext;
  assert.equal(attendanceTriggerMatches({ outcomes: ['attended', 'absent'] }, context), true);
  assert.equal(attendanceTriggerMatches({ outcome: 'absent' }, context), false);
  assert.equal(attendanceTriggerMatches({
    status: 'attended',
    provider: 'zoom',
    event_id: 'event-1',
    target_type: 'agenda_item',
    target_id: 'agenda-1',
  }, context), true);
  assert.equal(attendanceTriggerMatches({ attendance_target_id: 'other' }, context), false);
});

test('accepts the immutable outbox payload contract', () => {
  const result = normalizeAttendanceResultTransition({
    tenant_id: 'tenant-1',
    transition_id: 'transition-3',
    payload: {
      transitionId: 'transition-3',
      event: { id: 'event-1' },
      target: {
        type: 'complex_event_session',
        id: 'session-1',
        attendance_target_id: 'target-1',
      },
      booking: { type: 'complex_event_booking', id: 'booking-1' },
      member: { id: 'member-1' },
      ticket: { id: 'ticket-1' },
      provider: 'teams',
      durationSeconds: 1800,
      thresholdMinutes: 20,
      status: 'attended',
      revision: 3,
      revisionId: 'revision-3',
    },
  });
  assert.equal(result.conditionContext.target_id, 'session-1');
  assert.equal(result.conditionContext.attendance_target_id, 'target-1');
  assert.equal(result.conditionContext.attendance_revision_number, 3);
  assert.equal(result.conditionContext.ticket_id, 'ticket-1');
});

test('evaluates numeric attendance duration and threshold conditions', () => {
  assert.equal(evaluateConditionOperator('greater_than', 3600, '1800'), true);
  assert.equal(evaluateConditionOperator('greater_than_or_equal', 45, '45'), true);
  assert.equal(evaluateConditionOperator('less_than', 20, '45'), true);
  assert.equal(evaluateConditionOperator('less_than_or_equal', 45, '45'), true);
  assert.equal(evaluateConditionOperator('greater_than', '', '45'), false);
  assert.equal(evaluateConditionOperator('less_than', 'not-a-number', '45'), false);
});

test('attendance and member status fields do not collide', () => {
  assert.equal(isAttendanceConditionField('attendance', 'status'), true);
  assert.equal(isAttendanceConditionField('member_core', 'status'), false);
  assert.equal(isAttendanceConditionField('core', 'status'), false);
});

test('downstream field-change workflows do not inherit attendance delivery claims', () => {
  const chained = buildChainedWorkflowContext({
    deliveryKey: 'attendance-result:transition-1',
    actionEntityId: 'member-1',
    attendance: { outcome: 'attended' },
    triggerData: { booking_id: 'booking-1' },
    systemInitiated: true,
    chain: { depth: 1, visited: ['workflow-1'] },
  }, {
    triggeredByWorkflow: { id: 'workflow-1' },
  });
  assert.equal(chained.deliveryKey, undefined);
  assert.equal(chained.attendance, undefined);
  assert.equal(chained.actionEntityId, undefined);
  assert.equal(chained.triggerData, undefined);
  assert.equal(chained.systemInitiated, true);
  assert.deepEqual(chained.chain, { depth: 1, visited: ['workflow-1'] });
});

test('once-per-record attendance claims are atomic across corrected transitions', () => {
  const common = {
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    entityId: 'booking-1',
    triggerMode: 'once_per_record',
  };
  const first = attendanceWorkflowDeliveryKey({
    ...common,
    transitionDeliveryKey: 'attendance-result:transition-1',
  });
  const correction = attendanceWorkflowDeliveryKey({
    ...common,
    transitionDeliveryKey: 'attendance-result:transition-2',
  });
  assert.equal(first, correction);
  assert.equal(first, 'attendance-once:tenant-1:workflow-1:booking-1');
});