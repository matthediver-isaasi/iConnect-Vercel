import test from 'node:test';
import assert from 'node:assert/strict';
import {
  opportunityPermissions, validateStageChange, assertExpectedVersion,
  assertPrivateDocumentPath, parsePagination, validatePriority,
} from './opportunityRules.js';

test('owner and collaborator access is explicit and manage remains owner-only', () => {
  const opportunity = { owner_kind: 'member', owner_id: 'owner' };
  const collaborators = [{ principal_kind: 'member', principal_id: 'collab' }];
  assert.deepEqual(opportunityPermissions(opportunity, { kind: 'member', id: 'owner' }, collaborators),
    { canView: true, canEdit: true, canManage: true });
  assert.deepEqual(opportunityPermissions(opportunity, { kind: 'member', id: 'collab' }, collaborators),
    { canView: true, canEdit: true, canManage: false });
  assert.equal(opportunityPermissions(opportunity, { kind: 'member', id: 'other' }, collaborators).canView, false);
  assert.equal(opportunityPermissions(opportunity, { kind: 'member', id: 'other' }, [], true).canManage, true);
});

test('lost stage requires a reason and non-lost rejects one', () => {
  assert.throws(() => validateStageChange({ is_active: true, is_lost: true }, null), /loss reason/i);
  assert.throws(() => validateStageChange({ is_active: true, is_lost: false }, 'reason'), /only valid/i);
  assert.deepEqual(validateStageChange({ is_active: true, is_lost: true }, 'reason'), { lossReasonId: 'reason' });
});

test('optimistic conflict and pagination are deterministic', () => {
  assert.throws(() => assertExpectedVersion({ version: 3 }, 2), (error) => error.status === 409 && error.code === 'STALE_UPDATE');
  assert.doesNotThrow(() => assertExpectedVersion({ version: 3 }, 3));
  assert.deepEqual(parsePagination({ page: '2', pageSize: '10' }), { page: 2, pageSize: 10, from: 10, to: 19 });
  assert.deepEqual(parsePagination({ limit: '12' }), { page: 1, pageSize: 12, from: 0, to: 11 });
});

test('documents are restricted to private opportunity prefix', () => {
  assert.doesNotThrow(() => assertPrivateDocumentPath('tenant', 'opp', 'private-uploads', 'tenant/opportunities/opp/file.pdf'));
  assert.throws(() => assertPrivateDocumentPath('tenant', 'opp', 'public-assets', 'tenant/opportunities/opp/file.pdf'));
  assert.throws(() => assertPrivateDocumentPath('tenant', 'opp', 'private-uploads', 'tenant/opportunities/other/file.pdf'));
});

test('priority uses the supported pipeline values', () => {
  assert.equal(validatePriority('urgent'), 'urgent');
  assert.throws(() => validatePriority('later'), /priority/i);
});