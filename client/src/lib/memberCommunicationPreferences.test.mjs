import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const adminSurfaces = [
  'client/src/pages/MemberDetail.jsx',
  'client/src/components/MemberDetailView.jsx',
  'client/src/pages/AdminMemberEdit.jsx',
];

test('every admin member preference surface uses the member-scoped authoritative endpoint', async () => {
  for (const file of adminSurfaces) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /fetchAdminMemberCommunicationPreferences/);
    assert.match(source, /admin-member-communication-preferences/);
    assert.doesNotMatch(source, /CommunicationCategoryRole/);
    assert.doesNotMatch(source, /\.from\(["']member_communication_preference["']\)/);
  }
});

test('About me uses the signed-in member response and member-scoped cache key', async () => {
  const source = await readFile('client/src/pages/Preferences.jsx', 'utf8');
  assert.match(source, /fetch\('\/api\/member\/communication-preferences'/);
  assert.match(source, /queryKey: \["my-communication-preferences", memberRecord\?\.id\]/);
  assert.match(source, /communicationPreferenceData\?\.optedOutAll/);
  assert.doesNotMatch(source, /CommunicationCategoryRole/);
});