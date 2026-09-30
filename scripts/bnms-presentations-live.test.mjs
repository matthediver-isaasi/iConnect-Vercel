import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEADERS,
  TENANT_ID,
  buildReport,
} from './bnms-presentations-proposal.mjs';
import {
  APPROVAL_DIR,
  RESOURCE_COLUMNS,
  PROPOSAL_SHA,
  SNAPSHOT_SHA,
  SOURCE_SHA,
  applyApproved,
  assertSnapshot,
  loadApproval,
  planApproved,
  resourceId,
  sqlSnapshot,
  verifyApplied,
} from './bnms-presentations-live.mjs';

const OTHER_TENANT = 'another-tenant';
const clone = value => structuredClone(value);
const byId = (left, right) => String(left.id).localeCompare(String(right.id));
let approvedBundle;
const savedBundle = () => approvedBundle ??= loadApproval();

function journalEntries() {
  const entries = [];
  return { entries, journal: entry => entries.push(clone(entry)) };
}

function taxonomy() {
  return [
    {
      id: 'category-collection',
      tenant_id: TENANT_ID,
      name: 'Collection',
      subcategories: ['Events'],
    },
    {
      id: 'category-resource-type',
      tenant_id: TENANT_ID,
      name: 'Resource Type',
      subcategories: ['Presentations'],
    },
    {
      id: 'category-focus-area',
      tenant_id: TENANT_ID,
      name: 'Focus Area',
      subcategories: [],
    },
  ];
}

function source({ url, title, description, date = '2025-01-02' }) {
  const cells = Object.fromEntries(HEADERS.map(header => [header, '']));
  Object.assign(cells, {
    'Resource URL': url,
    Title: title,
    'Brief Description': description,
    Date: date,
    'Member Only': 'Yes',
    Collection: 'Events',
    'Resource Type': 'Presentations',
  });
  return cells;
}

function fullResource({
  id,
  url,
  title,
  description,
  releaseDate = '2024-01-01T00:00:00.000Z',
  subcategories = ['Events', 'Presentations'],
  tags = ['preserved-tag'],
} = {}) {
  return {
    id,
    title,
    description,
    subcategories,
    resource_type: 'external_link',
    target_url: url,
    open_in_new_tab: true,
    image_url: null,
    release_date: releaseDate,
    is_public: false,
    allowed_role_ids: [],
    tags,
    author_id: null,
    author_name: null,
    folder_id: null,
    status: 'active',
    tenant_id: TENANT_ID,
    search_text: null,
    linked_events: [],
    seo_title: null,
    seo_description: null,
    og_image_url: null,
    is_sample: false,
    member_group_id: null,
  };
}

function syntheticBundle() {
  const updateUrl = 'https://www.youtube.com/watch?v=synthetic-update';
  const insertUrl = 'https://drive.google.com/file/d/synthetic-insert/view';
  const workbook = {
    checksum: 'synthetic-live-workbook',
    rows: [
      {
        row: 2,
        source: source({
          url: insertUrl,
          title: 'Synthetic inserted presentation',
          description: 'Inserted description',
        }),
        hyperlinks: {},
      },
      {
        row: 3,
        source: source({
          url: updateUrl,
          title: 'Synthetic updated presentation',
          description: 'Updated description',
        }),
        hyperlinks: {},
      },
    ],
  };
  const existing = fullResource({
    id: 'synthetic-existing-resource',
    url: updateUrl,
    title: 'Old title',
    description: 'Old description',
    tags: ['keep-this-tag'],
  });
  const categories = taxonomy();
  const report = buildReport(workbook, [existing], categories);
  assert.deepEqual(report.rows.map(row => row.status), ['insert', 'update']);
  return {
    workbook,
    report,
    before: {
      tenant: { id: TENANT_ID, name: 'BNMS' },
      resources: [existing],
      categories,
    },
  };
}

class FakeSqlClient {
  constructor(snapshot, { corruptInsert = false } = {}) {
    this.state = {
      resources: clone(snapshot.resources),
      categories: clone(snapshot.categories),
    };
    this.transaction = null;
    this.calls = [];
    this.dml = [];
    this.rollbackCount = 0;
    this.commitCount = 0;
    this.corruptInsert = corruptInsert;
    this.committedDespiteError = false;
  }

  async query(sql, params = []) {
    this.calls.push({ sql, params: clone(params) });

    if (sql === 'BEGIN') {
      assert.equal(this.transaction, null, 'a transaction is already open');
      this.transaction = clone(this.state);
      return { rowCount: null, rows: [] };
    }
    if (sql.startsWith('SET LOCAL ')) return { rowCount: null, rows: [] };
    if (sql.startsWith('LOCK TABLE ')) {
      assert.ok(this.transaction, 'table locks require a transaction');
      return { rowCount: null, rows: [] };
    }
    if (sql === 'SELECT id FROM public.tenant WHERE id = $1 FOR SHARE') {
      assert.equal(params[0], TENANT_ID);
      return { rowCount: 1, rows: [{ id: TENANT_ID }] };
    }
    if (sql === 'SELECT id, name FROM public.tenant WHERE id = $1') {
      assert.equal(params[0], TENANT_ID);
      return { rowCount: 1, rows: [{ id: TENANT_ID, name: 'BNMS' }] };
    }
    if (sql.startsWith('SELECT column_name FROM information_schema.columns')) {
      return { rowCount: RESOURCE_COLUMNS.length, rows: RESOURCE_COLUMNS.map(column_name => ({ column_name })) };
    }
    if (sql.startsWith('SELECT tgname FROM pg_trigger')) {
      return { rowCount: 0, rows: [] };
    }

    const snapshotMatch = sql.match(/FROM public\.(resource_category|resource) r/);
    if (snapshotMatch) {
      assert.match(sql, /WHERE tenant_id = \$1/);
      const table = snapshotMatch[1] === 'resource' ? 'resources' : 'categories';
      const sourceRows = (this.transaction || this.state)[table]
        .filter(row => row.tenant_id === params[0])
        .sort(byId);
      return { rowCount: sourceRows.length, rows: sourceRows.map(record => ({ record: clone(record) })) };
    }

    if (sql.startsWith('INSERT INTO public.resource ')) {
      assert.ok(this.transaction, 'inserts require a transaction');
      assert.equal(params[1], TENANT_ID);
      const columns = sql.match(/^INSERT INTO public\.resource \(([^)]+)\)/)?.[1]
        .split(',').map(column => column.trim());
      assert.deepEqual(columns, RESOURCE_COLUMNS, 'insert must enumerate the approved resource columns');
      assert.match(sql, /jsonb_populate_recordset\(NULL::public\.resource, \$1::jsonb\)/);
      assert.deepEqual(
        [...sql.matchAll(/SELECT ([\s\S]*?)\s+FROM jsonb_populate_recordset/g)][0][1]
          .split(',').map(column => column.trim()),
        RESOURCE_COLUMNS.map(column => `p.${column}`),
      );
      const records = JSON.parse(params[0]);
      for (const record of records) {
        assert.deepEqual(Object.keys(record).sort(), [...RESOURCE_COLUMNS].sort());
        assert.equal(record.resource_type, 'external_link');
        assert.equal(record.open_in_new_tab, true);
        assert.equal(record.status, 'active');
        assert.equal(record.is_sample, false);
        assert.equal(record.member_group_id, null);
        assert.deepEqual(record.allowed_role_ids, []);
        assert.deepEqual(record.tags, []);
        assert.deepEqual(record.linked_events, []);
        assert.equal(record.folder_id, null);
      }
      this.dml.push({ type: 'insert', records: clone(records) });
      const inserted = records.map(record => clone(record));
      if (this.corruptInsert) inserted[0].title = 'Unexpected post-write mutation';
      this.transaction.resources.push(...inserted);
      return { rowCount: inserted.length, rows: inserted.map(({ id }) => ({ id })) };
    }

    if (sql.startsWith('UPDATE public.resource ')) {
      assert.ok(this.transaction, 'updates require a transaction');
      assert.equal(params[1], TENANT_ID);
      assert.match(sql, /SET title = p\.title, description = p\.description,\s*release_date = p\.release_date, subcategories = p\.subcategories/s);
      assert.doesNotMatch(sql, /SET .*?(?:is_public|tags|allowed_role_ids|status|target_url)/s);
      const records = JSON.parse(params[0]);
      this.dml.push({ type: 'update', records: clone(records) });
      const rows = [];
      for (const record of records) {
        const current = this.transaction.resources.find(row => row.id === record.id);
        assert.ok(current, `missing update target ${record.id}`);
        assert.deepEqual(current, record.before, `conditional update precondition failed for ${record.id}`);
        current.title = record.title;
        current.description = record.description;
        current.release_date = record.release_date;
        current.subcategories = clone(record.subcategories);
        rows.push({ id: current.id });
      }
      return { rowCount: rows.length, rows };
    }

    if (sql === 'COMMIT') {
      assert.ok(this.transaction, 'commit requires a transaction');
      this.state = this.transaction;
      this.transaction = null;
      this.commitCount++;
      return { rowCount: null, rows: [] };
    }
    if (sql === 'ROLLBACK') {
      this.rollbackCount++;
      this.transaction = null;
      return { rowCount: null, rows: [] };
    }
    throw new Error(`Unexpected SQL in fake client: ${sql}`);
  }
}

test('loadApproval is pinned to the saved bundle and source workbook', () => {
  const bundle = savedBundle();

  assert.equal(APPROVAL_DIR, 'reports/bnms-presentations/2026-09-15T13-27-11.746Z');
  assert.equal(bundle.report.inputChecksum, SOURCE_SHA);
  assert.equal(bundle.report.snapshotChecksum, SNAPSHOT_SHA);
  assert.equal(bundle.report.generatorChecksums['scripts/bnms-presentations-proposal.mjs'],
    '6afc5c204d5140016bdd92b051974e7d59cf37543502eb0839d2b2d3079bb1dc');
  assert.equal(bundle.before.tenant.id, TENANT_ID);
  assert.equal(bundle.before.tenant.name, 'BNMS');
  assert.equal(bundle.workbook.checksum, SOURCE_SHA);
  assert.equal(PROPOSAL_SHA, 'ff16e5604fe73e001df933cea278f1f05d1da92c4ffd4558b9edb4a73368336f');
});

test('the approved plan has distinct deterministic IDs and the reviewed action totals', () => {
  const bundle = savedBundle();
  const plan = planApproved(bundle);
  const secondPlan = planApproved(savedBundle());

  assert.deepEqual(bundle.report.summary, {
    sourceRows: 1445,
    distinctLiteralUrls: 1441,
    destinationResources: 1505,
    inserts: 1354,
    updates: 4,
    unchanged: 0,
    blocked: 87,
    exactMatchRows: 0,
    identityMatchRows: 4,
    unmatchedRows: 1441,
    coreChangeRows: 4,
    accessChangeRows: 0,
    yearOnlyRows: 1445,
    databaseWrites: 0,
  });
  assert.equal(plan.inserts.length, 1354);
  assert.equal(plan.updates.length, 4);
  assert.equal(plan.skipped.length, 87);
  assert.ok(plan.skipped.every(row => row.status === 'blocked'));

  const writeIds = [...plan.inserts, ...plan.updates].map(({ record }) => record.id);
  assert.equal(new Set(writeIds).size, 1358);
  assert.deepEqual(
    writeIds,
    [...secondPlan.inserts, ...secondPlan.updates].map(({ record }) => record.id),
  );
  for (const insertion of plan.inserts) {
    assert.equal(insertion.record.id, resourceId(insertion.row, SOURCE_SHA));
    assert.equal(insertion.record.is_public, false);
    assert.deepEqual(insertion.record.allowed_role_ids, []);
    assert.deepEqual(insertion.record.tags, []);
    assert.equal(insertion.record.member_group_id, null);
  }
});

test('the plan retains blocked rows and makes no access, taxonomy, or unrelated existing changes', () => {
  const bundle = savedBundle();
  const plan = planApproved(bundle);

  assert.deepEqual(plan.expected.categories, bundle.before.categories);
  assert.equal(bundle.report.summary.accessChangeRows, 0);
  assert.ok(bundle.report.rows.every(row => !row.accessChange));

  const updateFields = new Set(['title', 'description', 'release_date', 'subcategories']);
  for (const update of plan.updates) {
    assert.deepEqual(
      Object.keys(update.record).filter(key =>
        JSON.stringify(update.record[key]) !== JSON.stringify(update.before[key])).sort(),
      [...updateFields].filter(key =>
        JSON.stringify(update.record[key]) !== JSON.stringify(update.before[key])).sort(),
    );
    assert.equal(update.record.is_public, update.before.is_public);
    assert.deepEqual(update.record.tags, update.before.tags);
    assert.deepEqual(update.record.allowed_role_ids, update.before.allowed_role_ids);
    assert.equal(update.record.status, update.before.status);
    assert.equal(update.record.target_url, update.before.target_url);
    assert.equal(update.record.resource_type, update.before.resource_type);
    assert.equal(update.record.open_in_new_tab, update.before.open_in_new_tab);
    assert.deepEqual(update.record.linked_events, update.before.linked_events);
  }
  assert.ok(plan.skipped.every(({ row }) => bundle.report.rows.find(candidate => candidate.row === row)
    .status === 'blocked'));
});

test('forbidden fields and foreign tenants are rejected before a SQL client is touched', () => {
  const bundle = syntheticBundle();
  const forbidden = clone(bundle);
  forbidden.report.rows.find(row => row.status === 'update').patch.tags = ['must-not-write'];
  assert.throws(() => planApproved(forbidden), /Unapproved update field/);

  const forbiddenAccess = clone(bundle);
  forbiddenAccess.report.rows.find(row => row.status === 'update').patch.is_public = true;
  assert.throws(() => planApproved(forbiddenAccess), /Unapproved update field/);

  const wrongReportTenant = clone(bundle);
  wrongReportTenant.report.tenantId = OTHER_TENANT;
  assert.throws(() => planApproved(wrongReportTenant), /tenant/i);

  const wrongResourceTenant = clone(bundle);
  wrongResourceTenant.before.resources[0].tenant_id = OTHER_TENANT;
  assert.throws(() => planApproved(wrongResourceTenant), /Foreign resource/);

  const wrongCategoryTenant = clone(bundle);
  wrongCategoryTenant.before.categories[0].tenant_id = OTHER_TENANT;
  assert.throws(() => planApproved(wrongCategoryTenant), /Foreign taxonomy/);
});

test('destination drift is detected after locking but before any DML', async () => {
  const bundle = syntheticBundle();
  const client = new FakeSqlClient(bundle.before);
  client.state.resources[0].description = 'Concurrent edit after approval';
  const { entries, journal } = journalEntries();

  await assert.rejects(
    applyApproved({ client, bundle, journal }),
    /Destination changed since approval/,
  );
  assert.equal(client.dml.length, 0);
  assert.equal(client.commitCount, 0);
  assert.equal(client.rollbackCount, 1);
  assert.equal(client.calls[0].sql, 'BEGIN');
  assert.equal(entries.at(-1).status, 'rolled_back');
  assert.equal(entries.at(-1).attemptedWrites, 0);
  assert.ok(client.calls.findIndex(call => call.sql.startsWith('LOCK TABLE ')) >= 0);
});

test('apply locks both tables before writes and preserves all non-approved fields', async () => {
  const bundle = syntheticBundle();
  const client = new FakeSqlClient(bundle.before);
  const { entries, journal } = journalEntries();

  const result = await applyApproved({ client, bundle, journal });
  assert.equal(result.status, 'applied');
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.writes, 2);

  const firstWrite = client.calls.findIndex(call =>
    call.sql.startsWith('INSERT INTO ') || call.sql.startsWith('UPDATE '));
  const tableLock = client.calls.findIndex(call => call.sql.startsWith('LOCK TABLE '));
  const tenantLock = client.calls.findIndex(call => call.sql === 'SELECT id FROM public.tenant WHERE id = $1 FOR SHARE');
  assert.ok(tableLock >= 0 && tableLock < firstWrite);
  assert.ok(tenantLock >= 0 && tenantLock < firstWrite);
  assert.match(client.calls[tableLock].sql, /public\.resource, public\.resource_category/);
  assert.deepEqual(entries.at(-1), {
    status: 'committed',
    writes: 2,
    inserted: 1,
    updated: 1,
  });

  const after = await sqlSnapshot(client);
  assert.deepEqual(after.categories, [...bundle.before.categories].sort(byId));
  assert.equal(after.resources.length, 2);
  const storedUpdate = after.resources.find(resource => resource.id === 'synthetic-existing-resource');
  assert.equal(storedUpdate.is_public, false);
  assert.deepEqual(storedUpdate.tags, ['keep-this-tag']);
  assert.deepEqual(storedUpdate.allowed_role_ids, []);
  assert.equal(storedUpdate.status, 'active');
  assert.deepEqual(verifyApplied(bundle, after), {
    sourceRows: 2,
    distinctLiteralUrls: 2,
    destinationResources: 2,
    inserts: 0,
    updates: 0,
    unchanged: 2,
    blocked: 0,
    exactMatchRows: 2,
    identityMatchRows: 0,
    unmatchedRows: 0,
    coreChangeRows: 0,
    accessChangeRows: 0,
    yearOnlyRows: 0,
    databaseWrites: 0,
  });
});

test('a post-DML verification error rolls back before commit', async () => {
  const bundle = syntheticBundle();
  const client = new FakeSqlClient(bundle.before, { corruptInsert: true });
  const original = clone(client.state);
  const { entries, journal } = journalEntries();

  await assert.rejects(
    applyApproved({ client, bundle, journal }),
    /Unexpected data or access changes/,
  );
  assert.equal(client.dml.length, 2);
  assert.equal(client.commitCount, 0);
  assert.equal(client.rollbackCount, 1);
  assert.deepEqual(client.state, original);
  assert.equal(client.transaction, null);
  assert.equal(entries.at(-1).status, 'rolled_back');
  assert.equal(entries.at(-1).attemptedWrites, 2);
  assert.equal(entries.at(-1).confirmedWrites, 0);
  assert.equal(client.calls.filter(call => call.sql === 'COMMIT').length, 0);
});

test('an unknown commit outcome is journaled for reconciliation', async () => {
  const bundle = syntheticBundle();
  const client = new FakeSqlClient(bundle.before);
  const originalQuery = client.query.bind(client);
  let commitFailed = false;
  client.query = async (sql, params) => {
    if (sql === 'COMMIT' && !commitFailed) {
      commitFailed = true;
      const result = await originalQuery(sql, params);
      client.committedDespiteError = true;
      throw new Error('connection lost after COMMIT');
    }
    return originalQuery(sql, params);
  };
  const { entries, journal } = journalEntries();

  await assert.rejects(
    applyApproved({ client, bundle, journal }),
    /connection lost after COMMIT/,
  );
  assert.equal(client.committedDespiteError, true);
  assert.equal(client.commitCount, 1);
  assert.equal(client.rollbackCount, 1);
  assert.deepEqual(entries.at(-1), {
    status: 'commit_outcome_requires_reconciliation',
    attemptedWrites: 2,
    confirmedWrites: null,
    error: 'connection lost after COMMIT',
  });
  assertSnapshot(await sqlSnapshot(client), planApproved(bundle).expected);
});

test('an exact-after replay takes the zero-write path', async () => {
  const bundle = syntheticBundle();
  const client = new FakeSqlClient(bundle.before);
  const firstJournal = journalEntries();
  const first = await applyApproved({ client, bundle, journal: firstJournal.journal });
  const dmlCount = client.dml.length;
  const replayJournal = journalEntries();

  const replay = await applyApproved({ client, bundle, journal: replayJournal.journal });

  assert.equal(first.writes, 2);
  assert.equal(replay.status, 'already_applied');
  assert.equal(replay.writes, 0);
  assert.equal(replay.inserted, 0);
  assert.equal(replay.updated, 0);
  assert.equal(client.dml.length, dmlCount);
  assert.equal(client.commitCount, 1);
  assert.equal(client.rollbackCount, 1);
  assert.deepEqual(replayJournal.entries, [{ status: 'already_applied', writes: 0 }]);
  assertSnapshot(await sqlSnapshot(client), planApproved(bundle).expected);
});

test('verifyApplied accepts the exact approved post-apply snapshot from the saved bundle', () => {
  const bundle = savedBundle();
  const plan = planApproved(bundle);

  assert.deepEqual(verifyApplied(bundle, plan.expected), {
    sourceRows: 1445,
    distinctLiteralUrls: 1441,
    destinationResources: 2859,
    inserts: 0,
    updates: 0,
    unchanged: 1358,
    blocked: 87,
    exactMatchRows: 1354,
    identityMatchRows: 4,
    unmatchedRows: 87,
    coreChangeRows: 0,
    accessChangeRows: 0,
    yearOnlyRows: 1445,
    databaseWrites: 0,
  });

  const changedAccess = clone(plan.expected);
  changedAccess.resources.find(resource => resource.id === plan.inserts[0].record.id).is_public = true;
  assert.throws(() => verifyApplied(bundle, changedAccess), /Unexpected data or access changes/);

  const changedTaxonomy = clone(plan.expected);
  changedTaxonomy.categories[0].subcategories.push('Unapproved taxonomy');
  assert.throws(() => verifyApplied(bundle, changedTaxonomy), /Unexpected data or access changes/);

  const changedExistingField = clone(plan.expected);
  changedExistingField.resources.find(resource => resource.id === plan.updates[0].record.id)
    .tags.push('Unapproved tag');
  assert.throws(() => verifyApplied(bundle, changedExistingField), /Unexpected data or access changes/);
});