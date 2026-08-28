import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrefillValues } from './formFieldPrefill.js';

const form = {
  fields: [{ id: 'group', type: 'organisation_group_dropdown' }],
};

test('member prefill prefers a direct organisation-group assignment', () => {
  assert.deepEqual(buildPrefillValues({
    form: { ...form, prefill_source: 'member' },
    memberEntity: { organization_group_id: 'direct-group' },
    orgEntity: { organization_group_id: 'parent-group' },
  }), { group: 'direct-group' });
});

test('organisation and booking-compatible prefill use the linked organisation parent group', () => {
  assert.deepEqual(buildPrefillValues({
    form: { ...form, prefill_source: 'organization' },
    orgEntity: { organization_group_id: 'parent-group' },
  }), { group: 'parent-group' });
  assert.deepEqual(buildPrefillValues({
    form: { ...form, prefill_source: 'booking' },
    prefillOrganizationGroupId: 'booking-group',
  }), { group: 'booking-group' });
});