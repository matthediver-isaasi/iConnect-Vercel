import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePaginatedOrganizations } from './paginated.js';
import {
  authenticatedTenant,
  makeFakeSupabase,
  makeResponse,
  methodArguments,
  selectedWith,
} from '../_test/paginatedFakeSupabase.mjs';

const organizations = [
  { id: 'org-1', name: 'Alpha', organization_group_id: 'group-1', is_primary: true },
  { id: 'org-2', name: 'Beta', organization_group_id: null, is_primary: false },
];

function request(query = {}) {
  return { method: 'GET', query };
}

function organizationDb({
  memberError = null,
  selectableError = null,
  preferenceError = null,
  malformedTable = null,
} = {}) {
  return makeFakeSupabase((call) => {
    if (call.table === 'organization' && selectedWith(call, 'head', true)) {
      return { data: null, count: selectableError ? null : 1, error: selectableError };
    }
    if (call.table === 'organization') {
      return { data: malformedTable === 'organization' ? null : organizations, count: 2, error: null };
    }
    if (call.table === 'member') {
      return {
        data: memberError || malformedTable === 'member' ? null : [
          { organization_id: 'org-1' },
          { organization_id: 'org-1' },
          { organization_id: 'org-2' },
        ],
        error: memberError,
      };
    }
    if (call.table === 'organization_preference_value') {
      return {
        data: preferenceError || malformedTable === 'organization_preference_value' ? null : [
          { organization_id: 'org-1', field_id: 'field-a', value: 'legacy value' },
        ],
        error: preferenceError,
      };
    }
    if (call.table === 'organization_group') {
      return {
        data: malformedTable === 'organization_group' ? null : [{ id: 'group-1', name: 'Head Office' }],
        error: null,
      };
    }
    throw new Error(`Unexpected table ${call.table}`);
  });
}

test('organization page returns identical exact total/selectable counts and complete enrichments', async () => {
  const db = organizationDb();
  const res = makeResponse();
  await handlePaginatedOrganizations(request(), res, { db, getContext: authenticatedTenant });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pagination.total, 2);
  assert.equal(res.body.pagination.selectableTotal, 1);
  assert.equal(res.body.organizations[0].member_count, 2);
  assert.equal(res.body.organizations[0].organization_group_name, 'Head Office');
  assert.deepEqual(res.body.organizations[0].custom_fields, { 'field-a': 'legacy value' });

  const mainCall = db.calls.find((call) =>
    call.table === 'organization' && !selectedWith(call, 'head', true));
  assert.deepEqual(methodArguments(mainCall, 'order').at(-1), ['id', { ascending: true }]);
});

test('empty organization fields retains legacy all-values behavior', async () => {
  const db = organizationDb();
  const res = makeResponse();
  await handlePaginatedOrganizations(request({ fields: '' }), res, {
    db,
    getContext: authenticatedTenant,
  });
  assert.deepEqual(res.body.organizations[0].custom_fields, { 'field-a': 'legacy value' });
  const prefCall = db.calls.find((call) => call.table === 'organization_preference_value');
  assert.deepEqual(methodArguments(prefCall, 'in'), [['organization_id', ['org-1', 'org-2']]]);
});

test('fields=none skips organization custom-value read but keeps counts and group names', async () => {
  const db = organizationDb();
  const res = makeResponse();
  await handlePaginatedOrganizations(request({ fields: 'none' }), res, {
    db,
    getContext: authenticatedTenant,
  });

  assert.equal(res.statusCode, 200);
  assert.ok(!db.calls.some((call) => call.table === 'organization_preference_value'));
  assert.equal(res.body.organizations[0].member_count, 2);
  assert.equal(res.body.organizations[0].organization_group_name, 'Head Office');
  assert.deepEqual(res.body.organizations[0].custom_fields, {});
});

test('explicit organization fields are deduplicated and bound at the database', async () => {
  const db = organizationDb();
  await handlePaginatedOrganizations(request({ fields: 'field-a,field-b,field-a' }), makeResponse(), {
    db,
    getContext: authenticatedTenant,
  });
  const prefCall = db.calls.find((call) => call.table === 'organization_preference_value');
  assert.deepEqual(methodArguments(prefCall, 'in'), [
    ['organization_id', ['org-1', 'org-2']],
    ['field_id', ['field-a', 'field-b']],
  ]);
});

test('organization member/selectable/preference read errors cannot become successful zero values', async () => {
  for (const config of [
    { memberError: { message: 'member count failed' } },
    { selectableError: { message: 'selectable failed' } },
    { preferenceError: { message: 'preference failed' } },
  ]) {
    const res = makeResponse();
    await handlePaginatedOrganizations(request(), res, {
      db: organizationDb(config),
      getContext: authenticatedTenant,
    });
    assert.equal(res.statusCode, 500);
    assert.notEqual(res.body?.pagination?.selectableTotal, 0);
  }
});

test('organization saved views may request more than 100 preference fields without truncation', async () => {
  const db = organizationDb();
  const res = makeResponse();
  const fieldIds = Array.from({ length: 101 }, (_, index) => `field-${index}`);
  await handlePaginatedOrganizations(request({
    fields: fieldIds.join(','),
  }), res, { db, getContext: authenticatedTenant });
  assert.equal(res.statusCode, 200);
  const prefCall = db.calls.find((call) => call.table === 'organization_preference_value');
  assert.deepEqual(methodArguments(prefCall, 'in').at(-1), ['field_id', fieldIds]);
});

test('malformed organization enrichment row payloads fail rather than becoming empty authoritative data', async () => {
  for (const malformedTable of [
    'organization',
    'member',
    'organization_preference_value',
    'organization_group',
  ]) {
    const res = makeResponse();
    await handlePaginatedOrganizations(request(), res, {
      db: organizationDb({ malformedTable }),
      getContext: authenticatedTenant,
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body?.organizations, undefined);
  }
});