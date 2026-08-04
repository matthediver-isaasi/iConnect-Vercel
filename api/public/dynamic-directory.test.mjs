import test from 'node:test';
import assert from 'node:assert/strict';

import { PUBLIC_DIRECTORY_SELECT, buildPublicDirectoryPayload } from './dynamic-directory.js';
import { resolveBackFieldOrder, MEMBER_BACK_DEFAULT_ORDER } from '../_lib/directoryConfig.js';

test('public directory select fetches the back-order override columns', () => {
  assert.ok(PUBLIC_DIRECTORY_SELECT.includes('back_field_order'));
  assert.ok(PUBLIC_DIRECTORY_SELECT.includes('show_members_on_card_back'));
});

test('public payload exposes a saved back_field_order override', () => {
  const payload = buildPublicDirectoryPayload({
    id: 'd1', slug: 'devs', name: 'Devs', entity_type: 'member',
    back_field_order: ['show_awards', 'custom:f1', 'show_organization'],
    show_members_on_card_back: false,
  });
  assert.deepEqual(payload.back_field_order, ['show_awards', 'custom:f1', 'show_organization']);
  assert.equal(payload.show_members_on_card_back, false);

  // A public consumer resolving with this override gets the override-first order.
  const resolved = resolveBackFieldOrder({
    directoryOrder: payload.back_field_order,
    tenantOrder: ['show_organization', 'show_awards'],
    defaultOrder: MEMBER_BACK_DEFAULT_ORDER,
    customFields: [{ id: 'f1' }],
  });
  assert.deepEqual(resolved.slice(0, 3), ['show_awards', 'custom:f1', 'show_organization']);
});

test('public payload defaults: no override, members list shown', () => {
  const payload = buildPublicDirectoryPayload({ id: 'd2', slug: 'orgs', name: 'Orgs', entity_type: 'organization' });
  assert.equal(payload.back_field_order, null);
  assert.equal(payload.show_members_on_card_back, true);
  assert.equal(buildPublicDirectoryPayload(null), null);
});
