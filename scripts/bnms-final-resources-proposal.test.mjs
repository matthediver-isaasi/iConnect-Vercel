import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx';
import {
  HEADERS,
  INPUT,
  TENANT_ID,
  TOPIC_HEADERS,
  aliases,
  buildReport,
  dateValue,
  link,
  marker,
  readAll,
  readWorkbook,
  topicMapping,
} from './bnms-final-resources-proposal.mjs';

const DRIVE_ID = 'drive_File-123';
const YOUTUBE_ID = 'AbCdEfGhIJK';

function taxonomy({
  collections = ['Events', 'Working in NM', 'Patient and Carers'],
  resourceTypes = ['Guidelines', 'Educational Resources'],
  focusAreas = [
    'Management',
    'Management & Workforce',
    'Radiopharmacy',
    'Oncology',
  ],
} = {}) {
  return [
    {
      id: 'collection-category',
      tenant_id: TENANT_ID,
      name: 'Collection',
      subcategories: [...collections],
      excluded_role_ids: ['collection-role'],
      subcategory_excluded_role_ids: { Events: ['events-role'] },
    },
    {
      id: 'resource-type-category',
      tenant_id: TENANT_ID,
      name: 'Resource Type',
      subcategories: [...resourceTypes],
      excluded_role_ids: [],
      subcategory_excluded_role_ids: {},
    },
    {
      id: 'focus-area-category',
      tenant_id: TENANT_ID,
      name: 'Focus Area',
      subcategories: [...focusAreas],
      excluded_role_ids: ['focus-role'],
      subcategory_excluded_role_ids: { Radiopharmacy: ['radio-role'] },
    },
  ];
}

function source({
  url = `https://drive.google.com/file/d/${DRIVE_ID}/view`,
  title = 'Synthetic resource',
  description = 'Synthetic description',
  date = '2025-01-02',
  memberOnly = 'Yes',
  collection = 'Events',
  resourceType = 'Guidelines',
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
    Collection: collection,
    'Resource Type': resourceType,
  });
  for (const name of focus) row[name] = 'Yes';
  Object.assign(row, values);
  return row;
}

function workbook(rows) {
  return {
    checksum: 'synthetic-final-resources-checksum',
    headers: HEADERS,
    sheets: [{ name: 'Resources', range: `A1:AL${rows.length + 1}`, handling: 'resource records' }],
    rows: rows.map(({ row = 2, source: cells, hyperlinks = [], formulas = [] }) => ({
      row,
      source: { ...cells },
      hyperlinks,
      formulas,
    })),
  };
}

function resource(id, targetUrl, extra = {}) {
  return {
    id,
    tenant_id: TENANT_ID,
    target_url: targetUrl,
    title: `Stored ${id}`,
    description: `Stored description ${id}`,
    release_date: '2024-01-01T00:00:00.000Z',
    is_public: true,
    subcategories: ['Events', 'Guidelines'],
    tags: [`tag-${id}`],
    allowed_role_ids: [`role-${id}`],
    status: 'draft',
    resource_type: 'external_link',
    open_in_new_tab: false,
    linked_events: ['event-id'],
    folder_id: 'folder-id',
    author_id: 'author-id',
    author_name: 'Author',
    ...extra,
  };
}

function xlsxBuffer({ headers = HEADERS, rows = [], hyperlink, formula } = {}) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const urlColumn = headers.indexOf('Resource URL');
  if (hyperlink && urlColumn >= 0) {
    sheet[XLSX.utils.encode_cell({ r: 1, c: urlColumn })].l = { Target: hyperlink };
  }
  if (formula && urlColumn >= 0) {
    sheet[XLSX.utils.encode_cell({ r: 1, c: urlColumn })].f = formula;
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Resources');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

test('the final Resources mapping uses all 29 actual topic headers', () => {
  assert.equal(HEADERS.length, 38);
  assert.equal(TOPIC_HEADERS.length, 29);
  assert.ok(TOPIC_HEADERS.includes('Management'));
  assert.ok(TOPIC_HEADERS.includes('Radiopharmacy'));
  assert.equal(topicMapping.Management, 'Management');
  assert.equal(topicMapping.Radiopharmacy, 'Radiopharmacy');
  assert.equal(aliases['Management and Workforce'], 'Management & Workforce');
});

test('readWorkbook parses the attached workbook with 530 data rows and blank formulas', () => {
  const parsed = readWorkbook(readFileSync(INPUT));
  assert.equal(parsed.rows.length, 530);
  assert.deepEqual(parsed.headers, HEADERS);
  assert.equal(parsed.rows.reduce((total, row) => total + row.formulas.length, 0), 0);
  assert.equal(parsed.rows.reduce((total, row) => total + row.hyperlinks.length, 0), 189);
  assert.deepEqual(parsed.sheets.map((sheet) => sheet.handling), [
    'resource records',
    'reference only; not imported',
    'reference only; not imported',
  ]);
});

test('readWorkbook rejects missing/duplicate headers but maps reordered actual headers', () => {
  const row = Array(HEADERS.length).fill('');
  row[HEADERS.indexOf('Resource URL')] = `https://youtu.be/${YOUTUBE_ID}`;
  row[HEADERS.indexOf('Title')] = 'Workbook title';
  const parsed = readWorkbook(xlsxBuffer({
    rows: [row],
    hyperlink: `https://youtu.be/${YOUTUBE_ID}`,
  }));
  assert.equal(parsed.rows[0].source.Title, 'Workbook title');
  assert.equal(parsed.rows[0].hyperlinks[0].target, `https://youtu.be/${YOUTUBE_ID}`);

  const reordered = [...HEADERS];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  const reorderedRow = Array(reordered.length).fill('');
  reorderedRow[reordered.indexOf('Resource URL')] = `https://youtu.be/${YOUTUBE_ID}`;
  reorderedRow[reordered.indexOf('Title')] = 'Reordered title';
  const reorderedParsed = readWorkbook(xlsxBuffer({
    headers: reordered,
    rows: [reorderedRow],
  }));
  assert.equal(reorderedParsed.rows[0].source.Title, 'Reordered title');

  assert.throws(
    () => readWorkbook(xlsxBuffer({ headers: HEADERS.slice(0, -1) })),
    /Unexpected or duplicate Resources headers/,
  );
  const duplicated = [...HEADERS];
  duplicated[duplicated.length - 1] = duplicated[0];
  assert.throws(
    () => readWorkbook(xlsxBuffer({ headers: duplicated })),
    /Unexpected or duplicate Resources headers/,
  );
});

test('markers, dates, and conservative Drive/YouTube identities follow approvals', () => {
  assert.equal(marker('Yes'), true);
  assert.equal(marker(' no '), false);
  assert.equal(marker(''), false);
  assert.equal(marker('x'), null);
  assert.deepEqual(dateValue(2025), {
    value: '2025-01-01',
    kind: 'year_only_requires_approval',
  });
  assert.deepEqual(dateValue(46002), {
    value: '2025-12-11',
    kind: 'excel_serial',
  });
  assert.deepEqual(dateValue('31/04/2025'), { value: null, kind: 'invalid' });
  assert.deepEqual(link(`https://drive.google.com/file/d/${DRIVE_ID}/view`), {
    valid: true,
    identity: `drive:${DRIVE_ID}`,
    kind: 'drive_file',
  });
  assert.deepEqual(link(`https://youtu.be/${YOUTUBE_ID}`), {
    valid: true,
    identity: `youtube:${YOUTUBE_ID}`,
    kind: 'youtube',
  });
  assert.deepEqual(link('https://drive.google.com.evil.example/file/d/x'), {
    valid: true,
    identity: null,
    kind: 'other',
  });
  assert.equal(link('javascript:alert(1)').valid, false);
});

test('actual topic headers map additively and preserve restricted/other fields', () => {
  const stored = resource('existing', `https://drive.google.com/file/d/${DRIVE_ID}/view`, {
    title: 'Old title',
    description: 'Keep this when source is blank',
    is_public: false,
    subcategories: ['Events', 'Guidelines', 'Existing classification'],
    tags: ['keep-tag'],
    allowed_role_ids: ['role-one', 'role-two'],
    status: 'draft',
    resource_type: 'download',
    open_in_new_tab: false,
    linked_events: ['event-one'],
    folder_id: 'folder-one',
  });
  const report = buildReport(
    workbook([{
      row: 50,
      source: source({
        date: '2025',
        description: '',
        memberOnly: 'No',
        focus: ['Management', 'Management and Workforce', 'Radiopharmacy'],
      }),
    }]),
    [stored],
    taxonomy(),
  );
  const result = report.rows[0];
  assert.equal(result.status, 'update');
  assert.equal(result.date.kind, 'year_only_requires_approval');
  assert.ok(result.notes.includes('date_year_only_requires_approval'));
  assert.equal(result.accessChange, false);
  assert.equal(result.proposed.is_public, false);
  assert.equal(result.proposed.description, 'Keep this when source is blank');
  assert.deepEqual(result.proposed.tags, ['keep-tag']);
  assert.deepEqual(result.proposed.allowed_role_ids, ['role-one', 'role-two']);
  assert.deepEqual(result.proposed.subcategories, [
    'Events',
    'Guidelines',
    'Existing classification',
    'Management',
    'Management & Workforce',
    'Radiopharmacy',
  ]);
  assert.equal(result.proposed.status, 'draft');
  assert.equal(result.proposed.resource_type, 'download');
  assert.deepEqual(result.coreChanges, ['title', 'release_date']);
  assert.deepEqual(report.summary.coreChangeFields, {
    target_url: 0,
    title: 1,
    description: 0,
    release_date: 1,
  });
});

test('unknown taxonomy is held and never added to proposed subcategories', () => {
  const report = buildReport(
    workbook([{
      row: 70,
      source: source({
        focus: ['Radiopharmacy'],
        values: { Collection: 'Unknown collection' },
      }),
    }]),
    [],
    taxonomy({ collections: ['Events'], focusAreas: ['Oncology'] }),
  );
  const result = report.rows[0];
  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.includes('missing_taxonomy:Collection:Unknown collection'));
  assert.ok(result.issues.includes('missing_taxonomy:Focus Area:Radiopharmacy'));
  assert.deepEqual(result.proposed.subcategories, ['Guidelines']);
  assert.deepEqual(report.missingTaxonomy.sort(), [
    'missing_taxonomy:Collection:Unknown collection',
    'missing_taxonomy:Focus Area:Radiopharmacy',
  ]);
});

test('hyperlink conflicts/formulas are held and identity variants are noted', () => {
  const url = `https://drive.usercontent.google.com/download?id=${DRIVE_ID}&authuser=0`;
  const report = buildReport(
    workbook([{
      row: 80,
      source: source({ url }),
      hyperlinks: [{
        address: 'C80',
        header: 'Resource URL',
        literal: url,
        target: `https://drive.google.com/open?id=${DRIVE_ID}`,
      }],
      formulas: [{ address: 'C80', header: 'Resource URL', formula: 'HYPERLINK(...)' }],
    }]),
    [],
    taxonomy(),
  );
  const result = report.rows[0];
  assert.equal(result.status, 'blocked');
  assert.ok(result.notes.includes('hyperlink_variant_same_identity:C80'));
  assert.ok(result.issues.includes('formula_requires_review'));
});

test('duplicate source identities, multiple destinations, and title-only matches are held', () => {
  const duplicate = source({ title: 'Duplicate first' });
  const duplicateReport = buildReport(
    workbook([
      { row: 90, source: duplicate },
      { row: 91, source: { ...duplicate, Title: 'Duplicate second' } },
    ]),
    [],
    taxonomy(),
  );
  assert.equal(duplicateReport.duplicateGroups.length, 1);
  assert.deepEqual(duplicateReport.duplicateGroups[0].rows, [90, 91]);
  assert.ok(duplicateReport.rows.every((row) => row.status === 'blocked'));
  assert.ok(duplicateReport.rows.every((row) => (
    row.issues.includes('conflicting_source_duplicate')
  )));

  const url = `https://youtu.be/${YOUTUBE_ID}`;
  const multiple = buildReport(
    workbook([{ row: 92, source: source({ url }) }]),
    [
      resource('exact', url),
      resource('identity', `https://www.youtube.com/watch?v=${YOUTUBE_ID}`),
    ],
    taxonomy(),
  );
  assert.equal(multiple.rows[0].status, 'blocked');
  assert.ok(multiple.rows[0].issues.includes('multiple_destination_matches'));
  assert.equal(multiple.rows[0].before, null);

  const titleOnly = buildReport(
    workbook([{ row: 93, source: source({
      url: 'https://example.org/new',
      title: 'Title-only existing',
    }) }]),
    [resource('title-only', 'https://example.org/old', { title: 'Title-only existing' })],
    taxonomy(),
  );
  assert.equal(titleOnly.rows[0].status, 'blocked');
  assert.deepEqual(titleOnly.rows[0].titleCandidates, ['title-only']);
  assert.ok(titleOnly.rows[0].issues.includes('title_only_candidate_requires_review'));
});

function pagedClient({ rows, total = rows.length, resultFor }) {
  const calls = [];
  const client = {
    calls,
    from(table) {
      const query = {
        select(columns, options) {
          query.columns = columns;
          query.options = options;
          return query;
        },
        eq(column, value) {
          query.tenantFilter = [column, value];
          return query;
        },
        order(column, options) {
          query.ordering = [column, options];
          return query;
        },
        range(from, to) {
          calls.push({
            table,
            columns: query.columns,
            options: query.options,
            tenantFilter: query.tenantFilter,
            ordering: query.ordering,
            from,
            to,
          });
          const result = resultFor
            ? resultFor({ table, from, to, calls })
            : { data: rows.slice(from, to + 1), error: null, count: total };
          return Promise.resolve(result);
        },
      };
      return query;
    },
  };
  return client;
}

test('readAll uses ordered exact-count pages and never writes', async () => {
  const rows = Array.from({ length: 1201 }, (_, index) => ({
    id: index + 1,
    tenant_id: TENANT_ID,
  }));
  const client = pagedClient({ rows });
  const result = await readAll(client, 'resource', '*');
  assert.equal(result.total, 1201);
  assert.equal(result.rows.length, 1201);
  assert.deepEqual(result.pages, [500, 500, 201]);
  assert.deepEqual(client.calls.map(({ from, to }) => [from, to]), [
    [0, 499],
    [500, 999],
    [1000, 1499],
  ]);
  assert.ok(client.calls.every((call) => call.options.count === 'exact'));
  assert.ok(client.calls.every((call) => call.ordering[0] === 'id'));
});

test('readAll rejects failed or unavailable exact counts', async (t) => {
  await t.test('read failure', async () => {
    const client = pagedClient({
      rows: [],
      resultFor: () => ({ data: null, error: { code: 'READ_FAILED' }, count: null }),
    });
    await assert.rejects(readAll(client, 'resource', '*'), /resource read failed: READ_FAILED/);
  });
  await t.test('missing count', async () => {
    const client = pagedClient({
      rows: [],
      resultFor: () => ({ data: [], error: null, count: null }),
    });
    await assert.rejects(readAll(client, 'resource', '*'), /resource: inconsistent pagination count/);
  });
});

test('tenant isolation is enforced before a proposal can be built', () => {
  assert.throws(
    () => buildReport(
      workbook([]),
      [resource('foreign', 'https://example.org/foreign', { tenant_id: 'foreign-tenant' })],
      taxonomy(),
    ),
    /Tenant isolation violation/,
  );
});