import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultNmcJournalSettings, nmcClassOptions, validateNmcJournalSettings, loadNmcJournalSettings, saveNmcJournalSettings } from './nmcJournalSettings.js';
import { createNmcReportHandler } from '../admin/nmc-membership-report/index.js';
import { NMC_TENANT } from './nmcMembershipReport.js';

const options = nmcClassOptions(['Full', 'Full with NMC', 'New class', 'Trainee with NMC']);
const current = defaultNmcJournalSettings(options);
test('defaults and explicit empty selections; new classes need deliberate selection', () => {
  assert.deepEqual(current, { printedClasses: ['Full with NMC'], onlineClasses: ['Full'], revision: 0 });
  assert.deepEqual(validateNmcJournalSettings({ printedClasses: [], onlineClasses: [], revision: 0 }, options, current),
    { printedClasses: [], onlineClasses: [], revision: 0 });
  assert.deepEqual(validateNmcJournalSettings({ printedClasses: ['New class'], onlineClasses: ['Full with NMC'], revision: 0 }, options, current).printedClasses, ['New class']);
});
test('reject malformed, duplicate, overlapping, invented and stale settings', () => {
  for (const patch of [
    { printedClasses: null }, { printedClasses: ['Full', 'Full'] },
    { printedClasses: ['Full'], onlineClasses: ['Full'] }, { printedClasses: ['Unknown'] },
    { revision: -1 }, { revision: '0' }, { tenant_id: NMC_TENANT },
  ]) assert.throws(() => validateNmcJournalSettings({ ...current, ...patch }, options, current), e => e.status === 400);
  assert.throws(() => validateNmcJournalSettings({ ...current, revision: 1 }, options, current), e => e.status === 409);
  assert.throws(() => nmcClassOptions(['Full', 'Full']));
});
test('removed definitions remain visible but cannot be moved or newly invented', () => {
  const saved = { printedClasses: ['retired-id'], onlineClasses: [], revision: 1 };
  assert.deepEqual(validateNmcJournalSettings(saved, options, saved), saved);
  assert.throws(() => validateNmcJournalSettings({ ...saved, printedClasses: [], onlineClasses: ['retired-id'] }, options, saved));
});

function database() {
  const rows = new Map();
  const calls = [];
  return { rows, calls, from(table) {
    const filters = []; let mode = 'read', payload;
    if (table === 'preference_field') {
      const q = { select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
        gt() { q.after = true; return q; },
        then(resolve, reject) { return Promise.resolve({ data: q.after ? [] : [{ id: 'field', options }], count: q.after ? 0 : 1 }).then(resolve, reject); } };
      return q;
    }
    const q = {
      select() { return q; },
      eq(k, v) { filters.push([k, v]); return q; },
      insert(value) { mode = 'insert'; payload = value; return q; },
      update(value) { mode = 'update'; payload = value; return q; },
      async maybeSingle() {
        assert.equal(table, 'nmc_journal_settings');
        calls.push({ mode, filters });
        const tenant = mode === 'insert' ? payload.tenant_id : filters.find(([k]) => k === 'tenant_id')?.[1];
        assert.ok(tenant);
        const row = rows.get(tenant);
        if (mode === 'read') return { data: row || null };
        if (mode === 'insert') {
          if (row) return { error: { code: '23505' } };
          rows.set(tenant, payload); return { data: payload };
        }
        if (!row || filters.some(([k, v]) => row[k] !== v)) return { data: null };
        const next = { ...row, ...payload }; rows.set(tenant, next); return { data: next };
      },
    };
    return q;
  } };
}
test('save/load persist to scoped singleton; revision protects concurrent first and subsequent writes', async () => {
  const db = database();
  assert.equal(await loadNmcJournalSettings(db, NMC_TENANT), null);
  const results = await Promise.allSettled([
    saveNmcJournalSettings(db, NMC_TENANT, current, options),
    saveNmcJournalSettings(db, NMC_TENANT, current, options),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  const saved = await loadNmcJournalSettings(db, NMC_TENANT);
  assert.equal(saved.revision, 1);
  const edits = await Promise.allSettled([
    saveNmcJournalSettings(db, NMC_TENANT, { ...saved, printedClasses: [] }, options),
    saveNmcJournalSettings(db, NMC_TENANT, { ...saved, onlineClasses: [] }, options),
  ]);
  assert.equal(edits.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(edits.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await loadNmcJournalSettings(db, NMC_TENANT)).revision, 2);
  assert.equal(await loadNmcJournalSettings(db, 'other'), null);
});
test('database errors never silently restore defaults', async () => {
  await assert.rejects(loadNmcJournalSettings({ from: () => ({ select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ error: { code: '42P01' } }) }) }, NMC_TENANT));
});

function response() {
  return { setHeader() {}, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
}
test('PUT shares GET tenant/admin and feature restrictions before reading settings', async () => {
  const allowed = { isAuthenticated: true, tenantId: NMC_TENANT, roleId: 'role' };
  for (const [ctx, admin, feature, expected] of [
    [null, true, true, 401], [{ ...allowed, tenantId: 'other' }, true, true, 404],
    [{ ...allowed, tenantMismatch: true }, true, true, 404],
    [allowed, false, true, 403], [allowed, true, false, 403],
  ]) {
    const res = response();
    await createNmcReportHandler({ getTenantContext: async () => ctx, hasAdminAccess: async () => admin,
      hasFeatureAccess: async () => feature, db: { from() { throw new Error('must not query'); } } })({ method: 'PUT', body: current }, res);
    assert.equal(res.statusCode, expected);
  }
});
test('authorized endpoint saves settings, rejects invalid input and handles stale saves', async () => {
  const db = database();
  const handler = createNmcReportHandler({ db,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: NMC_TENANT, tenantUserId: 'admin' }),
    hasAdminAccess: async () => true });
  const saved = response();
  await handler({ method: 'PUT', body: current }, saved);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.settings.revision, 1);
  assert.deepEqual((await loadNmcJournalSettings(db, NMC_TENANT)).printedClasses, current.printedClasses);
  const stale = response();
  await handler({ method: 'PUT', body: current }, stale);
  assert.equal(stale.statusCode, 409);
  const invalid = response();
  await handler({ method: 'PUT', body: { ...current, revision: 1, printedClasses: ['invented'] } }, invalid);
  assert.equal(invalid.statusCode, 400);
  const query = response();
  await handler({ method: 'PUT', query: { format: 'xlsx' }, body: current }, query);
  assert.equal(query.statusCode, 400);
});
