import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { authorizeCarouselConsentWrite as authorize } from './directoryCarouselConsent.js';

const context = { isAuthenticated: true, tenantId: 'tenant-a' };
function fixture(row, fail = false) {
  return {
    from() {
      const query = {
        select() { return query; },
        eq(key, value) {
          if (key === 'tenant_id') assert.equal(value, 'tenant-a');
          return query;
        },
        async maybeSingle() { return { data: row, error: fail ? { message: 'unavailable' } : null }; },
      };
      return query;
    },
  };
}
const check = (options = {}) => authorize({
  entity: 'dynamicdirectory', method: 'POST', context,
  db: fixture(null), hasAdminAccess: async () => false, ...options,
});

test('dynamic permission is strict boolean and administrator-only, even false', async () => {
  for (const value of [null, 'true', 'false', 1, {}, []]) {
    assert.equal((await check({ body: { public_carousel_enabled: value } })).status, 400);
  }
  for (const value of [true, false]) {
    assert.equal((await check({ body: { public_carousel_enabled: value } })).status, 403);
    assert.equal(await check({ body: { public_carousel_enabled: value }, hasAdminAccess: async () => true }), null);
  }
  assert.equal(await check({ body: { name: 'Private directory' } }), null);
});

test('page/directory authors cannot change existing public sources via unrelated fields or deletion', async () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.equal((await check({ method, id: 'source-a', body: { filter_expression: {} },
      db: fixture({ public_carousel_enabled: true }) })).status, 403);
    assert.equal(await check({ method, id: 'source-a', db: fixture({ public_carousel_enabled: false }) }), null);
  }
  assert.equal((await check({ method: 'PATCH', id: 'source-a', db: fixture(null, true) })).status, 503);
});

test('primary consent cannot be created, renamed, edited or deleted through generic entities', async () => {
  for (const key of ['member_directory_public_carousel_enabled', 'org_directory_public_carousel_enabled']) {
    assert.equal((await check({ entity: 'systemsettings', body: { setting_key: key }, hasAdminAccess: async () => true })).status, 403);
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      assert.equal((await check({ entity: 'systemsettings', method, id: 'setting-a',
        body: { setting_key: 'unrelated' }, db: fixture({ setting_key: key }),
        hasAdminAccess: async () => true })).status, 403);
    }
  }
});

test('both real generic routes invoke the consent boundary before directory validation', async () => {
  for (const file of ['index.js', '[id].js']) {
    const text = await readFile(new URL(`../entities/[entity]/${file}`, import.meta.url), 'utf8');
    assert.match(text, /const carouselConsentError = await authorizeCarouselConsentWrite\(/);
    assert.ok(text.indexOf('const carouselConsentError') < text.indexOf('try { await validateDirectoryConfiguration'));
    assert.match(text, /if \(carouselConsentError\) return res.status\(carouselConsentError.status\)/);
  }
});
