import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  COLLECTION_ADDITIONS,
  HEADERS,
  INPUT,
  TENANT_ID,
  readWorkbook,
  youtubeId,
} from './bnms-youtube-categorisation.mjs';
import {
  APPROVED_CHECKSUM,
  approvedReport,
  applyApproved,
  sqlSnapshot,
  verifyAfter,
} from './bnms-youtube-categorisation-live.mjs';

const WORKBOOK = readWorkbook(readFileSync(INPUT));
assert.equal(WORKBOOK.checksum, APPROVED_CHECKSUM);
const FOCUS_TAXONOMY = HEADERS.slice(7).map((name) =>
  name === 'Management and Workforce' ? 'Management & Workforce' : name,
);
const OTHER_TENANT = 'other-tenant-not-approved';

const clone = value => structuredClone(value);
const byId = (left, right) => String(left.id).localeCompare(String(right.id));

function tenantRows(rows) {
  return rows.filter(row => row.tenant_id === TENANT_ID).sort(byId);
}

function makeResource(videoId, index) {
  return {
    id: `resource-${videoId}`,
    tenant_id: TENANT_ID,
    target_url: `https://www.youtube.com/watch?v=${videoId}`,
    title: `Stored title ${index + 1}`,
    description: `Stored description ${index + 1}`,
    release_date: `202${index % 5}-0${(index % 9) + 1}-01`,
    is_public: index % 2 === 0,
    subcategories: ['Existing classification'],
    tags: [`preserved-tag-${index + 1}`, 'preserved-second-tag'],
    metadata: {
      source: 'synthetic full resource',
      index,
      nested: { mustRemain: true },
    },
  };
}

function makeCategory(id, name, subcategories, index) {
  return {
    id,
    tenant_id: TENANT_ID,
    name,
    subcategories,
    description: `Synthetic ${name} category`,
    metadata: { source: 'synthetic full taxonomy', index },
  };
}

function makeFixture(options = {}) {
  const ids = [...new Set(
    WORKBOOK.rows.map(row => youtubeId(row.cells[0])).filter(Boolean),
  )];
  const resources = ids.map(makeResource);
  const categories = [
    makeCategory('category-collection', 'Collection', ['Existing collection'], 0),
    makeCategory('category-resource-type', 'Resource Type', ['Videos'], 1),
    makeCategory('category-focus-area', 'Focus Area', FOCUS_TAXONOMY, 2),
  ];
  const foreignResource = {
    id: 'resource-foreign-tenant',
    tenant_id: OTHER_TENANT,
    target_url: 'https://www.youtube.com/watch?v=Foreign1234',
    title: 'Foreign tenant resource',
    description: 'Must not be read or changed',
    subcategories: ['Foreign classification'],
    tags: ['foreign-tag'],
    metadata: { tenant: OTHER_TENANT },
  };
  const foreignCategory = {
    id: 'category-foreign-tenant',
    tenant_id: OTHER_TENANT,
    name: 'Collection',
    subcategories: ['Foreign collection'],
    description: 'Must not be read or changed',
    metadata: { tenant: OTHER_TENANT },
  };
  const allResources = [...resources, foreignResource];
  const allCategories = [...categories, foreignCategory];
  const client = new MockPg({
    resources: allResources,
    categories: allCategories,
    ...options,
  });
  return {
    client,
    workbook: WORKBOOK,
    before: {
      resources: tenantRows(resources),
      categories: tenantRows(categories),
    },
    foreign: {
      resources: [clone(foreignResource)],
      categories: [clone(foreignCategory)],
    },
    allResources: clone(allResources),
    allCategories: clone(allCategories),
  };
}

class MockPg {
  constructor({ resources, categories, failUpdateAt = null, commitAmbiguous = false }) {
    this.state = { resources: clone(resources), categories: clone(categories) };
    this.transaction = null;
    this.calls = [];
    this.updates = [];
    this.rollbackCount = 0;
    this.failUpdateAt = failUpdateAt;
    this.commitAmbiguous = commitAmbiguous;
    this.committedDespiteError = false;
  }

  async query(sql, params = []) {
    this.calls.push({ sql, params: clone(params) });

    if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE') {
      assert.equal(this.transaction, null, 'mock transaction already open');
      this.transaction = clone(this.state);
      return { rowCount: null, rows: [] };
    }
    if (sql.startsWith('SET LOCAL ')) return { rowCount: null, rows: [] };

    const select = sql.match(/FROM public\.(resource_category|resource) r/);
    if (select) {
      assert.match(sql, /WHERE tenant_id = \$1/, 'snapshot must scope the tenant');
      const table = select[1] === 'resource' ? 'resources' : 'categories';
      const source = this.transaction || this.state;
      const records = source[table]
        .filter(row => row.tenant_id === params[0])
        .sort(byId);
      return { rows: records.map(record => ({ record: clone(record) })) };
    }

    const update = sql.match(/^UPDATE public\.(resource_category|resource) SET subcategories/);
    if (update) {
      assert.ok(this.transaction, 'updates require a transaction');
      assert.match(sql, /WHERE id = \$2 AND tenant_id = \$3\b/, 'update must scope the tenant');
      const table = update[1] === 'resource' ? 'resources' : 'categories';
      const attempted = {
        table: update[1],
        id: params[1],
        tenantId: params[2],
        before: clone(params[3]),
        after: clone(params[0]),
        sql,
      };
      this.updates.push(attempted);
      if (this.failUpdateAt === this.updates.length) {
        throw new Error(`synthetic update failure ${this.updates.length}`);
      }
      const row = this.transaction[table].find(candidate =>
        candidate.id === params[1] &&
        candidate.tenant_id === params[2] &&
        assert.deepEqual(candidate.subcategories, params[3]) === undefined,
      );
      if (!row) return { rowCount: 0, rows: [] };
      row.subcategories = clone(params[0]);
      return { rowCount: 1, rows: [{ id: row.id, subcategories: clone(row.subcategories) }] };
    }

    if (sql === 'COMMIT') {
      assert.ok(this.transaction, 'commit requires a transaction');
      this.state = this.transaction;
      this.transaction = null;
      if (this.commitAmbiguous) {
        this.committedDespiteError = true;
        throw new Error('synthetic connection lost after COMMIT');
      }
      return { rowCount: null, rows: [] };
    }
    if (sql === 'ROLLBACK') {
      this.rollbackCount++;
      this.transaction = null;
      if (this.commitAmbiguous) throw new Error('synthetic connection unavailable');
      return { rowCount: null, rows: [] };
    }
    throw new Error(`Unexpected SQL in mock: ${sql}`);
  }
}

function journalEntries() {
  const entries = [];
  return { entries, journal: entry => entries.push(clone(entry)) };
}

function expectedAfter(before, report) {
  const after = clone(before);
  for (const proposal of report.proposals) {
    if (proposal.proposedPatch) {
      after.resources.find(resource => resource.id === proposal.resourceId).subcategories =
        clone(proposal.resulting.subcategories);
    }
  }
  for (const definition of report.categoryDefinitions) {
    if (definition.additions.length) {
      after.categories.find(category => category.id === definition.id).subcategories =
        clone(definition.resulting);
    }
  }
  return after;
}

test('applyApproved performs additive, tenant-scoped subcategory writes and preserves metadata', async () => {
  const fixture = makeFixture();
  const { entries, journal } = journalEntries();
  const result = await applyApproved({
    client: fixture.client,
    workbook: fixture.workbook,
    before: fixture.before,
    journal,
  });
  const after = await sqlSnapshot(fixture.client);

  assert.equal(result.writes, 190);
  assert.equal(result.report.summary.resolvedResources, 189);
  assert.equal(result.report.summary.categoryDefinitionAdditions, COLLECTION_ADDITIONS.length);
  assert.deepEqual(after, expectedAfter(fixture.before, result.report));
  verifyAfter(fixture.before, after, result.report);

  assert.equal(fixture.client.updates.length, result.writes);
  for (const update of fixture.client.updates) {
    assert.match(update.sql, /SET subcategories = \$1::text\[\]/);
    assert.doesNotMatch(update.sql, /SET .*tags|SET .*title|SET .*description/s);
    assert.equal(update.tenantId, TENANT_ID);
    assert.deepEqual(update.after, [...new Set(update.after)]);
    assert.deepEqual(update.after.slice(0, update.before.length), update.before);
  }
  for (const query of fixture.client.calls.filter(call => call.sql.startsWith('SELECT'))) {
    assert.match(query.sql, /WHERE tenant_id = \$1/);
    assert.equal(query.params[0], TENANT_ID);
  }
  for (const query of fixture.client.calls.filter(call => call.sql.startsWith('UPDATE'))) {
    assert.match(query.sql, /WHERE id = \$2 AND tenant_id = \$3/);
    assert.equal(query.params[2], TENANT_ID);
  }
  assert.deepEqual(
    fixture.client.state.resources.filter(row => row.tenant_id === OTHER_TENANT),
    fixture.foreign.resources,
  );
  assert.deepEqual(
    fixture.client.state.categories.filter(row => row.tenant_id === OTHER_TENANT),
    fixture.foreign.categories,
  );
  assert.deepEqual(entries.at(-1), { status: 'committed', writes: 190 });
});

test('applyApproved rejects a stale locked snapshot before any write', async () => {
  const fixture = makeFixture();
  const originalState = clone(fixture.client.state);
  fixture.client.state.resources.find(row => row.tenant_id === TENANT_ID).subcategories.push('Concurrent edit');
  const { entries, journal } = journalEntries();

  await assert.rejects(
    applyApproved({
      client: fixture.client,
      workbook: fixture.workbook,
      before: fixture.before,
      journal,
    }),
    /Stale proposal: refresh before retrying/,
  );

  assert.equal(fixture.client.updates.length, 0);
  assert.equal(fixture.client.rollbackCount, 1);
  assert.notDeepEqual(fixture.client.state, originalState);
  assert.equal(entries.at(-1).status, 'rolled_back');
  assert.equal(entries.at(-1).attemptedWrites, 0);
  assert.equal(entries.at(-1).confirmedWrites, 0);
  assert.match(entries.at(-1).error, /^Stale proposal: refresh before retrying/);
});

test('applyApproved rolls back all changes after a partial update failure', async () => {
  const fixture = makeFixture({ failUpdateAt: 4 });
  const originalState = clone(fixture.client.state);
  const { entries, journal } = journalEntries();

  await assert.rejects(
    applyApproved({
      client: fixture.client,
      workbook: fixture.workbook,
      before: fixture.before,
      journal,
    }),
    /synthetic update failure 4/,
  );

  assert.equal(fixture.client.updates.length, 4);
  assert.equal(fixture.client.rollbackCount, 1);
  assert.deepEqual(fixture.client.state, originalState);
  assert.equal(entries.filter(entry => entry.status === 'pending_transaction').length, 4);
  assert.equal(entries.filter(entry => entry.status === 'verified_in_transaction').length, 3);
  assert.deepEqual(entries.at(-1), {
    status: 'rolled_back',
    attemptedWrites: 3,
    confirmedWrites: 0,
    error: 'synthetic update failure 4',
  });
});

test('a committed proposal can be replayed with zero writes', async () => {
  const fixture = makeFixture();
  const firstJournal = journalEntries();
  const first = await applyApproved({
    client: fixture.client,
    workbook: fixture.workbook,
    before: fixture.before,
    journal: firstJournal.journal,
  });
  const after = await sqlSnapshot(fixture.client);
  const updatesAfterFirstApply = fixture.client.updates.length;
  const replayJournal = journalEntries();

  const replay = await applyApproved({
    client: fixture.client,
    workbook: fixture.workbook,
    before: after,
    journal: replayJournal.journal,
  });

  assert.equal(first.writes, 190);
  assert.equal(replay.writes, 0);
  assert.equal(fixture.client.updates.length, updatesAfterFirstApply);
  assert.equal(replay.report.summary.classificationUpdates, 0);
  assert.equal(replay.report.summary.categoryDefinitionAdditions, 0);
  assert.deepEqual(replayJournal.entries, [
    { status: 'commit_intent', writes: 0 },
    { status: 'committed', writes: 0 },
  ]);
});

test('a lost COMMIT response records an ambiguous outcome for reconciliation', async () => {
  const fixture = makeFixture({ commitAmbiguous: true });
  const { entries, journal } = journalEntries();

  await assert.rejects(
    applyApproved({
      client: fixture.client,
      workbook: fixture.workbook,
      before: fixture.before,
      journal,
    }),
    /synthetic connection lost after COMMIT/,
  );

  assert.equal(fixture.client.committedDespiteError, true);
  assert.equal(fixture.client.rollbackCount, 1);
  assert.deepEqual(entries.at(-1), {
    status: 'commit_outcome_requires_reconciliation',
    attemptedWrites: 190,
    confirmedWrites: null,
    error: 'synthetic connection lost after COMMIT',
  });
  assert.equal(entries.filter(entry => entry.status === 'commit_intent').length, 1);
  const after = await sqlSnapshot(fixture.client);
  assert.equal(
    after.resources.filter((resource, index) =>
      resource.subcategories.join('|') !== fixture.before.resources[index].subcategories.join('|'),
    ).length,
    189,
  );
});

test('approvedReport guards the workbook checksum and tenant before opening a transaction', async t => {
  await t.test('bad workbook checksum', async () => {
    const fixture = makeFixture();
    const { journal } = journalEntries();

    await assert.rejects(
      applyApproved({
        client: fixture.client,
        workbook: { ...fixture.workbook, checksum: 'not-the-reviewed-workbook' },
        before: fixture.before,
        journal,
      }),
      /Unreviewed workbook/,
    );
    assert.equal(fixture.client.calls.length, 0);
  });

  await t.test('wrong tenant in the approved snapshot', async () => {
    const fixture = makeFixture();
    const wrongTenant = clone(fixture.before);
    wrongTenant.categories[0].tenant_id = OTHER_TENANT;
    const { journal } = journalEntries();

    await assert.rejects(
      applyApproved({
        client: fixture.client,
        workbook: fixture.workbook,
        before: wrongTenant,
        journal,
      }),
      /Wrong tenant/,
    );
    assert.equal(fixture.client.calls.length, 0);
  });
});

test('verifyAfter allows only approved subcategory changes and rejects metadata changes', () => {
  const fixture = makeFixture();
  const report = approvedReport(fixture.workbook, fixture.before);
  const after = expectedAfter(fixture.before, report);

  assert.doesNotThrow(() => verifyAfter(fixture.before, after, report));

  const tampered = clone(after);
  tampered.resources[0].tags.push('unexpected tag');
  assert.throws(
    () => verifyAfter(fixture.before, tampered, report),
    /Unexpected changes outside approved classifications/,
  );
});