import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from './form-consent-message.js';
import { safeFormPrivacyUrl, FORM_PRIVACY_SETTINGS_KEY as key } from '../../shared/formConsentSettings.js';

function database(rows = []) {
  return { rows, from(table) {
    assert.equal(table, 'system_settings');
    let filters = [], operation = 'read', values, single = false;
    const query = {
      select() { return this; },
      eq(k, v) { filters.push(row => row[k] === v); return this; },
      in(k, v) { filters.push(row => v.includes(row[k])); return this; },
      limit() { return this; },
      single() { single = true; return this; },
      insert(v) { operation = 'insert'; values = v; return this; },
      update(v) { operation = 'update'; values = v; return this; },
      then(resolve) {
        let found = rows.filter(row => filters.every(filter => filter(row)));
        if (operation === 'insert') {
          if (rows.some(row => row.id === values.id)) return Promise.resolve({ error: { code: '23505' } }).then(resolve);
          rows.push(values); found = [values];
        } else if (operation === 'update') found.forEach(row => Object.assign(row, values));
        return Promise.resolve({ data: single ? found[0] : found, error: null }).then(resolve);
      },
    };
    return query;
  } };
}

async function request(db, { method = 'GET', tenant = 'a', admin = false, value } = {}) {
  let status = 200, body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await handler({ method, body: { privacy_settings_url: value } }, res, {
    supabase: db,
    resolveTenantFromRequest: async () => tenant ? { id: tenant } : null,
    getTenantContext: async () => ({ tenantId: tenant }),
    hasAdminAccess: async () => admin,
  });
  return { status, body };
}

test('URL validator accepts trimmed absolute HTTP(S), rejects unsafe and malformed destinations', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,x', '//example.com', '/privacy', 'https://', 'https://user:pass@example.com', 'https://exa\nmple.com', 'https:\\\\example.com']) {
    assert.equal(safeFormPrivacyUrl(value), '', value);
  }
  assert.equal(safeFormPrivacyUrl(' https://example.com/settings?q=a%20b '), 'https://example.com/settings?q=a%20b');
  assert.equal(safeFormPrivacyUrl('http://example.com'), 'http://example.com');
});

test('public reads preserve legacy messages, expose only tenant consent settings and sanitize stored URLs', async () => {
  const db = database([
    { id: '1', tenant_id: 'a', setting_key: 'form_default_consent_message', setting_value: 'Legacy message' },
    { id: '2', tenant_id: 'b', setting_key: key, setting_value: 'https://other.example/privacy' },
    { id: '3', tenant_id: 'a', setting_key: 'secret', setting_value: 'not public' },
  ]);
  assert.deepEqual((await request(db)).body, { message: 'Legacy message', privacy_settings_url: '' });
  assert.deepEqual((await request(db, { tenant: null })).body, { message: '', privacy_settings_url: '' });
  db.rows.push({ id: '4', tenant_id: 'a', setting_key: key, setting_value: 'javascript:alert(1)' });
  assert.equal((await request(db)).body.privacy_settings_url, '');
  assert.equal((await request(db, { tenant: 'b' })).body.privacy_settings_url, 'https://other.example/privacy');
});

test('administrator saves, reloads, changes and clears a tenant URL; unsafe writes and unauthorized writes fail', async () => {
  const db = database();
  assert.equal((await request(db, { method: 'POST', value: 'https://example.com' })).status, 403);
  assert.equal((await request(db, { method: 'POST', admin: true, value: 'javascript:alert(1)' })).status, 400);
  for (const value of [' https://example.com/privacy ', 'http://example.com/changed', '']) {
    assert.equal((await request(db, { method: 'POST', admin: true, value })).status, 200);
    assert.equal((await request(db)).body.privacy_settings_url, value.trim());
    assert.equal((await request(db, { tenant: 'b' })).body.privacy_settings_url, '');
    assert.equal(db.rows.length, 1);
  }
});

test('concurrent first saves cannot create duplicates and failures are not success', async () => {
  const db = database();
  const results = await Promise.all(['one', 'two'].map(path =>
    request(db, { method: 'POST', admin: true, value: `https://example.com/${path}` })));
  assert.equal(db.rows.length, 1);
  assert.ok(results.some(result => result.status === 200));
  assert.ok(results.some(result => result.status === 500));
  db.rows.push({ ...db.rows[0], id: 'duplicate' });
  assert.equal((await request(db)).status, 500);
  assert.equal((await request(db, { method: 'POST', admin: true, value: '' })).status, 500);
});

test('stale admin tab rejects a switched session before either tenant can change', async () => {
  const db = database(['a', 'b'].map(tenant_id => ({
    id: tenant_id, tenant_id, setting_key: key, setting_value: `https://${tenant_id}.example/privacy`,
  })));
  const before = structuredClone(db.rows);
  let status, body;
  await handler({ method: 'POST', headers: { 'x-tenant-id': 'a' },
    body: { privacy_settings_url: 'https://changed.example/privacy' } }, {
    status(value) { status = value; return this; }, json(value) { body = value; },
  }, {
    supabase: db,
    getTenantContext: async req => ({ tenantId: 'b', tenantMismatch: req.headers['x-tenant-id'] !== 'b' }),
    hasAdminAccess: async () => { assert.fail('Mismatch must be rejected before admin authorization'); },
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'TENANT_CONTEXT_CHANGED');
  assert.deepEqual(db.rows, before);
});
