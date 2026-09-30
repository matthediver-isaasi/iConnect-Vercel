import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY,
  LEGACY,
  MENU,
  TENANT,
  runMigration,
  translateExclusions,
} from './migrate-bnms-nmc-journal-rbac.mjs';

const clone = value => structuredClone(value);

function fixture() {
  return {
    tenant: [{ id: TENANT, name: 'BNMS' }],
    menus: [{
      id: MENU,
      tenant_id: TENANT,
      title: 'NMC Journal',
      url: 'https://journals.lww.com/nuclearmedicinecomm/pages/default.aspx',
      link_type: 'external',
      feature_id: LEGACY,
      display_order: 4,
    }],
    nav: [],
    roles: [
      { id: '10000000-0000-0000-0000-000000000001', tenant_id: TENANT, name: 'Reader', excluded_features: ['alpha', LEGACY, 'omega'] },
      { id: '10000000-0000-0000-0000-000000000002', tenant_id: TENANT, name: 'Canonical deny', excluded_features: [KEY, LEGACY, 'other'] },
      { id: '10000000-0000-0000-0000-000000000003', tenant_id: TENANT, name: 'Content denied', excluded_features: ['content'] },
    ],
    tree: [
      {
        id: '20000000-0000-0000-0000-000000000001',
        item_type: 'module',
        item_key: 'content',
        label: 'Content',
        parent_id: null,
        display_order: 2,
        is_active: true,
      },
      {
        id: '20000000-0000-0000-0000-000000000002',
        item_type: 'page',
        item_key: 'content.news',
        label: 'News',
        parent_id: '20000000-0000-0000-0000-000000000001',
        display_order: 3,
        is_active: true,
      },
    ],
  };
}

class FakeClient {
  constructor(state = fixture()) {
    this.state = clone(state);
    this.transactionStart = null;
    this.nextTreeId = 3;
    this.queries = [];
  }

  async query(sql, values = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: normalized, values: clone(values) });

    if (normalized.startsWith('BEGIN ')) {
      this.transactionStart = clone(this.state);
      return { rows: [], rowCount: null };
    }
    if (normalized === 'ROLLBACK') {
      if (this.transactionStart) this.state = this.transactionStart;
      this.transactionStart = null;
      return { rows: [], rowCount: null };
    }
    if (normalized === 'COMMIT') {
      this.transactionStart = null;
      return { rows: [], rowCount: null };
    }
    if (normalized.startsWith('SET LOCAL ') || normalized.startsWith('LOCK TABLE ')) {
      return { rows: [], rowCount: null };
    }
    if (normalized.startsWith('SELECT id,name FROM tenant ')) {
      return { rows: clone(this.state.tenant), rowCount: this.state.tenant.length };
    }
    if (normalized.startsWith('SELECT * FROM portal_menu WHERE tenant_id=')) {
      return { rows: clone(this.state.menus), rowCount: this.state.menus.length };
    }
    if (normalized.startsWith('SELECT * FROM portal_navigation_item WHERE tenant_id=')) {
      return { rows: clone(this.state.nav), rowCount: this.state.nav.length };
    }
    if (normalized.startsWith('SELECT id,name,excluded_features FROM role WHERE tenant_id=')) {
      const rows = this.state.roles.map(({ id, name, excluded_features }) =>
        ({ id, name, excluded_features: clone(excluded_features) }));
      return { rows, rowCount: rows.length };
    }
    if (normalized === 'SELECT * FROM role_access_item ORDER BY id') {
      return { rows: clone(this.state.tree), rowCount: this.state.tree.length };
    }
    if (normalized.startsWith('SELECT (SELECT md5(')) {
      // The fixture has no unrelated changes during a migration. Stable values
      // model the database-side fingerprints without reproducing PostgreSQL JSON.
      return { rows: [{ menus: 'm', nav: 'n', roles: 'r', tree: 't' }], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO role_access_item ')) {
      this.state.tree.push({
        id: `20000000-0000-0000-0000-${String(this.nextTreeId++).padStart(12, '0')}`,
        item_type: 'page',
        item_key: values[0],
        label: 'NMC Journal',
        parent_id: values[1],
        display_order: values[2],
        is_active: true,
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE portal_menu SET feature_id=')) {
      const row = this.state.menus.find(item =>
        item.id === values[1] && item.tenant_id === values[2] && item.feature_id === values[3]);
      if (!row) return { rows: [], rowCount: 0 };
      row.feature_id = values[0];
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE role SET excluded_features=')) {
      const row = this.state.roles.find(item => item.id === values[1] && item.tenant_id === values[2]);
      if (!row) return { rows: [], rowCount: 0 };
      row.excluded_features = JSON.parse(values[0]);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT * FROM portal_menu WHERE id=')) {
      const rows = this.state.menus.filter(item => item.id === values[0]);
      return { rows: clone(rows), rowCount: rows.length };
    }

    throw new Error(`Unexpected query in fake client: ${normalized}`);
  }
}

test('translateExclusions preserves unrelated denies and is idempotent', () => {
  const original = ['unknown.before', LEGACY, 'unknown.after', LEGACY];
  const translated = translateExclusions(original);

  assert.deepEqual(translated, ['unknown.before', KEY, 'unknown.after']);
  assert.deepEqual(original, ['unknown.before', LEGACY, 'unknown.after', LEGACY]);
  assert.strictEqual(translateExclusions(translated), translated);
  assert.equal(translateExclusions(null), null);
});

test('translateExclusions preserves an existing canonical deny without duplication', () => {
  const original = ['before', LEGACY, 'middle', KEY, 'after', LEGACY];
  const translated = translateExclusions(original);

  assert.deepEqual(translated, ['before', 'middle', KEY, 'after']);
  assert.equal(translated.filter(value => value === KEY).length, 1);
  assert.deepEqual(translateExclusions(translated), translated);
});

test('migration dry run, apply, and rerun are safe and idempotent', async () => {
  const client = new FakeClient();
  const initial = clone(client.state);

  const dryRun = await runMigration(client);
  assert.deepEqual(client.state, initial, 'dry run must leave all fixture data untouched');
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.permissionRowsInserted, 1);
  assert.equal(dryRun.menuRowsChanged, 1);
  assert.equal(dryRun.roleRowsChanged, 2);
  assert.deepEqual(dryRun.contentParentBlockedRoles, ['Content denied']);

  await assert.rejects(
    runMigration(client, { apply: true, reviewedHash: '0'.repeat(64) }),
    /Snapshot changed/,
  );
  assert.deepEqual(client.state, initial, 'a rejected apply must roll back');

  const applied = await runMigration(client, { apply: true, reviewedHash: dryRun.reviewHash });
  assert.equal(applied.committed, true);
  assert.equal(client.state.menus[0].feature_id, KEY);
  assert.equal(client.state.tree.filter(row => row.item_key === KEY).length, 1);
  assert.deepEqual(client.state.roles[0].excluded_features, ['alpha', KEY, 'omega']);
  assert.deepEqual(client.state.roles[1].excluded_features, [KEY, 'other']);
  assert.deepEqual(client.state.roles[2].excluded_features, ['content']);

  const rerunReview = await runMigration(client);
  assert.equal(rerunReview.permissionRowsInserted, 0);
  assert.equal(rerunReview.menuRowsChanged, 0);
  assert.equal(rerunReview.roleRowsChanged, 0);
  const afterFirstApply = clone(client.state);

  const rerun = await runMigration(client, {
    apply: true,
    reviewedHash: rerunReview.reviewHash,
  });
  assert.equal(rerun.committed, true);
  assert.deepEqual(client.state, afterFirstApply, 'rerun must not add or alter data');
});