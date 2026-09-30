import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasResolvedWorkflows,
  isRevertWorkflow,
  buildSkipAllPayload,
} from './workflowRevertGate.mjs';

const unmetRevert = (id, extra = {}) => ({
  workflow_id: id,
  conditions_met: false,
  revert_on_fail: true,
  revert_field_id: 'status',
  ...extra,
});

test('no workflow resolved yet -> dismiss-without-revert stays locked (single unmet workflow keeps current behavior)', () => {
  assert.equal(hasResolvedWorkflows([]), false);
  assert.equal(hasResolvedWorkflows(undefined), false);
});

test('a SKIPPED workflow unlocks the no-revert dismiss, same as a confirmed one', () => {
  assert.equal(hasResolvedWorkflows([{ id: 'a', action: 'skipped' }]), true);
  assert.equal(hasResolvedWorkflows([{ id: 'a', action: 'confirmed' }]), true);
});

test('isRevertWorkflow requires unmet conditions + revert_on_fail + revert_field_id', () => {
  assert.equal(isRevertWorkflow(unmetRevert('w1')), true);
  assert.equal(isRevertWorkflow({ conditions_met: true, revert_on_fail: true, revert_field_id: 'x' }), false);
  assert.equal(isRevertWorkflow(unmetRevert('w1', { revert_on_fail: false })), false);
  assert.equal(isRevertWorkflow(unmetRevert('w1', { revert_field_id: undefined })), false);
});

test('Skip All after a skip strips revert_on_fail from unmet workflows (no revert POST)', () => {
  const unmet = unmetRevert('w2');
  const met = { workflow_id: 'w3', conditions_met: true };
  const payload = buildSkipAllPayload([unmet, met], true);
  assert.equal(payload[0].revert_on_fail, false);
  assert.equal(isRevertWorkflow(payload[0]), false);
  assert.equal(payload[1], met);
  // original object untouched
  assert.equal(unmet.revert_on_fail, true);
});

test('Skip All with nothing resolved keeps revert behavior unchanged', () => {
  const unmet = unmetRevert('w2');
  const payload = buildSkipAllPayload([unmet], false);
  assert.equal(payload[0], unmet);
  assert.equal(isRevertWorkflow(payload[0]), true);
});
