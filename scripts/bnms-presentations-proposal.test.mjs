import assert from 'node:assert/strict';
import test from 'node:test';
import XLSX from 'xlsx';
import {
  HEADERS,
  TENANT_ID,
  aliases,
  buildReport,
  dateValue,
  link,
  marker,
  readAll,
  readWorkbook,
} from './bnms-presentations-proposal.mjs';

const YOUTUBE_ID = 'AbCdEfGhIJK';
const SECOND_YOUTUBE_ID = 'ZxYwVuTsRQP';
const DRIVE_ID = 'drive_File-123';

function taxonomy({
  collections = ['Events'],
  resourceTypes = ['Presentations'],
  focusAreas = ['Management & Workforce', 'Artificial intelligence', 'Oncology'],
} = {}) {
  return [
    {
      id: 'collection-category',
      tenant_id: TENANT_ID,
      name: 'Collection',
      subcategories: [...collections],
    },
    {
      id: 'resource-type-category',
      tenant_id: TENANT_ID,
      name: 'Resource Type',
      subcategories: [...resourceTypes],
    },
    {
      id: 'focus-area-category',
      tenant_id: TENANT_ID,
      name: 'Focus Area',
      subcategories: [...focusAreas],
    },
  ];
}

function source({
  url = `https://www.youtube.com/watch?v=${YOUTUBE_ID}`,
  title = 'Synthetic presentation',
  description = 'Synthetic description',
  date = '2025-01-02',
  memberOnly = 'No',
  collection = 'Events',
  resourceType = 'Presentations',
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
    checksum: 'synthetic-presentations-checksum',
    rows: rows.map(({ row = 2, source: cells, hyperlinks = {} }) => ({
      row,
      source: { ...cells },
      hyperlinks: { ...hyperlinks },
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
    subcategories: ['Events', 'Presentations'],
    tags: [`tag-${id}`],
    allowed_role_ids: [],
    status: 'active',
    open_in_new_tab: true,
    linked_events: [],
    folder_id: null,
    is_public: true,
    ...extra,
  };
}

function xlsxBuffer({ headers = HEADERS, rows = [], hyperlink } = {}) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  if (hyperlink) {
    const column = headers.indexOf('Resource URL');
    if (column >= 0) {
      sheet[XLSX.utils.encode_cell({ r: 1, c: column })].l = { Target: hyperlink };
    }
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Resources');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

test('readWorkbook parses reordered headers and rejects omission and duplication', () => {
  const row = Array(HEADERS.length).fill('');
  row[HEADERS.indexOf('Resource URL')] = `https://youtu.be/${YOUTUBE_ID}`;
  row[HEADERS.indexOf('Title')] = 'Workbook title';
  const parsed = readWorkbook(xlsxBuffer({
    rows: [row],
    hyperlink: `https://youtu.be/${YOUTUBE_ID}`,
  }));

  assert.deepEqual(parsed.headers, HEADERS);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].row, 2);
  assert.equal(parsed.rows[0].source['Resource URL'], `https://youtu.be/${YOUTUBE_ID}`);
  assert.equal(parsed.rows[0].source.Title, 'Workbook title');
  assert.equal(
    parsed.rows[0].hyperlinks['Resource URL'],
    `https://youtu.be/${YOUTUBE_ID}`,
  );

  const reordered = [...HEADERS];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  const reorderedRow = Array(reordered.length).fill('');
  reorderedRow[reordered.indexOf('Resource URL')] = `https://youtu.be/${YOUTUBE_ID}`;
  reorderedRow[reordered.indexOf('Title')] = 'Reordered title';
  const reorderedParsed = readWorkbook(xlsxBuffer({
    headers: reordered,
    rows: [reorderedRow],
  }));
  assert.deepEqual(reorderedParsed.headers, reordered);
  assert.equal(
    reorderedParsed.rows[0].source['Resource URL'],
    `https://youtu.be/${YOUTUBE_ID}`,
  );
  assert.equal(reorderedParsed.rows[0].source.Title, 'Reordered title');

  assert.throws(
    () => readWorkbook(xlsxBuffer({ headers: HEADERS.slice(0, -1) })),
    /Unexpected or duplicate headers/,
  );

  const duplicated = [...HEADERS];
  duplicated[duplicated.length - 1] = duplicated[0];
  assert.throws(
    () => readWorkbook(xlsxBuffer({ headers: duplicated })),
    /Unexpected or duplicate headers/,
  );
});

test('marker semantics distinguish Yes from x and preserve taxonomy aliases', () => {
  assert.equal(marker('Yes'), true);
  assert.equal(marker(' yes '), true);
  assert.equal(marker('No'), false);
  assert.equal(marker(''), false);
  assert.equal(marker('x'), null);

  assert.equal(aliases['Management and Workforce'], 'Management & Workforce');
  assert.equal(aliases['Artificial Intelligence'], 'Artificial intelligence');

  const report = buildReport(
    workbook([{
      row: 7,
      source: source({
        memberOnly: 'Yes',
        focus: [],
        values: {
          'Management and Workforce': 'Yes',
          'Artificial Intelligence': 'Yes',
          Oncology: 'x',
        },
      }),
    }]),
    [],
    taxonomy(),
  );
  const result = report.rows[0];

  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.includes('invalid_marker:Oncology'));
  assert.deepEqual(result.selected, {
    Collection: ['Events'],
    'Resource Type': ['Presentations'],
    'Focus Area': ['Artificial intelligence', 'Management & Workforce'],
  });
  assert.equal(result.proposed.is_public, false);
  assert.ok(result.proposed.subcategories.includes('Artificial intelligence'));
  assert.ok(result.proposed.subcategories.includes('Management & Workforce'));
  assert.ok(!result.proposed.subcategories.includes('Oncology'));
});

test('dateValue distinguishes year approval, Excel serials, calendar dates, and invalid dates', () => {
  assert.deepEqual(dateValue('2025'), {
    value: '2025-01-01',
    kind: 'year_only_requires_approval',
  });
  assert.deepEqual(dateValue(46002), {
    value: '2025-12-11',
    kind: 'excel_serial',
  });
  assert.deepEqual(dateValue('11/12/2025'), {
    value: '2025-12-11',
    kind: 'calendar_date',
  });
  assert.deepEqual(dateValue(' 29 Jun 2022 '), {
    value: '2022-06-29',
    kind: 'calendar_date',
  });

  for (const value of [
    '',
    null,
    undefined,
    46002.5,
    '2025-02-29',
    '31/04/2025',
    '2025/12/11',
    '1800',
    'not-a-date',
  ]) {
    assert.deepEqual(dateValue(value), {
      value: null,
      kind: value === '' || value === null || value === undefined ? 'blank' : 'invalid',
    }, String(value));
  }

  const report = buildReport(
    workbook([
      {
        row: 2,
        source: source({ date: '2025' }),
      },
      {
        row: 3,
        source: source({
          url: `https://youtu.be/${SECOND_YOUTUBE_ID}`,
          date: '2025-02-29',
        }),
      },
    ]),
    [],
    taxonomy(),
  );
  assert.equal(report.rows[0].date.kind, 'year_only_requires_approval');
  assert.equal(report.rows[0].status, 'insert');
  assert.equal(report.rows[1].status, 'blocked');
  assert.ok(report.rows[1].issues.includes('invalid_date'));
  assert.equal(report.summary.yearOnlyRows, 1);
});

test('missing access is blocked and does not infer public visibility', () => {
  const report = buildReport(
    workbook([{
      row: 11,
      source: source({ memberOnly: '   ' }),
    }]),
    [],
    taxonomy(),
  );
  const result = report.rows[0];

  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.includes('missing_or_invalid_access'));
  assert.equal(result.proposed.is_public, null);
  assert.equal(result.accessChange, false);
});

test('link recognizes Drive and YouTube identities while rejecting malicious hosts', () => {
  assert.deepEqual(
    link(`https://www.youtube.com/watch?v=${YOUTUBE_ID}`),
    { valid: true, identity: `youtube:${YOUTUBE_ID}`, kind: 'youtube' },
  );
  assert.deepEqual(
    link(`https://youtu.be/${YOUTUBE_ID}`),
    { valid: true, identity: `youtube:${YOUTUBE_ID}`, kind: 'youtube' },
  );

  for (const url of [
    `https://drive.google.com/file/d/${DRIVE_ID}/view`,
    `https://docs.google.com/presentation/d/${DRIVE_ID}/edit`,
    `https://drive.google.com/open?id=${DRIVE_ID}`,
  ]) {
    assert.deepEqual(
      link(url),
      { valid: true, identity: `drive:${DRIVE_ID}`, kind: 'drive_file' },
      url,
    );
  }

  assert.deepEqual(
    link('https://drive.google.com/drive/u/1/folders/folder_ABC-123/'),
    { valid: true, identity: 'folder:folder_ABC-123', kind: 'shared_folder' },
  );

  for (const url of [
    `https://www.youtube.com.evil.example/watch?v=${YOUTUBE_ID}`,
    `https://drive.google.com.evil.example/file/d/${DRIVE_ID}/view`,
  ]) {
    assert.deepEqual(link(url), { valid: true, identity: null, kind: 'other' }, url);
  }
  for (const url of [
    `https://user:password@www.youtube.com/watch?v=${YOUTUBE_ID}`,
    `https://drive.google.com:8443/file/d/${DRIVE_ID}/view`,
    `javascript:alert(1)`,
  ]) {
    assert.deepEqual(link(url), { valid: false, identity: null }, url);
  }
});

test('Drive and YouTube provider identities match without changing the stored URL', () => {
  const driveSourceUrl = `https://docs.google.com/presentation/d/${DRIVE_ID}/edit`;
  const report = buildReport(
    workbook([
      { row: 2, source: source() },
      {
        row: 3,
        source: source({
          url: driveSourceUrl,
          title: 'Drive presentation',
        }),
      },
    ]),
    [
      resource('youtube-resource', `https://youtu.be/${YOUTUBE_ID}`, {
        title: 'Synthetic presentation',
      }),
      resource('drive-resource', `https://drive.google.com/file/d/${DRIVE_ID}/view`, {
        title: 'Drive presentation',
      }),
    ],
    taxonomy(),
  );

  assert.equal(report.rows[0].matchMethod, 'provider_identity');
  assert.deepEqual(report.rows[0].candidateIds, ['youtube-resource']);
  assert.equal(report.rows[1].matchMethod, 'provider_identity');
  assert.deepEqual(report.rows[1].candidateIds, ['drive-resource']);
  assert.equal(report.rows[0].before.target_url, `https://youtu.be/${YOUTUBE_ID}`);
  assert.equal(report.rows[1].before.target_url, `https://drive.google.com/file/d/${DRIVE_ID}/view`);
});

test('shared folders are blocked for individual-link review', () => {
  const folderUrl = 'https://drive.google.com/drive/folders/folder_ABC-123';
  const report = buildReport(
    workbook([{ row: 20, source: source({ url: folderUrl }) }]),
    [],
    taxonomy(),
  );
  const result = report.rows[0];

  assert.equal(result.link.kind, 'shared_folder');
  assert.ok(result.issues.includes('shared_folder_requires_individual_link_review'));
  assert.equal(result.status, 'blocked');
  assert.equal(result.matchMethod, 'none');
});

test('conflicting and identical duplicate source rows require review', () => {
  const conflictReport = buildReport(
    workbook([
      {
        row: 30,
        source: source({ focus: ['Oncology'], title: 'First title' }),
      },
      {
        row: 31,
        source: source({ focus: ['Artificial Intelligence'], title: 'Second title' }),
      },
    ]),
    [],
    taxonomy(),
  );
  assert.equal(conflictReport.duplicateGroups.length, 1);
  assert.deepEqual(conflictReport.duplicateGroups[0], {
    key: `youtube:${YOUTUBE_ID}`,
    rows: [30, 31],
    kind: 'youtube',
    identical: false,
    titles: [{row:30,title:'First title'},{row:31,title:'Second title'}],
    differingFields: ['Title','Artificial Intelligence','Oncology'],
  });
  assert.deepEqual(
    conflictReport.rows.map((row) => row.status),
    ['blocked', 'blocked'],
  );
  assert.ok(conflictReport.rows.every((row) =>
    row.issues.includes('conflicting_source_duplicate')));

  const identicalSource = source({ title: 'Identical title' });
  const identicalReport = buildReport(
    workbook([
      { row: 40, source: identicalSource },
      { row: 41, source: { ...identicalSource } },
    ]),
    [],
    taxonomy(),
  );
  assert.equal(identicalReport.duplicateGroups[0].identical, true);
  assert.ok(identicalReport.rows.every((row) =>
    row.issues.includes('identical_source_duplicate_review')));
});

test('preserves existing tags, classifications, roles, fields, and restrictive access', () => {
  const url = `https://www.youtube.com/watch?v=${YOUTUBE_ID}`;
  const stored = resource('existing', url, {
    title: 'Old title',
    description: 'Old description',
    release_date: '2024-01-01',
    subcategories: ['Events', 'Presentations', 'Existing classification'],
    tags: ['keep-this-tag', 'keep-that-tag'],
    allowed_role_ids: ['role-one', 'role-two'],
    is_public: false,
    status: 'draft',
    open_in_new_tab: false,
    linked_events: ['event-one'],
    folder_id: 'folder-one',
  });
  const report = buildReport(
    workbook([{
      row: 50,
      source: source({
        title: 'New title',
        description: 'New description',
        date: '2025-03-04',
        memberOnly: 'No',
        focus: ['Management and Workforce'],
      }),
    }]),
    [stored],
    taxonomy(),
  );
  const result = report.rows[0];

  assert.equal(result.status, 'update');
  assert.equal(result.accessChange, false);
  assert.equal(result.proposed.is_public, false);
  assert.deepEqual(result.proposed.tags, ['keep-this-tag', 'keep-that-tag']);
  assert.deepEqual(result.proposed.allowed_role_ids, ['role-one', 'role-two']);
  assert.deepEqual(result.proposed.subcategories, [
    'Events',
    'Presentations',
    'Existing classification',
    'Management & Workforce',
  ]);
  assert.equal(result.proposed.status, 'draft');
  assert.equal(result.proposed.open_in_new_tab, false);
  assert.deepEqual(result.proposed.linked_events, ['event-one']);
  assert.equal(result.proposed.folder_id, 'folder-one');
  assert.equal(result.proposed.title, 'New title');
  assert.equal(result.proposed.description, 'New description');
  assert.equal(result.proposed.release_date, '2025-03-04');
  assert.ok(!result.patch.tags);
  assert.ok(!result.patch.allowed_role_ids);
  assert.ok(!result.patch.status);
  assert.ok(!result.patch.is_public);
});

test('ambiguity, title-only matches, and tenant violations are never silently resolved', () => {
  const ambiguousUrl = `https://www.youtube.com/watch?v=${YOUTUBE_ID}`;
  const ambiguous = buildReport(
    workbook([{ row: 60, source: source({ url: ambiguousUrl }) }]),
    [
      resource('exact-match', ambiguousUrl, { title: 'Exact' }),
      resource('identity-match', `https://youtu.be/${YOUTUBE_ID}`, { title: 'Identity' }),
    ],
    taxonomy(),
  );
  assert.equal(ambiguous.rows[0].status, 'blocked');
  assert.ok(ambiguous.rows[0].issues.includes('multiple_destination_matches'));
  assert.deepEqual(ambiguous.rows[0].candidateIds, ['exact-match', 'identity-match']);
  assert.equal(ambiguous.rows[0].before, null);

  const titleOnly = buildReport(
    workbook([{
      row: 61,
      source: source({
        url: 'https://example.org/a-new-url',
        title: 'Existing title only',
      }),
    }]),
    [resource('title-only', 'https://example.org/old-url', { title: 'Existing title only' })],
    taxonomy(),
  );
  assert.equal(titleOnly.rows[0].status, 'blocked');
  assert.deepEqual(titleOnly.rows[0].titleCandidates, ['title-only']);
  assert.ok(titleOnly.rows[0].issues.includes('title_only_candidate_requires_review'));
  assert.equal(titleOnly.rows[0].before, null);

  assert.throws(
    () => buildReport(
      workbook([]),
      [resource('wrong-tenant-resource', 'https://example.org/resource', {
        tenant_id: 'another-tenant',
      })],
      taxonomy(),
    ),
    /Tenant isolation violation/,
  );
  assert.throws(
    () => buildReport(
      workbook([]),
      [],
      taxonomy().map((category) => ({ ...category, tenant_id: 'another-tenant' })),
    ),
    /Tenant isolation violation/,
  );
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

test('readAll reads more than 1000 rows with count-checked pages and no writes', async () => {
  const rows = Array.from(
    { length: 1201 },
    (_, index) => ({ id: index + 1, value: `row-${index + 1}` }),
  );
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
    tenantFilter: ['tenant_id', TENANT_ID],
    ordering: ['id', { ascending: true }],
    from: 0,
    to: 499,
  });
});

test('readAll surfaces a failed or unavailable count without touching a live database', async (t) => {
  await t.test('count query failure', async () => {
    const client = pagedClient({
      rows: [],
      resultFor: () => ({
        data: null,
        error: { code: 'COUNT_FAILED' },
        count: null,
      }),
    });
    await assert.rejects(
      readAll(client, 'resources', 'id'),
      /resources read failed: COUNT_FAILED/,
    );
  });

  await t.test('missing exact count', async () => {
    const client = pagedClient({
      rows: [],
      resultFor: () => ({ data: [], error: null, count: null }),
    });
    await assert.rejects(
      readAll(client, 'resources', 'id'),
      /resources: inconsistent pagination count/,
    );
  });
});