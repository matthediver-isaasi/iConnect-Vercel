import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORGANISATION_DIRECTORY_GUEST_DEFAULTS,
  saveOrganisationDirectoryGuestSettings,
} from './organisationDirectoryGuestSettings.js';

test('persists guest introduction by updating existing rows and creating missing rows', async () => {
  const updates = [];
  const creates = [];
  const entity = {
    update: async (id, patch) => updates.push({ id, patch }),
    create: async (body) => creates.push(body),
  };

  await saveOrganisationDirectoryGuestSettings({
    entity,
    existingSettings: {
      heading: { id: 'heading-row' },
      description: null,
      joinAction: { id: 'action-row' },
    },
    heading: '  Explore the Nuclear Medicine Department Directory  ',
    description: '  Find departments and their contact details.  ',
    joinActionId: 'nav-join',
  });

  assert.deepEqual(updates, [
    {
      id: 'heading-row',
      patch: { setting_value: 'Explore the Nuclear Medicine Department Directory' },
    },
    { id: 'action-row', patch: { setting_value: 'nav-join' } },
  ]);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].setting_key, 'org_directory_guest_description');
  assert.equal(creates[0].setting_value, 'Find departments and their contact details.');
});

test('persists neutral text fallbacks and an empty automatic action id', async () => {
  const creates = [];
  const entity = {
    update: async () => assert.fail('no existing rows should be updated'),
    create: async (body) => creates.push(body),
  };

  await saveOrganisationDirectoryGuestSettings({
    entity,
    existingSettings: { heading: null, description: null, joinAction: null },
    heading: ' ',
    description: '',
    joinActionId: '',
  });

  assert.deepEqual(
    creates.map(({ setting_key, setting_value }) => [setting_key, setting_value]),
    [
      ['org_directory_guest_heading', ORGANISATION_DIRECTORY_GUEST_DEFAULTS.heading],
      ['org_directory_guest_description', ORGANISATION_DIRECTORY_GUEST_DEFAULTS.description],
      ['org_directory_guest_join_action_id', ''],
    ]
  );
});