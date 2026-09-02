import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../admin/gocardless-dd.js', import.meta.url),
  'utf8',
);

function caseBody(action, nextAction) {
  const start = source.indexOf(`case '${action}':`);
  const end = source.indexOf(`case '${nextAction}':`, start + 1);
  assert.notEqual(start, -1, `${action} route exists`);
  assert.notEqual(end, -1, `${nextAction} route follows ${action}`);
  return source.slice(start, end);
}

test('extend_grace restores automatic role restrictions before clearing policy state', () => {
  const body = caseBody('extend_grace', 'manual_resolve');
  const restore = body.indexOf('restoreArrearsRoleAssignments');
  const clearPolicy = body.indexOf('arrears_policy_applied: null');
  assert.ok(restore >= 0, 'extend_grace invokes audited role restoration');
  assert.ok(restore < clearPolicy, 'role restoration happens before policy bookkeeping is cleared');
  assert.match(body, /roleRecovery/);
});

test('manual_resolve restores automatic roles before plan recovery and email delivery', () => {
  const body = caseBody('manual_resolve', 'remind');
  const restore = body.indexOf('restoreArrearsRoleAssignments');
  const transition = body.indexOf('applyStatusTransition');
  const email = body.indexOf("sendDdLifecycleEmail('payment_recovered'");
  assert.ok(restore >= 0, 'manual_resolve invokes audited role restoration');
  assert.ok(restore < transition, 'role restoration happens before arrears state is cleared');
  assert.ok(restore < email, 'role restoration happens before the recovery email');
  assert.match(body, /roleRecovery/);
});