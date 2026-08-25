import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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