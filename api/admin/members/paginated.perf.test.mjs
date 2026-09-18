import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePaginatedMembers } from './paginated.js';
import {
  authenticatedTenant,
  makeFakeSupabase,
  makeResponse,
  methodArguments,
} from '../_test/paginatedFakeSupabase.mjs';

const member = {
  id: 'member-1',
  first_name: 'Ada',
  last_name: 'Member',
  email: 'ada@example.test',
  login_enabled: true,
  profile_photo_url: null,
};

function request(query = {}) {
  return { method: 'GET', query };
}

function memberDb({ preferenceError = null, malformedTable = null } = {}) {
  return makeFakeSupabase((call) => {
    if (call.table === 'member') {
      return { data: malformedTable === 'member' ? null : [member], count: 1, error: null };
    }
    if (call.table === 'member_preference_value') {
      return {
        data: preferenceError || malformedTable === 'member_preference_value' ? null : [
          { member_id: member.id, field_id: 'field-a', value: 'legacy value' },
          { member_id: member.id, field_id: 'field-b', value: false },
        ],
        error: preferenceError,
      };
    }
    throw new Error(`Unexpected table ${call.table}`);
  });
}

const enrichDepartments = async (_db, _tenantId, rows) => rows.map((row) => ({
  ...row,
  departments: [{ id: 'department-1', name: 'Membership' }],
}));

test('fields=none skips member custom-value reads while retaining department enrichment', async () => {
  const db = memberDb();
  const res = makeResponse();
  await handlePaginatedMembers(request({ fields: 'none' }), res, {
    db,
    getContext: authenticatedTenant,
    enrichDepartments,
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.members[0].custom_fields, {});
  assert.equal(res.body.members[0].departments[0].name, 'Membership');
  assert.ok(!db.calls.some((call) => call.table === 'member_preference_value'));
  assert.equal(res.body.pagination.total, 1);
});

test('omitted member fields preserves legacy all-values behavior and explicit fields bound the query', async () => {
  for (const query of [{}, { fields: '' }]) {
    const legacyDb = memberDb();
    const legacyRes = makeResponse();
    await handlePaginatedMembers(request(query), legacyRes, {
      db: legacyDb,
      getContext: authenticatedTenant,
      enrichDepartments,
    });
    assert.deepEqual(legacyRes.body.members[0].custom_fields, {
      'field-a': 'legacy value',
      'field-b': false,
    });
    const legacyPrefCall = legacyDb.calls.find((call) => call.table === 'member_preference_value');
    assert.deepEqual(methodArguments(legacyPrefCall, 'in'), [['member_id', ['member-1']]]);
  }

  const boundedDb = memberDb();
  await handlePaginatedMembers(request({ fields: 'field-a,field-b,field-a' }), makeResponse(), {
    db: boundedDb,
    getContext: authenticatedTenant,
    enrichDepartments,
  });
  const boundedPrefCall = boundedDb.calls.find((call) => call.table === 'member_preference_value');
  assert.deepEqual(methodArguments(boundedPrefCall, 'in'), [
    ['member_id', ['member-1']],
    ['field_id', ['field-a', 'field-b']],
  ]);
});

test('member preference read errors fail explicitly instead of returning empty authoritative values', async () => {
  const res = makeResponse();
  await handlePaginatedMembers(request(), res, {
    db: memberDb({ preferenceError: { message: 'read failed' } }),
    getContext: authenticatedTenant,
    enrichDepartments,
  });
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /preference values/i);
});

test('member saved views may request more than 100 preference fields without truncation', async () => {
  const db = memberDb();
  const res = makeResponse();
  const fieldIds = Array.from({ length: 101 }, (_, index) => `field-${index}`);
  await handlePaginatedMembers(request({
    fields: fieldIds.join(','),
  }), res, {
    db,
    getContext: authenticatedTenant,
    enrichDepartments,
  });
  assert.equal(res.statusCode, 200);
  const prefCall = db.calls.find((call) => call.table === 'member_preference_value');
  assert.deepEqual(methodArguments(prefCall, 'in').at(-1), ['field_id', fieldIds]);
});

test('malformed member and preference row payloads fail rather than becoming empty results', async () => {
  for (const malformedTable of ['member', 'member_preference_value']) {
    const res = makeResponse();
    await handlePaginatedMembers(request(), res, {
      db: memberDb({ malformedTable }),
      getContext: authenticatedTenant,
      enrichDepartments,
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body?.members, undefined);
  }
});