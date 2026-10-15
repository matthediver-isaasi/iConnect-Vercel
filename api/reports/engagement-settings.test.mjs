import test from 'node:test';
import { __setRoleAccessOverlayForTests } from '../_lib/roleVisibility.js';
__setRoleAccessOverlayForTests([]);
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngagementReportHandler } from './engagement-report.js';
import { ENGAGEMENT_SETTINGS_KEY, loadEngagementSettings, saveEngagementSettings, normalizeTypeOptions } from '../_lib/engagementReportSettings.js';

function fixture() {
  const tables = {
    system_settings: [],
    preference_field: [{ id: 'field', tenant_id: 'a', entity_scope: 'organization', is_active: true,
      name: 'org_type', options: JSON.stringify(['A', { value: 'B', label: 'Bee' }]) }],
    organization: ['one', 'two', 'none'].map(id => ({ id, name: id, tenant_id: 'a' })),
    member: ['one', 'two', 'none'].map(id => ({ id, tenant_id: 'a', organization_id: id,
      first_name: id, email: `${id}@example.test`, last_activity: '2026-10-12T12:00:00Z' })),
    organization_preference_value: [
      { id: '1', organization_id: 'one', field_id: 'field', value: JSON.stringify([{ value: 'A' }]) },
      { id: '2', organization_id: 'two', field_id: 'field', value: { value: ['B'] } },
    ],
    role: [{ id: 'role', tenant_id: 'a', excluded_features: [] }],
  };
  const db = {
    fail: null, tables,
    from(table) {
      const filters = [];
      let action, payload, start = 0, end = Infinity;
      const query = {
        select() { return query; }, order() { return query; }, not() { return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        in(key, values) { filters.push(row => values.includes(row[key])); return query; },
        limit(n) { end = n - 1; return query; },
        range(a, b) { start = a; end = b; return query; },
        insert(value) { action = 'insert'; payload = value; return query; },
        update(value) { action = 'update'; payload = value; return query; },
        async maybeSingle() { const result = await query; return { ...result, data: result.data?.[0] || null }; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (db.fail === table) return { error: { message: 'Unavailable' }, data: null };
            let data = tables[table].filter(row => filters.every(f => f(row))).slice(start, end + 1);
            if (action === 'insert') {
              if (tables[table].some(row => row.id === payload.id)) return { error: { code: '23505' } };
              tables[table].push({ ...payload }); data = [payload];
            }
            if (action === 'update') data.forEach(row => Object.assign(row, payload));
            return { data, error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return db;
}
const context = { isAuthenticated: true, tenantId: 'a', tenantUserId: 'admin' };
async function request(db, query = {}, method = 'GET', body, ctx = context, admin = true) {
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
  await createEngagementReportHandler({ db, getTenantContext: async () => ctx, hasAdminAccess: async () => admin })({
    method, query, body,
  }, res);
  return res;
}
const input = values => ({ fieldId: 'field', values, revision: null });

test('absent, multi-type OR, single-type and empty settings scope every aggregation and member', async () => {
  const db = fixture();
  const dates = { startDate: '2026-10-12', endDate: '2026-10-18' };
  assert.equal((await request(db, dates)).body.summary.totalMembers, 3);
  let saved = await saveEngagementSettings(db, 'a', input(['A', 'B']));
  let report = await request(db, dates);
  assert.deepEqual(report.body.organizations.map(o => o.organizationId), ['one', 'two']);
  assert.equal(report.body.summary.totalActiveMembers, 2);
  saved = await saveEngagementSettings(db, 'a', { ...input(['B']), revision: saved.revision });
  report = await request(db, dates);
  assert.equal(report.body.organizations[0].rank, 1);
  assert.equal(report.body.organizations[0].members[0].id, 'two');
  assert.equal(report.body.organizations[0].trend, 'up');
  assert.equal(report.body.summary.totalMembers, 1);
  await saveEngagementSettings(db, 'a', { ...input([]), revision: saved.revision });
  report = await request(db, dates);
  assert.deepEqual(report.body.organizations, []);
  assert.equal(report.body.summary.totalMembers, 0);
});

test('tenant isolation, reload, stable field identity, normalized options and removed values', async () => {
  const db = fixture();
  assert.deepEqual(normalizeTypeOptions('[0,false,{"value":"B","label":"Bee"}]'),
    [{ value: '0', label: '0' }, { value: 'false', label: 'false' }, { value: 'B', label: 'Bee' }]);
  await saveEngagementSettings(db, 'a', input(['B']));
  assert.deepEqual((await loadEngagementSettings(db, 'a')).values, ['B']);
  assert.equal((await loadEngagementSettings(db, 'b')).configured, false);
  db.tables.preference_field[0].options = ['A'];
  const stale = await loadEngagementSettings(db, 'a');
  assert.deepEqual(stale.staleValues, ['B']);
  assert.deepEqual(stale.values, ['B']);
  assert.equal((await request(db)).statusCode, 409);
  db.tables.preference_field[0].id = 'replacement';
  assert.equal((await loadEngagementSettings(db, 'a')).field, null);
  assert.equal((await request(db)).statusCode, 409);
});

test('failed settings, metadata, organisation and preference reads never broaden the report', async () => {
  for (const table of ['system_settings', 'preference_field', 'organization', 'organization_preference_value']) {
    const db = fixture();
    await saveEngagementSettings(db, 'a', input(['A']));
    db.fail = table;
    const result = await request(db);
    assert.ok(result.statusCode >= 500, table);
    assert.equal(result.body.organizations, undefined);
  }
});

test('first saves serialize through primary key; stale saves conflict and no duplicate singleton exists', async () => {
  const db = fixture();
  const results = await Promise.allSettled([
    saveEngagementSettings(db, 'a', input(['A'])),
    saveEngagementSettings(db, 'a', input(['B'])),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal(db.tables.system_settings.length, 1);
  await assert.rejects(saveEngagementSettings(db, 'a', input([])), { status: 409 });
});

test('settings access requires report permission and writes additionally require admin', async () => {
  const db = fixture();
  const viewer = { isAuthenticated: true, tenantId: 'a', roleId: 'role' };
  assert.equal((await request(db, { settings: 'true' }, 'GET', null, viewer, false)).body.canManage, false);
  assert.equal((await request(db, { settings: 'true' }, 'PUT', input(['A']), viewer, false)).statusCode, 403);
  db.tables.role[0].excluded_features = ['reports.org-engagement'];
  assert.equal((await request(db, { settings: 'true' }, 'PUT', input(['A']), viewer)).statusCode, 403);
  assert.equal((await request(db, { settings: 'true' }, 'GET', null, {})).statusCode, 401);
  assert.equal((await request(db, { settings: 'true' }, 'GET', null, { ...context, tenantMismatch: true })).statusCode, 409);
  assert.equal((await request(db, { settings: 'true' }, 'PUT', input(['foreign']))).statusCode, 400);
});

test('individual admin revocation overrides admin role permission without revoking report reads', async () => {
  const db = fixture();
  for (const exclusion of ['admin.role-management', 'admin']) {
    const viewer = { isAuthenticated: true, tenantId: 'a', roleId: 'role',
      memberExcludedFeatures: [exclusion] };
    assert.equal((await request(db, {}, 'GET', null, viewer, true)).statusCode, 200);
    const settings = await request(db, { settings: 'true' }, 'GET', null, viewer, true);
    assert.equal(settings.statusCode, 200);
    assert.equal(settings.body.canManage, false);
    assert.equal((await request(db, { settings: 'true' }, 'PUT', input(['A']), viewer, true)).statusCode, 403);
  }
  assert.equal(db.tables.system_settings.length, 0);
  const dashboard = { ...context, memberExcludedFeatures: ['admin'] };
  assert.equal((await request(db, { settings: 'true' }, 'PUT', input(['A']), dashboard)).statusCode, 200);
});

test('generic CRUD denies protected creates, updates, deletes and key renames', () => {
  const create = readFileSync(new URL('../entities/[entity]/index.js', import.meta.url), 'utf8');
  const mutate = readFileSync(new URL('../entities/[entity]/[id].js', import.meta.url), 'utf8');
  for (const source of [create, mutate]) {
    assert.ok(source.includes(`'${ENGAGEMENT_SETTINGS_KEY}'`));
    assert.ok(source.includes('DEDICATED_ORGANISATION_DIRECTORY_SETTINGS.has(req.body?.setting_key)'));
  }
  assert.ok(mutate.includes("['PATCH', 'PUT', 'DELETE'].includes(req.method)"));
  assert.ok(mutate.includes('DEDICATED_ORGANISATION_DIRECTORY_SETTINGS.has(directorySetting?.[0]?.setting_key)'));
});

test('duplicates, malformed saved data and missing metadata are explicit, not unrestricted', async () => {
  const db = fixture();
  db.tables.preference_field = [];
  assert.match((await loadEngagementSettings(db, 'a')).warning, /missing/);
  assert.equal((await request(db)).body.summary.totalMembers, 3);
  db.tables.system_settings.push({ id: 'bad', tenant_id: 'a', setting_key: ENGAGEMENT_SETTINGS_KEY, setting_value: 'bad' });
  assert.equal((await request(db)).statusCode, 409);
  db.tables.system_settings.push({ ...db.tables.system_settings[0], id: 'duplicate' });
  assert.equal((await request(db)).statusCode, 409);
});

test('preference matching reads every page in bounded organisation batches', async () => {
  const db = fixture();
  db.tables.organization_preference_value = Array.from({ length: 501 }, (_, i) => ({
    id: String(i), organization_id: 'one', field_id: 'field', value: i === 500 ? '"A"' : '"B"',
  }));
  await saveEngagementSettings(db, 'a', input(['A']));
  assert.equal((await request(db)).body.summary.totalMembers, 1);
});

test('date validation and previous-period trends remain unchanged with a saved cohort', async () => {
  const db = fixture();
  await saveEngagementSettings(db, 'a', input(['A']));
  const report = await request(db, { startDate: '2026-10-19', endDate: '2026-10-25' });
  assert.equal(report.body.summary.totalActiveMembers, 0);
  assert.equal(report.body.organizations[0].trend, 'down');
  assert.equal(report.body.organizations[0].trendDiff, -1);
  assert.equal(report.body.period.previousStart, '2026-10-12');
  assert.equal((await request(db, { startDate: '2026-10-19' })).statusCode, 400);
  assert.equal((await request(db, { startDate: '2026-10-25', endDate: '2026-10-19' })).statusCode, 400);
});
