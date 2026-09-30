import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasPersistedFormEntityActions,
  hasPersistedLegacyFormEntityActions,
  resolveFormEntityActions,
} from './formEntityActionMode.js';

test('legacy-only forms retain configured member and organisation actions', () => {
  assert.deepEqual(resolveFormEntityActions({
    entityPipelines: null,
    memberEntityAction: 'update',
    organizationEntityAction: 'create',
  }), { memberAction: 'update', organizationAction: 'create' });
});

test('an explicitly saved modern empty pipeline remains authoritative', () => {
  assert.deepEqual(resolveFormEntityActions({
    entityPipelines: { members: [], organisations: [] },
    memberEntityAction: 'update',
    organizationEntityAction: 'create',
  }), { memberAction: 'none', organizationAction: 'none' });
});

test('old single-entity configuration still falls back when independent actions are absent', () => {
  assert.deepEqual(resolveFormEntityActions({
    entityPipelines: undefined,
    createEntityType: 'both',
    entityAction: 'update',
  }), { memberAction: 'update', organizationAction: 'update' });
});

test('shared action detection includes legacy-only paid/retry forms', () => {
  assert.equal(hasPersistedFormEntityActions({
    entity_pipelines: null,
    member_entity_action: 'create',
  }), true);
  assert.equal(hasPersistedFormEntityActions({
    entity_pipelines: null,
    create_entity_type: 'organization',
    entity_action: 'update',
  }), true);
  assert.equal(hasPersistedFormEntityActions({
    entity_pipelines: { members: [], organisations: [] },
    member_entity_action: 'create',
  }), false);
});

test('unconfigured forms never infer processing intent from legacy resolver defaults', () => {
  for (const form of [
    {},
    { entity_pipelines: null },
    { entity_pipelines: null, create_entity_type: 'member' },
    { entity_pipelines: null, entity_action: 'create' },
    { structured_actions: { version: 1, actions: [] } },
  ]) {
    assert.equal(hasPersistedFormEntityActions(form), false);
    assert.equal(hasPersistedLegacyFormEntityActions(form), false);
  }
  assert.equal(hasPersistedFormEntityActions({
    structured_actions: { version: 1, actions: [{ id: 'structured' }] },
  }), true);
  assert.equal(hasPersistedLegacyFormEntityActions({
    structured_actions: { version: 1, actions: [{ id: 'structured' }] },
  }), false);
});