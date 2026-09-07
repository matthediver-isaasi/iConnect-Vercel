import test from 'node:test';
import assert from 'node:assert/strict';

import { filterCountableEvents } from './eventAttendeeCountAccess.js';

const tenantId = 'tenant-1';
const rows = [
  { id: 'ordinary', tenant_id: tenantId, member_group_id: null },
  { id: 'public-group', tenant_id: tenantId, member_group_id: 'group-public', group_event_public: true },
  { id: 'member-group', tenant_id: tenantId, member_group_id: 'group-member', group_event_public: false },
  { id: 'admin-group', tenant_id: tenantId, member_group_id: 'group-admin', group_event_public: false },
  { id: 'hidden-group', tenant_id: tenantId, member_group_id: 'group-hidden', group_event_public: false },
  { id: 'other-tenant', tenant_id: 'tenant-2', member_group_id: null },
];

test('global attendee access does not expose private groups the member cannot view', () => {
  assert.deepEqual(
    filterCountableEvents({
      rows,
      tenantId,
      hasGlobalAttendeeAccess: true,
      memberGroupIds: new Set(['group-member']),
    }).map((row) => row.id),
    ['ordinary', 'public-group', 'member-group'],
  );
});

test('group admins can count their own group events without global attendee access', () => {
  assert.deepEqual(
    filterCountableEvents({
      rows,
      tenantId,
      administeredGroupIds: new Set(['group-admin']),
    }).map((row) => row.id),
    ['admin-group'],
  );
});

test('tenant admins can count every same-tenant event only', () => {
  assert.deepEqual(
    filterCountableEvents({ rows, tenantId, isTenantAdmin: true }).map((row) => row.id),
    ['ordinary', 'public-group', 'member-group', 'admin-group', 'hidden-group'],
  );
});