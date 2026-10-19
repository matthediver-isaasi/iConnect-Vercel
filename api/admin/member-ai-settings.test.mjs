import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemberAiSettingsHandler } from './member-ai-settings.js';
import { MEMBER_AI_DEFAULTS, getMemberAiSettings } from '../_lib/memberAiUsage.js';

function database(settings = null) {
  const writes = [];
  return {
    writes,
    from(table) {
      assert.equal(table, 'member_ai_settings');
      const query = {
        select() { return query; },
        eq() { return query; },
        upsert(row) { writes.push(row); return query; },
        async maybeSingle() { return { data: settings, error: null }; },
        async single() { return { data: writes.at(-1), error: null }; },
      };
      return query;
    },
  };
}

function response() {
  return {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function handler(db, user = { tenant_id: 'tenant-a', role: 'admin' }) {
  return createMemberAiSettingsHandler({
    supabase: db,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }),
    getSessionTenantUser: async () => user,
  });
}

test('new source defaults explicitly include both page builders', async () => {
  assert.deepEqual(MEMBER_AI_DEFAULTS.allowed_content_types, [
    'resource', 'event', 'complex_event', 'news_post', 'blog_post', 'canvas_page', 'iedit_page',
  ]);
  const db = database();
  const res = response();
  await handler(db)({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.settings.allowed_content_types, MEMBER_AI_DEFAULTS.allowed_content_types);
  assert.equal(await getMemberAiSettings({ supabase: db, tenantId: 'tenant-a' }), MEMBER_AI_DEFAULTS);
  assert.equal(db.writes.length, 0);
});

test('additive migration changes only the SQL new-row source default, preserving saved arrays', () => {
  const migration = readFileSync(new URL('../../supabase/migrations/202612310007_iedit_member_content.sql',
    import.meta.url), 'utf8');
  const statement = migration.match(/ALTER TABLE public\.member_ai_settings\s+ALTER COLUMN allowed_content_types SET DEFAULT\s+ARRAY\[([^\]]+)\]::text\[\];/);
  assert.ok(statement, 'iEdit migration must set the default independently of existing rows');
  const types = [...statement[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(types, MEMBER_AI_DEFAULTS.allowed_content_types);
  assert.doesNotMatch(migration, /UPDATE\s+(?:public\.)?member_ai_settings\b/i);
  assert.ok(migration.indexOf(statement[0]) < migration.indexOf("NOTIFY pgrst"));
});

test('saved exclusions are not expanded by reads or unrelated source saves', async () => {
  const settings = { ...MEMBER_AI_DEFAULTS, allowed_content_types: ['resource', 'canvas_page'] };
  const db = database(settings);
  const res = response();
  await handler(db)({ method: 'GET' }, res);
  assert.deepEqual(res.body.settings.allowed_content_types, ['resource', 'canvas_page']);
  assert.deepEqual((await getMemberAiSettings({ supabase: db, tenantId: 'tenant-a' })).allowed_content_types,
    ['resource', 'canvas_page']);
  await handler(db)({ method: 'PUT', body: settings }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(db.writes[0].allowed_content_types, ['resource', 'canvas_page']);
});

test('source updates accept iEdit alone, dedupe selections, and reject empty or unknown types', async () => {
  const db = database();
  for (const allowed of [['iedit_page'], ['canvas_page', 'iedit_page', 'iedit_page']]) {
    const res = response();
    await handler(db)({ method: 'PUT', body: { ...MEMBER_AI_DEFAULTS, allowed_content_types: allowed } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.settings.allowed_content_types, [...new Set(allowed)]);
    assert.equal(res.body.settings.tenant_id, 'tenant-a');
  }
  for (const allowed of [[], ['i_edit_page'], ['iedit_page', 'unknown'], null]) {
    const res = response();
    await handler(db)({ method: 'PUT', body: { ...MEMBER_AI_DEFAULTS, allowed_content_types: allowed } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(db.writes.length, 2);
});

test('members and administrators of another tenant cannot change source controls', async () => {
  const db = database();
  for (const user of [null, { tenant_id: 'tenant-a', role: 'member' }, { tenant_id: 'tenant-b', role: 'admin' }]) {
    const res = response();
    await handler(db, user)({ method: 'PUT', body: MEMBER_AI_DEFAULTS }, res);
    assert.equal(res.statusCode, 403);
  }
  assert.equal(db.writes.length, 0);
});
