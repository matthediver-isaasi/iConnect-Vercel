import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  isCorePreferenceField,
  loadCorePreferenceValueBeforeUpdate,
} from './customObjectApiBoundary.js';

const collectionRoute = await readFile(
  new URL('../entities/[entity]/index.js', import.meta.url),
  'utf8',
);
const itemRoute = await readFile(
  new URL('../entities/[entity]/[id].js', import.meta.url),
  'utf8',
);

test('generic collection route blocks Custom Object storage and field creation', () => {
  assert.match(collectionRoute, /isCustomObjectStorageEntity\(entityNorm\)/);
  assert.match(
    collectionRoute,
    /entityNorm === 'preferencefield'[\s\S]*req\.method === 'POST'[\s\S]*isCustomObjectFieldWrite\(req\.body\)/,
  );
  assert.match(
    collectionRoute,
    /entity_scope\.is\.null,entity_scope\.neq\.custom_object/,
  );
  assert.match(
    collectionRoute,
    /isCorePreferenceValueEntity\(entityNorm\)[\s\S]*filterCorePreferenceValueRows/,
  );
  assert.match(
    collectionRoute,
    /isCorePreferenceValueEntity\(entityNorm\)[\s\S]*isCorePreferenceField/,
  );
});

test('generic item route blocks storage, field conversion, and persisted object fields', () => {
  assert.match(itemRoute, /isCustomObjectStorageEntity\(entityNorm\)/);
  assert.match(
    itemRoute,
    /req\.method === 'PATCH'[\s\S]*isCustomObjectFieldWrite\(req\.body\)/,
  );
  assert.match(itemRoute, /existingField\?\.entity_scope === 'custom_object'/);
  assert.match(itemRoute, /entity_scope\.is\.null,entity_scope\.neq\.custom_object/);
  assert.match(
    itemRoute,
    /isCorePreferenceValueEntity\(entityNorm\)[\s\S]*isCorePreferenceField/,
  );
  assert.match(
    itemRoute,
    /isCorePreferenceValueEntity\(entityNormalized\)[\s\S]*isCorePreferenceField/,
  );
});

function preferenceValueSupabase({ data = null, error = null }) {
  const calls = [];
  const terminal = Promise.resolve({ data, error });
  const query = {
    select(columns) {
      calls.push(['select', columns]);
      return query;
    },
    eq(column, value) {
      calls.push(['eq', column, value]);
      return query;
    },
    single() {
      calls.push(['single']);
      return terminal;
    },
  };

  return {
    calls,
    client: {
      from(tableName) {
        calls.push(['from', tableName]);
        return query;
      },
    },
  };
}

for (const tableName of ['organization_preference_value', 'member_preference_value']) {
  test(`preference-value PATCH pre-read uses the shared schema for ${tableName}`, async () => {
    const { client, calls } = preferenceValueSupabase({
      data: { value: 'Before', field_id: 'field-1' },
    });

    const result = await loadCorePreferenceValueBeforeUpdate({
      supabase: client,
      tableName,
      id: 'value-1',
    });

    assert.deepEqual(result, { value: 'Before', fieldId: 'field-1' });
    assert.deepEqual(calls, [
      ['from', tableName],
      ['select', 'value, field_id'],
      ['eq', 'id', 'value-1'],
      ['single'],
    ]);
  });
}

test('preference-value PATCH pre-read surfaces returned Supabase errors', async () => {
  const databaseError = Object.assign(new Error('column does not exist'), {
    code: '42703',
  });
  const { client } = preferenceValueSupabase({ error: databaseError });

  await assert.rejects(
    loadCorePreferenceValueBeforeUpdate({
      supabase: client,
      tableName: 'organization_preference_value',
      id: 'value-1',
    }),
    (error) => error === databaseError,
  );
});

test('core field ownership still rejects fields outside the tenant boundary', async () => {
  const calls = [];
  const query = {
    select(columns) {
      calls.push(['select', columns]);
      return query;
    },
    eq(column, value) {
      calls.push(['eq', column, value]);
      return query;
    },
    or(filter) {
      calls.push(['or', filter]);
      return query;
    },
    maybeSingle() {
      calls.push(['maybeSingle']);
      return Promise.resolve({ data: null, error: null });
    },
  };
  const supabase = {
    from(tableName) {
      calls.push(['from', tableName]);
      return query;
    },
  };

  assert.equal(
    await isCorePreferenceField({
      supabase,
      tenantId: 'tenant-1',
      fieldId: 'foreign-field',
    }),
    false,
  );
  assert.deepEqual(calls, [
    ['from', 'preference_field'],
    ['select', 'id'],
    ['eq', 'id', 'foreign-field'],
    ['eq', 'tenant_id', 'tenant-1'],
    ['or', 'entity_scope.is.null,entity_scope.neq.custom_object'],
    ['maybeSingle'],
  ]);
});
