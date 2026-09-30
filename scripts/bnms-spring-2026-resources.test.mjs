import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx';
import {
  HEADERS,
  INPUT,
  RESOURCE_COLUMNS,
  SOURCE_CHECKSUM,
  TENANT_ID,
  buildReport,
  driveId,
  link,
  marker,
  readAll,
  readWorkbook,
} from './bnms-spring-2026-resources-proposal.mjs';
import {
  applyTransaction,
  assertSnapshot,
  planApproved,
  resourceId,
  verifyApplied,
} from './apply-bnms-spring-2026-resources.mjs';

const clone = (value) => structuredClone(value);

function taxonomy() {
  return [
    {
      id: 'collection-category',
      tenant_id: TENANT_ID,
      name: 'Collection',
      subcategories: ['Events'],
    },
    {
      id: 'type-category',
      tenant_id: TENANT_ID,
      name: 'Resource Type',
      subcategories: ['Presentation', 'Posters'],
    },
    {
      id: 'focus-category',
      tenant_id: TENANT_ID,
      name: 'Focus Area',
      subcategories: ['Artificial intelligence', 'Management & Workforce', 'Bone'],
    },
  ];
}

function source({
  url = 'https://drive.usercontent.google.com/download?id=Synthetic-Drive-123',
  title = 'Synthetic resource',
  description = 'Synthetic description',
  date = '',
  memberOnly = 'Yes',
  resourceType = 'Presentation',
  focus = [],
  values = {},
} = {}) {
  const row = Object.fromEntries(HEADERS.map((header) => [header, '']));
  Object.assign(row, {
    'Resource URL': url,
    Title: title,
    'Brief Description': description,
    Date: date,
    'Member Only': memberOnly,
    Collection: 'Events',
    'Resource Type': resourceType,
  });
  for (const name of focus) row[name] = 'Yes';
  Object.assign(row, values);
  return row;
}

function workbook(rows) {
  return {
    checksum: 'synthetic-spring-2026',
    headers: HEADERS,
    sheets: [{ name: 'Resources', range: 'A1:AO3', handling: 'resource records' }],
    rows: rows.map((cells, index) => ({
      row: index + 2,
      source: cells,
      hyperlinks: [],
      formulas: [],
    })),
  };
}

function resource(id, url, extra = {}) {
  return {
    id,
    title: 'Stored title',
    description: 'Stored description',
    subcategories: ['Events', 'Presentation', 'Existing'],
    resource_type: 'external_link',
    target_url: url,
    open_in_new_tab: false,
    image_url: null,
    release_date: '2024-01-01T00:00:00.000Z',
    is_public: true,
    allowed_role_ids: ['role-one'],
    tags: ['preserved-tag'],
    author_id: 'author',
    author_name: 'Author',
    folder_id: 'folder',
    status: 'active',
    tenant_id: TENANT_ID,
    search_text: null,
    linked_events: ['event'],
    seo_title: null,
    seo_description: null,
    og_image_url: null,
    is_sample: false,
    member_group_id: null,
    ...extra,
  };
}

function xlsxBuffer(headers = HEADERS) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, Array(headers.length).fill('')]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Resources');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

test('the pinned workbook has 308 rows, 173 presentations, 135 posters, and blank dates', () => {
  const parsed = readWorkbook(readFileSync(INPUT));
  assert.equal(parsed.checksum, SOURCE_CHECKSUM);
  assert.equal(parsed.rows.length, 308);
  assert.deepEqual(parsed.headers, HEADERS);
  assert.equal(parsed.sheets.map((sheet) => sheet.name).join(','), 'Resources,Lists');
  assert.equal(parsed.rows.filter((row) => row.source['Resource Type'] === 'Presentation').length, 173);
  assert.equal(parsed.rows.filter((row) => row.source['Resource Type'] === 'Posters').length, 135);
  assert.equal(parsed.rows.filter((row) => String(row.source.Date).trim()).length, 0);
  assert.equal(new Set(parsed.rows.map((row) => row.source['Resource URL'])).size, 308);
  assert.equal(parsed.rows.filter((row) => driveId(row.source['Resource URL'])).length, 307);
  assert.equal(parsed.rows.filter((row) => !driveId(row.source['Resource URL'])).length, 1);
  assert.ok(parsed.rows.find((row) => !driveId(row.source['Resource URL']))
    .source['Resource URL'].startsWith('ttps://'));
  assert.equal(parsed.rows.reduce((count, row) => count + row.formulas.length, 0), 0);
});

test('header changes are rejected while the source mapping remains explicit', () => {
  assert.throws(() => readWorkbook(xlsxBuffer(HEADERS.slice(0, -1))), /Unexpected or duplicate/);
  const duplicate = [...HEADERS];
  duplicate[duplicate.length - 1] = duplicate[0];
  assert.throws(() => readWorkbook(xlsxBuffer(duplicate)), /Unexpected or duplicate/);
  assert.equal(marker('Yes'), true);
  assert.equal(marker(' no '), false);
  assert.equal(marker('unexpected'), null);
  assert.equal(link('https://drive.usercontent.google.com/download?id=Drive_123456').identity, 'drive:Drive_123456');
});

test('blank dates preserve existing values while access and Download are explicit changes', () => {
  const url = 'https://drive.usercontent.google.com/download?id=Synthetic-Drive-123';
  const stored = resource('existing', url);
  const report = buildReport(workbook([source({ url, description: '', focus: ['Artificial Intelligence'] })]), [stored], taxonomy());
  const row = report.rows[0];
  assert.equal(row.status, 'update');
  assert.equal(row.date.kind, 'blank');
  assert.equal(row.proposed.release_date, stored.release_date);
  assert.equal(row.proposed.description, stored.description);
  assert.equal(row.proposed.is_public, false);
  assert.equal(row.proposed.resource_type, 'download');
  assert.deepEqual(row.proposed.allowed_role_ids, ['role-one']);
  assert.deepEqual(row.proposed.tags, ['preserved-tag']);
  assert.ok(row.proposed.subcategories.includes('Artificial intelligence'));
  assert.equal(row.accessChange, true);
  assert.equal(row.displayTypeChange, true);
});

test('unknown taxonomy, title-only identity, and ambiguous Drive matches are blocked', () => {
  const unknown = buildReport(
    workbook([source({ focus: ['Highlights'] })]),
    [],
    taxonomy(),
  );
  assert.equal(unknown.rows[0].status, 'blocked');
  assert.ok(unknown.rows[0].issues.includes('missing_taxonomy:Focus Area:Highlights'));

  const titleOnly = buildReport(
    workbook([source({ url: 'https://example.org/new', title: 'Stored title' })]),
    [resource('old', 'https://example.org/old')],
    taxonomy(),
  );
  assert.equal(titleOnly.rows[0].status, 'blocked');
  assert.ok(titleOnly.rows[0].issues.includes('title_only_candidate_requires_review'));

  const url = 'https://drive.usercontent.google.com/download?id=Ambiguous-123456';
  const ambiguous = buildReport(
    workbook([source({ url })]),
    [
      resource('one', url),
      resource('two', 'https://drive.google.com/file/d/Ambiguous-123456/view'),
    ],
    taxonomy(),
  );
  assert.equal(ambiguous.rows[0].status, 'blocked');
  assert.ok(ambiguous.rows[0].issues.includes('multiple_destination_matches'));
});

function pagedClient(rows) {
  const calls = [];
  return {
    calls,
    from(table) {
      const query = {
        select(columns, options) {
          query.columns = columns;
          query.options = options;
          return query;
        },
        eq(column, value) {
          query.filter = [column, value];
          return query;
        },
        order(column, options) {
          query.ordering = [column, options];
          return query;
        },
        range(from, to) {
          calls.push({ table, from, to, options: query.options, ordering: query.ordering });
          return Promise.resolve({
            data: rows.slice(from, to + 1),
            error: null,
            count: rows.length,
          });
        },
      };
      return query;
    },
  };
}

test('readAll uses ordered exact-count pagination beyond 1000 rows', async () => {
  const rows = Array.from({ length: 1201 }, (_, index) => ({
    id: String(index + 1).padStart(4, '0'),
    tenant_id: TENANT_ID,
  }));
  const client = pagedClient(rows);
  const result = await readAll(client, 'resource', '*');
  assert.equal(result.total, 1201);
  assert.equal(result.rows.length, 1201);
  assert.deepEqual(result.pages, [500, 500, 201]);
  assert.deepEqual(client.calls.map(({ from, to }) => [from, to]), [[0, 499], [500, 999], [1000, 1499]]);
  assert.ok(client.calls.every((call) => call.options.count === 'exact'));
  assert.ok(client.calls.every((call) => call.ordering[0] === 'id'));
});

test('plan and replay preserve metadata, apply access override, and verify auth projections', () => {
  const existingUrl = 'https://drive.usercontent.google.com/download?id=Existing-123456';
  const rows = [
    source({ url: existingUrl, title: 'Updated title' }),
    source({ url: 'https://drive.usercontent.google.com/download?id=Inserted-123456', title: 'Inserted title', resourceType: 'Posters' }),
  ];
  const before = {
    tenant: { id: TENANT_ID, name: 'BNMS' },
    resources: [resource('existing', existingUrl)],
    categories: taxonomy(),
  };
  const report = buildReport(workbook(rows), before.resources, before.categories);
  const plan = planApproved({ report, before, sourceChecksum: 'synthetic-spring-2026' });
  assert.equal(plan.inserts.length, 1);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.inserts[0].record.resource_type, 'download');
  assert.equal(plan.updates[0].record.is_public, false);
  assert.equal(plan.updates[0].record.resource_type, 'download');
  assert.equal(plan.updates[0].record.status, 'active');
  assert.deepEqual(plan.updates[0].record.tags, ['preserved-tag']);
  const after = plan.expected;
  const verified = verifyApplied({ workbook: workbook(rows), report, before, plan }, after);
  assert.equal(verified.replay.summary.inserts, 0);
  assert.equal(verified.replay.summary.updates, 0);
  assert.equal(verified.authorization.checked, 2);
  assert.equal(verified.authorization.locked, 2);
  assert.equal(verified.authorization.publicTargetSuppressed, 2);
  assert.equal(verified.authorization.activeMemberVisible, 2);
  assert.equal(resourceId(2, 'synthetic-spring-2026'), resourceId(2, 'synthetic-spring-2026'));
  assert.notEqual(resourceId(2, 'synthetic-spring-2026'), resourceId(3, 'synthetic-spring-2026'));
});

class FakeSqlClient {
  constructor(snapshot) {
    this.state = { resources: clone(snapshot.resources), categories: clone(snapshot.categories) };
    this.transaction = null;
    this.dml = [];
    this.calls = [];
    this.commitCount = 0;
    this.rollbackCount = 0;
  }

  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (sql === 'BEGIN') {
      this.transaction = clone(this.state);
      return { rowCount: null, rows: [] };
    }
    if (sql.startsWith('SET LOCAL ') || sql.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rowCount: null, rows: [] };
    }
    if (sql.startsWith('LOCK TABLE ')) return { rowCount: null, rows: [] };
    if (sql === 'SELECT id FROM public.tenant WHERE id = $1 FOR SHARE') {
      return { rowCount: 1, rows: [{ id: TENANT_ID }] };
    }
    if (sql === 'SELECT id, name FROM public.tenant WHERE id = $1') {
      return { rowCount: 1, rows: [{ id: TENANT_ID, name: 'BNMS' }] };
    }
    if (sql.startsWith('SELECT column_name FROM information_schema.columns')) {
      return {
        rowCount: sql.includes("table_name='resource_category'") ? 10 : RESOURCE_COLUMNS.length,
        rows: (sql.includes("table_name='resource_category'") ? [
          'id', 'name', 'description', 'subcategories', 'display_order', 'is_active',
          'applies_to_content_types', 'tenant_id', 'excluded_role_ids', 'subcategory_excluded_role_ids',
        ] : RESOURCE_COLUMNS).map((column_name) => ({ column_name })),
      };
    }
    if (sql.startsWith('SELECT data_type, udt_name')) {
      return { rowCount: 1, rows: [{ data_type: 'text', udt_name: 'text' }] };
    }
    if (sql.startsWith('SELECT 1 FROM public.resource')) {
      return { rowCount: 1, rows: [{ '?column?': 1 }] };
    }
    if (sql.startsWith('SELECT tgname FROM pg_trigger')) {
      return { rowCount: 0, rows: [] };
    }
    const snapshotMatch = sql.match(/FROM public\.(resource_category|resource) r/);
    if (snapshotMatch) {
      const key = snapshotMatch[1] === 'resource' ? 'resources' : 'categories';
      return {
        rowCount: this.transaction[key].length,
        rows: this.transaction[key]
          .filter((row) => row.tenant_id === params[0])
          .sort((left, right) => String(left.id).localeCompare(String(right.id)))
          .map((record) => ({ record: clone(record) })),
      };
    }
    if (sql.startsWith('INSERT INTO public.resource ')) {
      const records = JSON.parse(params[0]);
      this.transaction.resources.push(...clone(records));
      this.dml.push({ type: 'insert', records });
      return { rowCount: records.length, rows: records.map((record) => ({ id: record.id })) };
    }
    if (sql.startsWith('UPDATE public.resource ')) {
      const records = JSON.parse(params[0]);
      for (const record of records) {
        const current = this.transaction.resources.find((item) => item.id === record.id);
        assert.deepEqual(current, record.before);
        Object.assign(current, {
          title: record.title,
          description: record.description,
          release_date: record.release_date,
          subcategories: record.subcategories,
          is_public: record.is_public,
          resource_type: record.resource_type,
        });
      }
      this.dml.push({ type: 'update', records });
      return { rowCount: records.length, rows: records.map((record) => ({ id: record.id })) };
    }
    if (sql === 'COMMIT') {
      this.state = this.transaction;
      this.transaction = null;
      this.commitCount += 1;
      return { rowCount: null, rows: [] };
    }
    if (sql === 'ROLLBACK') {
      this.transaction = null;
      this.rollbackCount += 1;
      return { rowCount: null, rows: [] };
    }
    throw new Error(`Unexpected SQL in fake client: ${sql}`);
  }
}

test('atomic application rejects destination drift before DML and replay is zero-write', async () => {
  const url = 'https://drive.usercontent.google.com/download?id=Atomic-123456';
  const before = {
    tenant: { id: TENANT_ID, name: 'BNMS' },
    resources: [resource('existing', url)],
    categories: taxonomy(),
  };
  const sourceRows = [source({ url, title: 'Atomic update' })];
  const report = buildReport(workbook(sourceRows), before.resources, before.categories);
  const plan = planApproved({ report, before, sourceChecksum: 'atomic' });
  const bundle = { workbook: workbook(sourceRows), report, before, plan };
  const drifted = new FakeSqlClient(before);
  drifted.state.resources[0].description = 'Concurrent edit';
  const driftJournal = [];
  await assert.rejects(
    applyTransaction({ client: drifted, bundle, journal: (entry) => driftJournal.push(entry) }),
    /SQL destination drift/,
  );
  assert.equal(drifted.dml.length, 0);
  assert.equal(drifted.commitCount, 0);
  assert.equal(driftJournal.at(-1).status, 'rolled_back');

  const client = new FakeSqlClient(before);
  const journal = [];
  const first = await applyTransaction({ client, bundle, journal: (entry) => journal.push(entry) });
  assert.equal(first.status, 'applied');
  assert.equal(first.writes, 1);
  const dmlCount = client.dml.length;
  const replay = await applyTransaction({ client, bundle, journal: (entry) => journal.push(entry) });
  assert.equal(replay.status, 'already_applied');
  assert.equal(replay.writes, 0);
  assert.equal(client.dml.length, dmlCount);
  assert.equal(client.commitCount, 1);
  assertSnapshot(await (async () => ({
    tenant: before.tenant,
    resources: client.state.resources,
    categories: client.state.categories,
  }))(), plan.expected);
});