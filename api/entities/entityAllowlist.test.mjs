import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexSource = fs.readFileSync(new URL('./[entity]/index.js', import.meta.url), 'utf8');
const byIdSource = fs.readFileSync(new URL('./[entity]/[id].js', import.meta.url), 'utf8');
const clientRegistrySource = fs.readFileSync(
  new URL('../../client/src/api/base44Client.js', import.meta.url),
  'utf8',
);

const normalizeEntityName = (value) => value.replace(/[-_]/g, '').toLowerCase();
const clientEntityNames = [
  ...clientRegistrySource.matchAll(
    /get\s+[A-Za-z0-9_]+\s*\(\)\s*\{\s*return this\._getEntity\('([^']+)'\)/g,
  ),
].map((match) => match[1]);

test('generic entity routes resolve tables only through the explicit allowlist', () => {
  for (const source of [indexSource, byIdSource]) {
    assert.match(source, /entityTableByNormalizedName/);
    assert.match(source, /!isCustomObjectStorageEntity\(entityNorm\)\s*&&\s*!entityTableByNormalizedName\.has\(entityNorm\)/);
    assert.match(source, /Unsupported entity/);
    assert.doesNotMatch(source, /entityToTable\[entity\]\s*\|\|\s*entity\.toLowerCase/);
  }
});

test('generic entity allowlists cover every Base44 entity registry accessor', () => {
  for (const source of [indexSource, byIdSource]) {
    const allowlistedNames = new Set(
      [...source.matchAll(/^\s+'([^']+)':\s*'[^']+',/gm)]
        .map((match) => normalizeEntityName(match[1])),
    );
    for (const entityName of clientEntityNames) {
      assert.equal(
        allowlistedNames.has(normalizeEntityName(entityName)),
        true,
        `${entityName} must be present in the generic entity allowlist`,
      );
    }
  }
});