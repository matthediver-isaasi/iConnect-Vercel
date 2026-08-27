import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { authorizeGenericCommunicationPreferenceAccess } from './communicationPreferenceGenericAccess.js';

test('generic communication preference access rejects unauthenticated callers', async () => {
  const result = await authorizeGenericCommunicationPreferenceAccess(
    'MemberCommunicationPreference',
    { isAuthenticated: false },
    { hasAdminAccess: async () => false },
  );
  assert.deepEqual(result, { status: 401, error: 'Authentication required' });
});

test('generic communication preference access rejects ordinary members', async () => {
  for (const entity of [
    'CommunicationCategory',
    'communication-category-role',
    'member-communication-preference',
  ]) {
    const result = await authorizeGenericCommunicationPreferenceAccess(
      entity,
      { isAuthenticated: true, memberId: 'member-1' },
      { hasAdminAccess: async () => false },
    );
    assert.deepEqual(result, { status: 403, error: 'Admin access required' }, entity);
  }
});

test('generic communication preference access permits administrators', async () => {
  for (const entity of [
    'CommunicationCategory',
    'CommunicationCategoryRole',
    'MemberCommunicationPreference',
  ]) {
    const result = await authorizeGenericCommunicationPreferenceAccess(
      entity,
      { isAuthenticated: true, tenantId: 'tenant-1' },
      { hasAdminAccess: async () => true },
    );
    assert.equal(result, null, entity);
  }
});

test('generic entity collection and record routes apply the admin-only boundary', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const relativePath of ['entities/[entity]/index.js', 'entities/[entity]/[id].js']) {
    const source = await readFile(path.join(root, relativePath), 'utf8');
    assert.match(source, /authorizeGenericCommunicationPreferenceAccess\(/, relativePath);
    assert.match(source, /\{\s*hasAdminAccess\s*\},\s*\)/, relativePath);
    assert.match(source, /genericPreferenceAccessError\.status/, relativePath);
  }
});