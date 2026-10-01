import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFormGroupInitialSelection } from './formGroupInitialSelection.js';
import { validateFormOrganisationGroupAnswers } from './formOrganisationGroups.js';

const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const GROUP_ID = 'c8e4f12f-6ac3-4be7-9222-1f20bf0e4f8a';
const OTHER_GROUP_ID = '437be10c-ad04-4a99-8ae7-40af8f18cf6b';
const FOREIGN_GROUP_ID = 'e37d7cdd-ec31-4bcd-82f1-520fcb00249f';

function database({ groups = [
  { id: GROUP_ID, tenant_id: TENANT_ID, name: 'Group' },
  { id: OTHER_GROUP_ID, tenant_id: TENANT_ID, name: 'Other' },
  { id: FOREIGN_GROUP_ID, tenant_id: 'other-tenant', name: 'Foreign' },
], error = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, 'organization_group');
      const call = { filters: [] };
      calls.push(call);
      let ids;
      let tenantId;
      const query = {
        select() { return query; },
        eq(column, value) {
          assert.equal(column, 'tenant_id');
          tenantId = value;
          call.filters.push(['eq', column, value]);
          return query;
        },
        in(column, values) {
          assert.equal(column, 'id');
          ids = values;
          call.filters.push(['in', column, values]);
          return query;
        },
        async order() {
          return {
            error,
            data: error ? null : groups.filter(group => group.tenant_id === tenantId
              && (!ids || ids.includes(group.id))),
          };
        },
      };
      return query;
    },
  };
}

function field(config, extra = {}) {
  return {
    id: 'group',
    type: 'organisation_group_dropdown',
    ...(config === undefined ? {} : { group_initial_selection: config }),
    ...extra,
  };
}

const validate = (fields, db = database()) => validateFormGroupInitialSelection({
  db, tenantId: TENANT_ID, form: { fields },
});

test('legacy absent configuration and none/url modes remain valid without a group lookup', async () => {
  const db = database();
  assert.deepEqual(await validate([
    field(), field({ mode: 'none' }), field({ mode: 'url' }),
  ], db), { ok: true });
  assert.deepEqual(db.calls, []);
  assert.deepEqual(await validateFormGroupInitialSelection({ form: {} }), { ok: true });
});

test('specific mode validates tenant ownership in one deduplicated read without changing the form', async () => {
  const db = database();
  const fields = [
    field({ mode: 'specific', group_id: GROUP_ID }),
    field({ mode: 'specific', group_id: GROUP_ID.toUpperCase() }),
    field({ mode: 'specific', group_id: OTHER_GROUP_ID }),
  ];
  const snapshot = structuredClone(fields);
  assert.deepEqual(await validate(fields, db), { ok: true });
  assert.deepEqual(fields, snapshot);
  assert.deepEqual(db.calls, [{ filters: [
    ['eq', 'tenant_id', TENANT_ID],
    ['in', 'id', [GROUP_ID, OTHER_GROUP_ID]],
  ] }]);
});

test('malformed configuration, unsupported modes, and non-specific IDs are rejected before lookup', async (t) => {
  for (const config of [
    null, false, 'specific', [], {},
    { mode: 'unknown' }, { mode: 'URL' }, { mode: 1 },
    { mode: 'specific' }, { mode: 'specific', group_id: null },
    { mode: 'specific', group_id: '' }, { mode: 'specific', group_id: 'not-a-uuid' },
    { mode: 'specific', group_id: [GROUP_ID] },
    { mode: 'specific', group_id: ` ${GROUP_ID}` },
    { mode: 'none', group_id: GROUP_ID },
    { mode: 'url', group_id: GROUP_ID },
    { mode: 'url', parameter: 'custom_group' },
    { mode: 'url', url_parameter: 'group_id' },
    { mode: 'specific', group_id: GROUP_ID, extra: true },
  ]) {
    await t.test(JSON.stringify(config), async () => {
      const db = database();
      const result = await validate([field(config)], db);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'INVALID_GROUP_INITIAL_SELECTION');
      assert.match(result.error, /fields\[0\]\.group_initial_selection/);
      assert.ok(result.details.length);
      assert.deepEqual(db.calls, []);
    });
  }
});

test('initial selection configuration is rejected on other field types', async () => {
  const result = await validate([field({ mode: 'url' }, { type: 'organisation_dropdown' })]);
  assert.equal(result.ok, false);
  assert.match(result.error, /only supported on organisation group dropdown/);
});

test('specific mode rejects foreign, deleted, and unavailable groups', async (t) => {
  for (const id of [FOREIGN_GROUP_ID, '11111111-1111-4111-8111-111111111111']) {
    await t.test(id, async () => {
      const result = await validate([field({ mode: 'specific', group_id: id })]);
      assert.equal(result.ok, false);
      assert.match(result.error, /must reference an organisation group in this tenant/);
    });
  }
  assert.equal((await validate(
    [field({ mode: 'specific', group_id: GROUP_ID })], database({ groups: [] }),
  )).ok, false);
});

test('repeatable row aliases and child storage shapes receive the same validation', async (t) => {
  for (const type of ['repeatable_row', 'repeatable_rows', 'repeatable_grid']) {
    for (const key of ['children', 'child_fields', 'fields']) {
      for (const nested of [false, true]) {
        await t.test(`${type}/${key}/${nested ? 'config' : 'flat'}`, async () => {
          const container = config => ({
            id: 'rows',
            type,
            ...(nested ? { repeatable_row: { [key]: [field(config)] } }
              : { [key]: [field(config)] }),
          });
          assert.equal((await validate([container({
            mode: 'specific', group_id: GROUP_ID,
          })])).ok, true);
          assert.equal((await validate([container({
            mode: 'specific', group_id: FOREIGN_GROUP_ID,
          })])).ok, false);
          const result = await validate([container({ mode: 'unsupported' })]);
          assert.equal(result.ok, false);
          assert.match(result.error, /fields\[0\]\.children\[0\]/);
        });
      }
    }
  }
});

test('lookup failures and missing tenant context fail closed with explicit errors', async () => {
  await assert.rejects(validate(
    [field({ mode: 'specific', group_id: GROUP_ID })],
    database({ error: { message: 'group lookup unavailable' } }),
  ), /Failed to validate initial organisation group selections: group lookup unavailable/);
  await assert.rejects(validateFormGroupInitialSelection({
    db: database(), form: { fields: [field({ mode: 'specific', group_id: GROUP_ID })] },
  }), /Tenant context is required/);
});

test('initial selection modes never replace tenant and conditional answer authorization', async (t) => {
  for (const config of [
    undefined, { mode: 'none' }, { mode: 'url' },
    { mode: 'specific', group_id: GROUP_ID },
  ]) {
    await t.test(config?.mode || 'legacy', async () => {
      const db = database();
      const fields = [field(config)];
      // A specific initial value is a hint, not a lock on the submitted answer.
      assert.equal(await validateFormOrganisationGroupAnswers({
        db, tenantId: TENANT_ID, fields, submissionData: { group: OTHER_GROUP_ID },
      }), true);
      await assert.rejects(validateFormOrganisationGroupAnswers({
        db, tenantId: TENANT_ID, fields, submissionData: { group: FOREIGN_GROUP_ID },
      }), error => error.code === 'INVALID_ORGANISATION_GROUP');
      fields.unshift({ id: 'region', type: 'select', options: ['Northern'] });
      fields[1].conditional_filters = {
        version: 1,
        rules: [{
          id: 'north-rule', source_field_id: 'region', operator: 'equals',
          value: 'Northern', is_fallback: false, allowed_values: [GROUP_ID],
        }],
      };
      await assert.rejects(validateFormOrganisationGroupAnswers({
        db, tenantId: TENANT_ID, fields,
        submissionData: { region: 'Northern', group: OTHER_GROUP_ID },
      }), error => error.code === 'INVALID_ORGANISATION_GROUP');
    });
  }
});