import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import XLSX from 'xlsx';
import {
  COLLECTION_ADDITIONS,
  HEADERS,
  INPUT,
  TENANT_ID,
  buildReport,
  parseDate,
  readAll,
  readWorkbook,
  youtubeId,
} from './bnms-youtube-categorisation.mjs';

const VIDEO_URL = 'https://www.youtube.com/watch?v=S4fBE1bUaNE';
const ONCOLOGY_ID = 'S4fBE1bUaNE';
const EVENTS_ID = 'mdEJWne9z-Q';
const AMBIGUOUS_ID = 'AbCdEfGhIJK';
const UNCHANGED_ID = 'ZxYwVuTsRQP';

const focusTaxonomy = HEADERS.slice(7).map((name) =>
  name === 'Management and Workforce' ? 'Management & Workforce' : name,
);

function categories({
  collections = ['Existing Collection'],
  resourceTypes = ['Videos'],
  focusAreas = focusTaxonomy,
} = {}) {
  return [
    { id: 'collection-category', name: 'Collection', subcategories: [...collections] },
    { id: 'resource-type-category', name: 'Resource Type', subcategories: [...resourceTypes] },
    { id: 'focus-area-category', name: 'Focus Area', subcategories: [...focusAreas] },
  ];
}

function cells({
  url = VIDEO_URL,
  title = 'Synthetic video',
  description = 'Synthetic description',
  date = '2025-01-02',
  memberOnly = 'No',
  collection = 'Events',
  resourceType = 'Videos',
  focus = [],
  values = {},
} = {}) {
  const row = Array(HEADERS.length).fill('');
  row[0] = url;
  row[1] = title;
  row[2] = description;
  row[3] = date;
  row[4] = memberOnly;
  row[5] = collection;
  row[6] = resourceType;
  for (const name of focus) row[HEADERS.indexOf(name)] = 'X';
  for (const [name, value] of Object.entries(values)) row[HEADERS.indexOf(name)] = value;
  return row;
}

function workbookRows(rows) {
  return {
    checksum: 'synthetic-workbook-checksum',
    rows: rows.map(({ row, cells: sourceCells, hyperlink }) => ({
      row,
      cells: [...sourceCells],
      ...(hyperlink === undefined ? {} : { hyperlink }),
    })),
  };
}

function xlsxBuffer({
  headers = HEADERS,
  rows = [],
  date1904 = false,
  sheetName = 'Resources',
  hyperlink,
} = {}) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  if (hyperlink) sheet.A2.l = { Target: hyperlink };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  if (date1904) book.Workbook = { WBProps: { date1904: true } };
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function resource(id, target_url, {
  subcategories = ['Events', 'Videos'],
  tags = [`tag-${id}`],
  ...extra
} = {}) {
  return {
    id,
    target_url,
    subcategories: [...subcategories],
    tags: [...tags],
    title: `Stored ${id}`,
    ...extra,
  };
}

test('youtubeId accepts supported URL forms and rejects hostile or malformed URLs', () => {
  const valid = [
    ['https://www.youtube.com/watch?v=AbCdEfGhIJK', 'AbCdEfGhIJK'],
    [' youtube.com/watch?v=AbCdEfGhIJK ', 'AbCdEfGhIJK'],
    ['http://m.youtube.com/watch?v=AbCdEfGhIJK#section', 'AbCdEfGhIJK'],
    ['https://youtu.be/AbCdEfGhIJK', 'AbCdEfGhIJK'],
    ['youtu.be/AbCdEfGhIJK?t=30', 'AbCdEfGhIJK'],
    ['https://youtube-nocookie.com/embed/AbCdEfGhIJK', 'AbCdEfGhIJK'],
    ['https://www.youtube-nocookie.com/live/AbCdEfGhIJK', 'AbCdEfGhIJK'],
    ['https://www.youtube.com/shorts/AbCdEfGhIJK?feature=share', 'AbCdEfGhIJK'],
  ];
  for (const [url, expected] of valid) assert.equal(youtubeId(url), expected, url);

  const hostile = [
    '',
    null,
    'not a URL',
    'javascript:alert(1)',
    '//www.youtube.com/watch?v=AbCdEfGhIJK',
    'https://youtube.com.evil.example/watch?v=AbCdEfGhIJK',
    'https://www.youtube.com.evil/watch?v=AbCdEfGhIJK',
    'https://user:password@www.youtube.com/watch?v=AbCdEfGhIJK',
    'https://www.youtube.com:8443/watch?v=AbCdEfGhIJK',
    'https://www.youtube.com/watch?v=AbCdEfGhIJK&v=ZxYwVuTsRQP',
    'https://www.youtube.com/watch?x=AbCdEfGhIJK',
    'https://www.youtube.com/embed/AbCdEfGhIJK/extra',
    'https://youtu.be/AbCdEfGhIJK/extra',
    'https://youtu.be/too-short',
    'https://www.youtube.com/watch?v=AbCdEfGh!K',
    'https://www.youtube.com/watch?v=AbCdEfGhIJ',
    'https://www.youtube.com/watch?v=AbCdEfGhIJK%00',
  ];
  for (const url of hostile) assert.equal(youtubeId(url), null, url);
});

test('parseDate handles supported Excel and textual dates while rejecting invalid dates', () => {
  assert.equal(parseDate(46002), '2025-12-11');
  assert.equal(parseDate('2025-12-11'), '2025-12-11');
  assert.equal(parseDate('11/12/2025'), '2025-12-11');
  assert.equal(parseDate(' 11 Dec 2025 '), '2025-12-11');
  assert.equal(parseDate('29 jun 2022'), '2022-06-29');

  for (const value of [
    '',
    null,
    undefined,
    60,
    46002.5,
    '2025-02-29',
    '29/02/2025',
    '31/04/2025',
    '2025-13-01',
    '2025/12/11',
    '11 December 2025',
    'not-a-date',
  ]) {
    assert.equal(parseDate(value), null, String(value));
  }
});

test('readWorkbook validates the pinned worksheet, headers, and date system', () => {
  const sourceRow = cells({ url: VIDEO_URL, focus: ['Oncology'] });
  const buffer = xlsxBuffer({ rows: [sourceRow], hyperlink: VIDEO_URL });
  const parsed = readWorkbook(buffer);

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].row, 2);
  assert.deepEqual(parsed.rows[0].cells, sourceRow);
  assert.equal(parsed.rows[0].hyperlink, VIDEO_URL);
  assert.equal(parsed.checksum.length, 64);

  const badHeaders = [...HEADERS];
  badHeaders[0] = 'Video URL (changed)';
  assert.throws(
    () => readWorkbook(xlsxBuffer({ headers: badHeaders })),
    /Workbook headers differ from the reviewed mapping/,
  );
  assert.throws(
    () => readWorkbook(xlsxBuffer({ sheetName: 'Wrong sheet' })),
    /Resources worksheet missing/,
  );
  assert.throws(
    () => readWorkbook(xlsxBuffer({ date1904: true })),
    /1904 date system is not supported/,
  );
});

test('original workbook rows 163 and 324 retain their distinct source semantics', () => {
  const parsed = readWorkbook(readFileSync(INPUT));
  const row163 = parsed.rows.find((row) => row.row === 163);
  const row324 = parsed.rows.find((row) => row.row === 324);

  assert.ok(row163);
  assert.equal(row163.cells[0], row163.cells[1]);
  assert.equal(row163.cells[3], 45404);
  assert.equal(row163.cells[4], 'No ');
  assert.equal(row163.cells[5], 'Events');
  assert.equal(row163.cells[6], 'Videos');

  assert.ok(row324);
  const expectedTypeOnlyCells = Array(HEADERS.length).fill('');
  expectedTypeOnlyCells[6] = 'Videos';
  assert.deepEqual(
    row324.cells.map((value, index) => (index === 6 ? value : String(value))),
    expectedTypeOnlyCells,
  );
  assert.equal(row324.cells[6], 'Videos');

  const report = buildReport(parsed, [], categories());
  const result163 = report.rows.find((row) => row.row === 163);
  const result324 = report.rows.find((row) => row.row === 324);
  assert.equal(result163.status, 'blocked');
  assert.ok(result163.issues.includes('missing_or_malformed_video_link; no title fallback'));
  assert.equal(result163.referenceMapping.release_date, '2024-04-22');
  assert.equal(result163.referenceMapping.is_public, true);
  assert.equal(result324.status, 'ignored_type_only');
});

test('synthetic categories derive focus taxonomy, canonical alias, and approved collections', () => {
  const taxonomy = categories();
  const report = buildReport(
    workbookRows([{
      row: 2,
      cells: cells({ focus: ['Management and Workforce'] }),
    }]),
    [],
    taxonomy,
  );

  assert.deepEqual(report.categoryDefinitions, [{
    id: 'collection-category',
    name: 'Collection',
    current: ['Existing Collection'],
    additions: COLLECTION_ADDITIONS,
    resulting: ['Existing Collection', ...COLLECTION_ADDITIONS],
  }]);
  assert.deepEqual(
    report.rows[0].sourceClassifications['Focus Area'],
    ['Management & Workforce'],
  );
  assert.equal(report.rows[0].status, 'unmatched_review');

  for (const missing of ['Collection', 'Resource Type', 'Focus Area']) {
    const withoutCategory = taxonomy.filter((category) => category.name !== missing);
    assert.throws(
      () => buildReport(workbookRows([]), [], withoutCategory),
      new RegExp(`Missing, ambiguous or invalid taxonomy: ${missing}`),
    );
  }
  assert.throws(
    () => buildReport(workbookRows([]), [], [
      ...taxonomy,
      { id: 'duplicate-focus', name: 'Focus Area', subcategories: [] },
    ]),
    /Missing, ambiguous or invalid taxonomy: Focus Area/,
  );
  assert.throws(
    () => buildReport(workbookRows([]), [], taxonomy.map((category) =>
      category.name === 'Collection' ? { ...category, subcategories: null } : category)),
    /Missing, ambiguous or invalid taxonomy: Collection/,
  );
});

test('unknown markers and taxonomy values block a row without title fallback', () => {
  const row = cells({
    url: 'https://youtu.be/QwErTyUiOpA',
    collection: 'Unapproved Collection',
    focus: ['Management and Workforce'],
    values: { Bone: 'yes' },
  });
  const report = buildReport(
    workbookRows([{ row: 500, cells: row }]),
    [],
    categories({ collections: ['Existing Collection'] }),
  );
  const result = report.rows[0];

  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.includes('unknown_marker:Bone:yes'));
  assert.ok(result.issues.includes('missing_taxonomy:Collection:Unapproved Collection'));
  assert.ok(!result.issues.includes('missing_taxonomy:Focus Area:Management & Workforce'));
  assert.deepEqual(result.sourceClassifications['Focus Area'], ['Management & Workforce']);
});

test('duplicate source rows merge Oncology/Cardiovascular and Events/Patient and Carers', () => {
  const rows = [
    {
      row: 2,
      cells: cells({
        url: `https://www.youtube.com/watch?v=${ONCOLOGY_ID}`,
        focus: ['Oncology'],
      }),
    },
    {
      row: 23,
      cells: cells({
        url: `https://youtu.be/${ONCOLOGY_ID}`,
        focus: ['Cardiovascular'],
      }),
    },
    {
      row: 100,
      cells: cells({
        url: `https://www.youtube.com/watch?v=${EVENTS_ID}&list=first`,
        focus: [],
      }),
    },
    {
      row: 114,
      cells: cells({
        url: `https://www.youtube.com/watch?v=${EVENTS_ID}&list=second`,
        collection: 'Patient and Carers',
        date: '29 Jun 2022',
        focus: [],
      }),
    },
  ];
  const resources = [
    resource('resource-oncology', rows[0].cells[0], {
      subcategories: ['Events', 'Videos', 'Existing Classification'],
      tags: ['keep-oncology-tag'],
    }),
    resource('resource-events', rows[2].cells[0], {
      subcategories: ['Events', 'Videos'],
      tags: ['keep-events-tag'],
    }),
  ];
  const report = buildReport(workbookRows(rows), resources, categories());

  const oncology = report.proposals.find((proposal) => proposal.resourceId === 'resource-oncology');
  assert.deepEqual(oncology.sourceRows, [2, 23]);
  assert.equal(oncology.status, 'classification_update');
  assert.deepEqual(oncology.proposedAdditions, ['Oncology', 'Cardiovascular']);
  assert.deepEqual(oncology.resulting.subcategories, [
    'Events',
    'Videos',
    'Existing Classification',
    'Oncology',
    'Cardiovascular',
  ]);
  assert.deepEqual(oncology.resulting.tags, ['keep-oncology-tag']);
  assert.deepEqual(
    report.rows.filter((row) => [2, 23].includes(row.row)).map((row) => row.status),
    ['classification_update', 'classification_update'],
  );

  const events = report.proposals.find((proposal) => proposal.resourceId === 'resource-events');
  assert.deepEqual(events.sourceRows, [100, 114]);
  assert.equal(events.status, 'classification_update');
  assert.deepEqual(events.proposedAdditions, ['Patient and Carers']);
  assert.deepEqual(events.resulting.subcategories, ['Events', 'Videos', 'Patient and Carers']);
  assert.deepEqual(events.resulting.tags, ['keep-events-tag']);
  assert.deepEqual(
    report.rows.filter((row) => [100, 114].includes(row.row)).map((row) => row.matchMethod),
    ['exact_url', 'youtube_identity'],
  );
  assert.equal(report.summary.duplicateSourceGroups, 2);
});

test('ambiguous exact and normalized database matches are blocked', () => {
  const source = cells({
    url: `https://www.youtube.com/watch?v=${AMBIGUOUS_ID}`,
    focus: ['Oncology'],
  });
  const resources = [
    resource('ambiguous-exact', source[0]),
    resource('ambiguous-normalized', `https://youtu.be/${AMBIGUOUS_ID}`),
  ];
  const report = buildReport(workbookRows([{ row: 700, cells: source }]), resources, categories());
  const result = report.rows[0];

  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.includes('ambiguous_database_matches'));
  assert.deepEqual(result.candidateIds, ['ambiguous-exact', 'ambiguous-normalized']);
  assert.equal(result.resourceId, null);
  assert.equal(report.proposals.length, 0);
});

test('unchanged proposals have no patch and retain existing tags', () => {
  const source = cells({
    url: `https://www.youtube.com/watch?v=${UNCHANGED_ID}`,
    focus: ['Management and Workforce'],
  });
  const resources = [resource('unchanged', source[0], {
    subcategories: ['Events', 'Videos', 'Management & Workforce'],
    tags: ['existing-tag', 'second-tag'],
  })];
  const report = buildReport(workbookRows([{ row: 200, cells: source }]), resources, categories());
  const proposal = report.proposals[0];

  assert.equal(proposal.status, 'unchanged');
  assert.deepEqual(proposal.proposedAdditions, []);
  assert.equal(proposal.proposedPatch, null);
  assert.deepEqual(proposal.resulting, {
    subcategories: ['Events', 'Videos', 'Management & Workforce'],
    tags: ['existing-tag', 'second-tag'],
  });
  assert.equal(report.summary.unchangedResources, 1);
});

test('buildReport does not mutate inputs and is deterministic', () => {
  const workbook = workbookRows([
    { row: 2, cells: cells({ focus: ['Oncology'] }) },
    { row: 3, cells: cells({
      url: `https://youtu.be/${ONCOLOGY_ID}`,
      focus: ['Cardiovascular'],
    }) },
  ]);
  const resources = [resource('immutable', VIDEO_URL, {
    subcategories: ['Events', 'Videos'],
    tags: ['preserve-me'],
  })];
  const taxonomy = categories();
  const before = structuredClone({ workbook, resources, taxonomy });

  const first = buildReport(workbook, resources, taxonomy);
  const second = buildReport(workbook, resources, taxonomy);

  assert.deepEqual({ workbook, resources, taxonomy }, before);
  assert.deepEqual(first, second);
  assert.equal(first.mode, 'READ_ONLY');
  assert.equal(first.tenantId, TENANT_ID);
  assert.equal(first.summary.databaseWrites, 0);
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
          calls.push({ table, columns: query.columns, options: query.options, from, to });
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

test('readAll follows count-checked pages beyond 1000 rows', async () => {
  const rows = Array.from({ length: 1201 }, (_, index) => ({ id: index + 1, value: `row-${index + 1}` }));
  const client = pagedClient({ rows });
  const result = await readAll(client, 'resources', 'id,value');

  assert.equal(result.total, 1201);
  assert.equal(result.rows.length, 1201);
  assert.deepEqual(result.pages, [500, 500, 201]);
  assert.deepEqual(client.calls.map(({ from, to }) => [from, to]), [
    [0, 499],
    [500, 999],
    [1000, 1499],
  ]);
  assert.deepEqual(client.calls[0], {
    table: 'resources',
    columns: 'id,value',
    options: { count: 'exact' },
    from: 0,
    to: 499,
  });
});

test('readAll surfaces query errors, count drift, and repeat or unordered IDs', async (t) => {
  await t.test('query error', async () => {
    const client = pagedClient({
      rows: [],
      total: 0,
      resultFor: () => ({ data: null, error: { code: 'PGRST_TEST' }, count: 0 }),
    });
    await assert.rejects(
      readAll(client, 'resources', 'id'),
      /resources read failed: PGRST_TEST/,
    );
  });

  await t.test('count drift', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ id: index + 1 }));
    const client = pagedClient({
      rows,
      resultFor: ({ from }) => ({
        data: rows.slice(from, from + 500),
        error: null,
        count: from === 0 ? 501 : 502,
      }),
    });
    await assert.rejects(
      readAll(client, 'resources', 'id'),
      /resources: inconsistent pagination count/,
    );
  });

  await t.test('repeat or unordered IDs', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ id: index + 1 }));
    const secondPage = Array.from({ length: 500 }, (_, index) => ({ id: index + 500 }));
    const client = pagedClient({
      rows: [...firstPage, ...secondPage],
      total: 1000,
      resultFor: ({ from }) => ({
        data: from === 0 ? firstPage : secondPage,
        error: null,
        count: 1000,
      }),
    });
    await assert.rejects(
      readAll(client, 'resources', 'id'),
      /resources: repeated\/unordered IDs/,
    );
  });
});