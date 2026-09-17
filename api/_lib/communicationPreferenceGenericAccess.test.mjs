import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { authorizeGenericCommunicationPreferenceAccess, validateGenericCommunicationPreferenceFilter } from './communicationPreferenceGenericAccess.js';

const memberId = '613c7958-d70a-430f-abfd-c3d3a4e143ad';

test('generic preference filter rejects slugs in all supported UUID filter shapes', () => {
  for (const member_id of [
    'committee', '', 'undefined', null, 123,
    [memberId, 'committee'], { eq: 'committee' }, { neq: 'committee' },
    { in: [memberId, 'committee'] }, { in: 'committee' },
    { eq: memberId, gt: 'committee' }, { like: '%committee%' },
    { is: 'committee' }, {},
  ]) {
    for (const filter of [{ member_id }, JSON.stringify({ member_id })]) {
      assert.equal(validateGenericCommunicationPreferenceFilter('MemberCommunicationPreference', filter)?.status, 400);
    }
  }
});

test('valid member preference filters are preserved, including lists and null checks', () => {
  for (const member_id of [
    memberId, memberId.toUpperCase(), [memberId], [],
    { eq: memberId }, { neq: memberId }, { in: [memberId] },
    { is: null }, { gte: memberId, lte: memberId },
  ]) {
    const filter = { member_id };
    const before = JSON.stringify(filter);
    assert.equal(validateGenericCommunicationPreferenceFilter('member-communication-preference', filter), null);
    assert.equal(JSON.stringify(filter), before);
  }
  for (const filter of [undefined, null, {}, '{}']) {
    assert.equal(validateGenericCommunicationPreferenceFilter('MemberCommunicationPreference', filter), null);
  }
});

test('malformed preference filter JSON is rejected, not broadened into an unfiltered read', () => {
  for (const filter of ['{', 'null', '[]', '"committee"']) {
    assert.equal(validateGenericCommunicationPreferenceFilter('MemberCommunicationPreference', filter)?.status, 400);
  }
  assert.equal(validateGenericCommunicationPreferenceFilter('OtherEntity', { member_id: 'committee' }), null);
});

test('collection validates preference filters before constructing the list query', async () => {
  const source = await readFile(new URL('../entities/[entity]/index.js', import.meta.url), 'utf8');
  const getBlock = source.slice(source.indexOf("if (req.method === 'GET')"));
  const validationAt = getBlock.indexOf('const preferenceFilterError = validateGenericCommunicationPreferenceFilter(');
  const rejectAt = getBlock.indexOf('return res.status(preferenceFilterError.status)');
  const queryAt = getBlock.indexOf('let query = supabase');
  assert.ok(validationAt >= 0 && rejectAt > validationAt && queryAt > rejectAt);
  assert.match(getBlock, /entity, tenantCtx\.parsedFilter \|\| filter/);
});

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

test('generic entity API rejects direct member preference writes even for administrators', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const result = await authorizeGenericCommunicationPreferenceAccess(
      'MemberCommunicationPreference',
      { isAuthenticated: true, tenantId: 'tenant-1' },
      { hasAdminAccess: async () => true },
      method,
    );
    assert.deepEqual(result, {
      status: 405,
      error: 'Communication preference writes must use the guarded preferences API',
    });
  }
});

test('generic entity collection and record routes apply the admin-only boundary', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const relativePath of ['entities/[entity]/index.js', 'entities/[entity]/[id].js']) {
    const source = await readFile(path.join(root, relativePath), 'utf8');
    assert.match(source, /authorizeGenericCommunicationPreferenceAccess\(/, relativePath);
    assert.match(source, /\{\s*hasAdminAccess\s*\},\s*req\.method,\s*\)/, relativePath);
    assert.match(source, /genericPreferenceAccessError\.status/, relativePath);
  }
});