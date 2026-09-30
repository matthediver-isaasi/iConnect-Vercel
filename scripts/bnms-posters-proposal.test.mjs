import assert from 'node:assert/strict';
import test from 'node:test';
import XLSX from 'xlsx';
import {
  HEADERS,
  TENANT_ID,
  buildReport,
  driveId,
  readAll,
  readWorkbook,
  yearDate,
} from './bnms-posters-proposal.mjs';

test('semantically equal dates preserve exact storage representation and disclose every difference', () => {
  const s = source();
  const before = {id:'resource-1',tenant_id:TENANT_ID,title:s.Title,description:s['Brief Description'],
    target_url:s['Resource URL'],release_date:'2025-01-01T00:00:00+00:00',is_public:true,
    resource_type:'external_link',subcategories:['Posters'],tags:['retained'],allowed_role_ids:['role-1']};
  const report = buildReport(workbookRows([{row:2,source:s}]),[before],categories());
  const r = report.rows[0];
  assert.equal(r.proposed.release_date,before.release_date);
  for (const [key,value] of Object.entries(r.proposed)) if (JSON.stringify(value)!==JSON.stringify(before[key])) assert.ok(r.changes[key]);
  assert.deepEqual(report,buildReport(workbookRows([{row:2,source:s}]),[before],categories()));
});

const FILE_A = 'AbCdEfGhIjK';
const FILE_B = 'BcDeFgHiJkL';
const FILE_C = 'CdEfGhIjKlM';
const FOLDER_A = 'FolderAbCdE';
const FOLDER_B = 'FolderBcDeF';

function categories({ tenantId = TENANT_ID } = {}) {
  const focusAreas = HEADERS.slice(9).map((name) =>
    name === 'Management and Workforce' ? 'Management & Workforce' : name,
  );
  return [
    {
      id: 'collection-category',
      tenant_id: tenantId,
      name: 'Collection',
      subcategories: ['Events'],
    },
    {
      id: 'resource-type-category',
      tenant_id: tenantId,
      name: 'Resource Type',
      subcategories: ['Posters'],
    },
    {
      id: 'focus-area-category',
      tenant_id: tenantId,
      name: 'Focus Area',
      subcategories: focusAreas,
    },
  ];
}

function source({
  pageUrl = `https://drive.google.com/drive/folders/${FOLDER_A}`,
  menuItem = 'Posters',
  url = `https://drive.google.com/file/d/${FILE_A}/view`,
  title = 'Synthetic poster',
  description = 'Synthetic description',
  date = '2025',
  memberOnly = 'Yes',
  collection = 'Events',
  resourceType = 'Posters',
  topicValues = {},
} = {}) {
  const result = Object.fromEntries(HEADERS.map((header) => [header, '']));
  Object.assign(result, {
    'Page URL': pageUrl,
    'Menu Item': menuItem,
    'Resource URL': url,
    Title: title,
    'Brief Description': description,
    Date: date,
    'Member Only': memberOnly,
    Collection: collection,
    'Resource Type': resourceType,
  });
  for (const [name, value] of Object.entries(topicValues)) result[name] = value;
  return result;
}

function workbookRows(rows) {
  return {
    checksum: 'synthetic-workbook-checksum',
    sheets: [{ name: 'Resources', range: `A1:${XLSX.utils.encode_col(HEADERS.length - 1)}2` }],
    rows: rows.map(({ row, source: sourceRow, links = [], formulas = [] }) => ({
      row,
      source: sourceRow,
      links,
      formulas,
    })),
  };
}

function xlsxBuffer({
  source: sourceRow = source(),
  hyperlinks = {},
  date1904 = false,
} = {}) {
  const worksheet = XLSX.utils.aoa_to_sheet([
    HEADERS,
    HEADERS.map((header) => sourceRow[header] ?? ''),
  ]);
  for (const [header, hyperlink] of Object.entries(hyperlinks)) {
    const address = XLSX.utils.encode_cell({
      r: 1,
      c: HEADERS.indexOf(header),
    });
    worksheet[address].l = {
      Target: hyperlink.target,
      ...(hyperlink.tooltip === undefined ? {} : { Tooltip: hyperlink.tooltip }),
    };
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Resources');
  if (date1904) workbook.Workbook = { WBProps: { date1904: true } };
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function resource(
  id,
  targetUrl,
  {
    title = `Stored ${id}`,
    description = `Stored description ${id}`,
    release_date = '2025-01-01',
    is_public = false,
    resource_type = 'download',
    subcategories = ['Events', 'Posters'],
    tags = [`tag-${id}`],
    allowed_role_ids = [`role-${id}`],
    status = 'active',
    open_in_new_tab = true,
    ...extra
  } = {},
) {
  return {
    id,
    tenant_id: TENANT_ID,
    target_url: targetUrl,
    title,
    description,
    release_date,
    is_public,
    resource_type,
    subcategories: [...subcategories],
    tags: [...tags],
    allowed_role_ids: [...allowed_role_ids],
    status,
    open_in_new_tab,
    ...extra,
  };
}

function pagedClient({
  rows,
  total = rows.length,
  serverPageSize = rows.length,
  resultFor,
}) {
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
          const call = {
            table,
            columns: query.columns,
            options: query.options,
            tenantFilter: query.tenantFilter,
            ordering: query.ordering,
            from,
            to,
          };
          calls.push(call);
          if (resultFor) return Promise.resolve(resultFor({ ...call, calls }));
          return Promise.resolve({
            data: rows.slice(from, Math.min(to + 1, from + serverPageSize)),
            error: null,
            count: total,
          });
        },
      };
      return query;
    },
  };
  return client;
}

test('driveId accepts Drive file and folder variants but rejects spoofed hosts', () => {
  assert.deepEqual(
    [
      driveId(`https://drive.google.com/file/d/${FILE_A}/view`),
      driveId(`http://drive.google.com/file/d/${FILE_A}/preview`),
      driveId(` https://drive.google.com/open?id=${FILE_A} `),
      driveId(`https://drive.google.com/uc?export=download&id=${FILE_A}`),
    ],
    [FILE_A, FILE_A, FILE_A, FILE_A],
  );
  assert.equal(
    driveId(`https://drive.google.com/drive/folders/${FOLDER_A}`, 'folder'),
    FOLDER_A,
  );
  assert.equal(
    driveId(`https://drive.google.com/drive/folders/${FOLDER_A}?usp=sharing`, 'folder'),
    FOLDER_A,
  );
  assert.equal(driveId(`https://drive.google.com/drive/folders/${FOLDER_A}`), null);

  for (const value of [
    `https://drive.google.com.evil.example/file/d/${FILE_A}/view`,
    `https://evil.drive.google.com/file/d/${FILE_A}/view`,
    `https://user:password@drive.google.com/file/d/${FILE_A}/view`,
    `https://drive.google.com:8443/file/d/${FILE_A}/view`,
    `ftp://drive.google.com/file/d/${FILE_A}/view`,
    `https://drive.google.com/file/d/${FILE_A}/download`,
    `https://drive.google.com/drive/folders/${FOLDER_A}/nested`,
    `https://drive.google.com/open?id=${FILE_A}&id=${FILE_B}`,
  ]) {
    assert.equal(driveId(value), null, value);
  }
  assert.equal(driveId(`https://drive.google.com/drive/folders/${FOLDER_A}`, 'file'), null);
  assert.equal(driveId(`https://drive.google.com/file/d/${FILE_A}/view`, 'folder'), null);
});

test('yearDate accepts only trimmed calendar years and rejects Excel serials', () => {
  assert.equal(yearDate(' 2016 '), '2016-01-01');
  assert.equal(yearDate(2025), '2025-01-01');
  assert.equal(yearDate(' 2020\n'), '2020-01-01');

  for (const value of [
    42370,
    '42370',
    46002,
    '2025-01-01',
    '2015',
    '2026',
    '2020.0',
    '',
    null,
    undefined,
  ]) {
    assert.equal(yearDate(value), null, String(value));
  }
});

test('readWorkbook preserves whitespace and captures source hyperlinks without live access', () => {
  const sourceRow = source({
    pageUrl: ` https://drive.google.com/drive/folders/${FOLDER_A}/ `,
    url: ` https://drive.google.com/file/d/${FILE_A} `,
    title: '  Poster title  ',
    topicValues: {
      Oncology: ' X ',
      'Management and Workforce': ' x ',
    },
  });
  const parsed = readWorkbook(
    xlsxBuffer({
      source: sourceRow,
      hyperlinks: {
        'Page URL': {
          target: `https://drive.google.com/drive/folders/${FOLDER_A}?usp=sharing`,
          tooltip: 'Folder link',
        },
        'Resource URL': {
          target: `https://drive.google.com/file/d/${FILE_A}/view`,
          tooltip: 'File link',
        },
      },
    }),
  );

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].row, 2);
  assert.equal(parsed.rows[0].source['Resource URL'], sourceRow['Resource URL']);
  assert.deepEqual(
    parsed.rows[0].links.map(({ address, header, literal, target, tooltip }) => ({
      address,
      header,
      literal,
      target,
      tooltip,
    })),
    [
      {
        address: 'A2',
        header: 'Page URL',
        literal: sourceRow['Page URL'],
        target: `https://drive.google.com/drive/folders/${FOLDER_A}?usp=sharing`,
        tooltip: 'Folder link',
      },
      {
        address: 'C2',
        header: 'Resource URL',
        literal: sourceRow['Resource URL'],
        target: `https://drive.google.com/file/d/${FILE_A}/view`,
        tooltip: 'File link',
      },
    ],
  );
  assert.throws(
    () => readWorkbook(xlsxBuffer({ date1904: true })),
    /Unexpected 1904 date system/,
  );
});

test('buildReport handles X/x markers and trailing whitespace while preserving source text', () => {
  const sourceRow = source({
    pageUrl: ` https://drive.google.com/drive/folders/${FOLDER_A}/ `,
    url: ` https://drive.google.com/file/d/${FILE_A} `,
    title: '  Poster title  ',
    description: '  Description with spaces  ',
    date: ' 2025 ',
    memberOnly: ' yEs ',
    collection: ' Events ',
    resourceType: ' Posters ',
    topicValues: {
      Oncology: ' X ',
      'Management and Workforce': ' x ',
    },
  });
  const report = buildReport(
    workbookRows([
      {
        row: 2,
        source: sourceRow,
        links: [
          {
            address: 'A2',
            header: 'Page URL',
            literal: sourceRow['Page URL'],
            target: `https://drive.google.com/drive/folders/${FOLDER_A}?usp=sharing`,
          },
          {
            address: 'C2',
            header: 'Resource URL',
            literal: sourceRow['Resource URL'],
            target: `https://drive.google.com/file/d/${FILE_A}/view`,
          },
        ],
        formulas: [],
      },
    ]),
    [
      resource('existing', `https://drive.google.com/file/d/${FILE_A}/view`, {
        title: 'Old title',
        subcategories: ['Legacy classification'],
        resource_type: 'link',
      }),
    ],
    categories(),
  );
  const result = report.rows[0];

  assert.equal(result.status, 'update');
  assert.equal(result.matchMethod, 'drive_identity');
  assert.deepEqual(result.taxonomy.map(({ category, value }) => [category, value]), [
    ['Collection', 'Events'],
    ['Resource Type', 'Posters'],
    ['Focus Area', 'Management & Workforce'],
    ['Focus Area', 'Oncology'],
  ]);
  assert.deepEqual(result.proposed.subcategories, [
    'Legacy classification',
    'Events',
    'Posters',
    'Management & Workforce',
    'Oncology',
  ]);
  assert.equal(result.proposed.title, '  Poster title  ');
  assert.equal(result.proposed.description, '  Description with spaces  ');
  assert.equal(result.proposed.target_url, ` https://drive.google.com/file/d/${FILE_A} `);
  assert.equal(result.proposed.release_date, '2025-01-01');
  assert.deepEqual(result.notes, [
    `hyperlink_variant_same_folder:A2`,
    `hyperlink_variant_same_file:C2`,
  ]);
});

test('hyperlink identity conflicts block file and folder links', () => {
  const sourceRow = source();
  const parsed = readWorkbook(
    xlsxBuffer({
      source: sourceRow,
      hyperlinks: {
        'Page URL': {
          target: `https://drive.google.com/drive/folders/${FOLDER_B}`,
        },
        'Resource URL': {
          target: `https://drive.google.com/file/d/${FILE_B}/view`,
        },
      },
    }),
  );
  const report = buildReport(parsed, [], categories());
  const result = report.rows[0];

  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.includes('hyperlink_identity_conflict:A2'));
  assert.ok(result.issues.includes('hyperlink_identity_conflict:C2'));
  assert.equal(report.summary.hyperlinkConflicts, 1);
});

test('repeated titles never match records with different URLs', () => {
  const repeatedTitle = 'Annual poster title';
  const report = buildReport(
    workbookRows([
      { row: 2, source: source({ url: `https://drive.google.com/file/d/${FILE_A}`, title: repeatedTitle }) },
      { row: 3, source: source({ url: `https://drive.google.com/file/d/${FILE_B}`, title: repeatedTitle }) },
    ]),
    [
      resource('only-a', `https://drive.google.com/file/d/${FILE_A}`, {
        title: repeatedTitle,
        description: 'Synthetic description',
      }),
    ],
    categories(),
  );
  const first = report.rows[0];
  const second = report.rows[1];

  assert.equal(first.matchMethod, 'exact_url');
  assert.deepEqual(first.candidateIds, ['only-a']);
  assert.equal(first.status, 'unchanged');
  assert.equal(second.matchMethod, null);
  assert.deepEqual(second.candidateIds, []);
  assert.deepEqual(second.titleOnlyCandidateIds, ['only-a']);
  assert.ok(second.notes.includes('same_title_other_urls_not_used_for_matching'));
  assert.equal(second.status, 'insert');
});

test('an exact URL plus another record with the same Drive identity is ambiguous', () => {
  const url = `https://drive.google.com/file/d/${FILE_A}/view`;
  const report = buildReport(
    workbookRows([{ row: 42, source: source({ url }) }]),
    [
      resource('exact', url),
      resource('identity-only', `https://drive.google.com/open?id=${FILE_A}`),
    ],
    categories(),
  );
  const result = report.rows[0];

  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.includes('ambiguous_database_matches'));
  assert.deepEqual(result.candidateIds, ['exact', 'identity-only']);
  assert.equal(result.matchMethod, null);
  assert.equal(result.before, null);
});

test('matched proposals retain role restrictions, tags, classifications, status, and display type', () => {
  const url = `https://drive.google.com/file/d/${FILE_C}/view`;
  const report = buildReport(
    workbookRows([
      {
        row: 7,
        source: source({
          url,
          title: 'Poster to preserve',
          description: 'Updated description',
          date: '2024',
          topicValues: {
            'Management and Workforce': 'X',
            'Working in NM': ' x ',
            Cardiovascular: 'X',
          },
        }),
      },
    ]),
    [
      resource('preserved', url, {
        title: 'Poster to preserve',
        description: 'Old description',
        release_date: '2024-01-01',
        is_public: true,
        resource_type: 'link',
        subcategories: ['Events', 'Posters', 'Existing classification'],
        tags: ['keep-this-tag', 'keep-that-tag'],
        allowed_role_ids: ['member-role', 'editor-role'],
        status: 'archived',
        open_in_new_tab: false,
        custom_setting: 'untouched',
      }),
    ],
    categories(),
  );
  const result = report.rows[0];

  assert.equal(result.status, 'update');
  assert.deepEqual(result.proposed.allowed_role_ids, ['member-role', 'editor-role']);
  assert.deepEqual(result.proposed.tags, ['keep-this-tag', 'keep-that-tag']);
  assert.equal(result.proposed.status, 'archived');
  assert.equal(result.proposed.resource_type, 'link');
  assert.equal(result.proposed.open_in_new_tab, false);
  assert.equal(result.proposed.custom_setting, 'untouched');
  assert.deepEqual(result.proposed.subcategories, [
    'Events',
    'Posters',
    'Existing classification',
    'Cardiovascular',
    'Management & Workforce',
    'Working in NM',
  ]);
  assert.equal(result.proposed.is_public, false);
  assert.deepEqual(Object.keys(result.changes).sort(), ['description', 'is_public', 'subcategories']);
  assert.equal(report.summary.preservedNonDownloadTypes, 1);
});

test('buildReport rejects resources and taxonomy rows from another tenant', () => {
  const workbook = workbookRows([{ row: 2, source: source() }]);
  assert.throws(
    () =>
      buildReport(
        workbook,
        [resource('foreign-resource', `https://drive.google.com/file/d/${FILE_A}`, { tenant_id: 'foreign-tenant' })],
        categories(),
      ),
    /Tenant isolation failure/,
  );
  assert.throws(
    () =>
      buildReport(
        workbook,
        [],
        categories({ tenantId: 'foreign-tenant' }),
      ),
    /Tenant isolation failure/,
  );
});

test('readAll follows actual lower server page caps beyond 1000 rows', async () => {
  const rows = Array.from({ length: 1201 }, (_, index) => ({
    id: index + 1,
    tenant_id: TENANT_ID,
    value: `row-${index + 1}`,
  }));
  const client = pagedClient({ rows, serverPageSize: 137 });
  const result = await readAll(client, 'resource', 'id,tenant_id,value');

  assert.equal(result.total, 1201);
  assert.equal(result.rows.length, 1201);
  assert.deepEqual(result.rows, rows);
  assert.deepEqual(result.pages, [...Array(8).fill(137), 105]);
  assert.deepEqual(client.calls.map(({ from, to }) => [from, to]), [
    [0, 499],
    [137, 636],
    [274, 773],
    [411, 910],
    [548, 1047],
    [685, 1184],
    [822, 1321],
    [959, 1458],
    [1096, 1595],
  ]);
  assert.ok(client.calls.every(({ tenantFilter }) => (
    tenantFilter[0] === 'tenant_id' && tenantFilter[1] === TENANT_ID
  )));
});

test('readAll rejects tenant leaks and count drift', async (t) => {
  await t.test('tenant leak', async () => {
    const client = pagedClient({
      rows: [
        { id: 1, tenant_id: TENANT_ID },
        { id: 2, tenant_id: 'foreign-tenant' },
      ],
      serverPageSize: 500,
    });
    await assert.rejects(
      readAll(client, 'resource', 'id,tenant_id'),
      /Tenant isolation failure/,
    );
  });

  await t.test('count drift', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: index + 1,
      tenant_id: TENANT_ID,
    }));
    const client = pagedClient({
      rows,
      serverPageSize: 100,
      resultFor: ({ from, to }) => ({
        data: rows.slice(from, Math.min(to + 1, from + 100)),
        error: null,
        count: from === 0 ? 501 : 500,
      }),
    });
    await assert.rejects(
      readAll(client, 'resource', 'id,tenant_id'),
      /resource: unstable count/,
    );
  });
});