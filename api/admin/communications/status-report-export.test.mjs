import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCommunicationStatusCsv,
  handleCommunicationStatusReportExport,
} from './status-report-export.js';

function row(index) {
  return {
    memberId: `member-${index}`,
    firstName: index === 0 ? '=SUM(1,1)' : `Zoë ${index}`,
    lastName: index === 0 ? 'Quote " and\nnewline' : 'Example',
    email: `member${index}@example.test`,
    organizationName: index === 0 ? 'A, B' : 'Organisation',
    roleId: 'role-id-not-for-export',
    roleName: 'Full Member',
    globalOptOut: index % 2 === 0,
    categoryStatuses: {
      duplicate1: { optedIn: index % 2 === 0, available: true, unavailableReason: null },
      duplicate2: { optedIn: true, available: false, unavailableReason: 'role_ineligible' },
    },
  };
}

test('CSV includes every row beyond 1,000 with stable duplicate-name category headers', () => {
  const categories = [
    { id: 'duplicate1', name: 'Updates' },
    { id: 'duplicate2', name: 'Updates' },
  ];
  const rows = Array.from({ length: 1505 }, (_, index) => row(index));
  rows.push({
    ...row('null-email'),
    memberId: 'member-null-email',
    email: '',
  });
  const csv = buildCommunicationStatusCsv(categories, rows);
  const lines = csv.slice(1).split('\r\n');

  assert.equal(lines.length, 1507);
  assert.match(lines[0], /Updates \[duplicate1\],Updates \[duplicate2\]/);
  assert.match(csv, /member-1504/);
  assert.match(csv, /member-null-email/);
  assert.match(csv, /unavailable \(not eligible for member role\)/);
  assert.match(csv, /'=SUM/);
  assert.match(csv, /"A, B"/);
  assert.doesNotMatch(csv, /Quote "" and\r?\nnewline/);
});

test('role follows organisation and preserves category and global status alignment', () => {
  const csv = buildCommunicationStatusCsv([
    { id: 'duplicate1', name: 'Updates' },
    { id: 'duplicate2', name: 'Updates' },
  ], [row(1)]);
  assert.equal(csv, '\ufeffmember_id,first_name,last_name,email,organisation,role,Updates [duplicate1],Updates [duplicate2],global_opt_out\r\n'
    + 'member-1,Zoë 1,Example,member1@example.test,Organisation,Full Member,Not opted in,Opted in — unavailable (not eligible for member role),No');
  assert.doesNotMatch(csv, /role-id-not-for-export/);
});

test('blank, null and missing role names keep members without falling back to IDs', () => {
  const missing = row(3);
  delete missing.roleName;
  const csv = buildCommunicationStatusCsv([], [
    { ...row(1), roleName: '' },
    { ...row(2), roleName: null },
    missing,
  ]);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, 4);
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = line.split(',');
    assert.equal(cells.length, 7);
    assert.equal(cells[0], `member-${index + 1}`);
    assert.equal(cells[5], '');
    assert.equal(cells[6], index === 1 ? 'Yes' : 'No');
  }
  assert.doesNotMatch(csv, /role-id-not-for-export/);
});

test('role names use existing CSV quoting, newline flattening and formula protection', () => {
  const cases = [
    ['Fellow, "Senior"\r\nÉmérite', '"Fellow, ""Senior"" Émérite"'],
    ['=SUM(1,1)', '"\'=SUM(1,1)"'],
    ['+Member', "'+Member"],
    ['-Member', "'-Member"],
    ['@Member', "'@Member"],
    ['\tMember', "'\tMember"],
  ];
  for (const [roleName, escaped] of cases) {
    const lines = buildCommunicationStatusCsv([], [{ ...row(1), roleName }]).split('\r\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[1], `member-1,Zoë 1,Example,member1@example.test,Organisation,${escaped},No`);
  }
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

const allowed = {
  getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }),
  hasAdminAccess: async () => true,
  hasFeatureAccess: async () => false,
};

test('successful filtered export sends all rows and the role column to the download action', async () => {
  const res = responseRecorder();
  const filters = { roleId: 'role-id-not-for-export', globalOptOut: 'no', search: 'Example' };
  const rows = Array.from({ length: 1005 }, (_, index) => row(index + 1));
  await handleCommunicationStatusReportExport({
    method: 'POST', body: { expectedCount: rows.length, filters },
  }, res, {
    database: {},
    ...allowed,
    loadAllCommunicationStatusRows: async (_database, args) => {
      assert.deepEqual(args, { tenantId: 'tenant-a', query: filters });
      return { categories: [], rows };
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.equal(res.headers['x-export-row-count'], '1005');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-disposition'], /^attachment;/);
  assert.equal(res.body, buildCommunicationStatusCsv([], rows));
  assert.equal(res.body.split('\r\n').length, 1006);
  assert.match(res.body, /organisation,role,global_opt_out/);
  assert.doesNotMatch(res.body, /role-id-not-for-export/);
});

test('export enforces method and communications administration permission', async () => {
  const methodRes = responseRecorder();
  await handleCommunicationStatusReportExport({ method: 'GET' }, methodRes, {
    database: {},
  });
  assert.equal(methodRes.statusCode, 405);

  let loaded = false;
  const authRes = responseRecorder();
  await handleCommunicationStatusReportExport({ method: 'POST', body: {} }, authRes, {
    database: {},
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
    loadAllCommunicationStatusRows: async () => { loaded = true; },
  });
  assert.equal(authRes.statusCode, 403);
  assert.equal(loaded, false);
});

test('export returns JSON failure before setting download headers', async () => {
  const res = responseRecorder();
  await handleCommunicationStatusReportExport({ method: 'POST', body: {} }, res, {
    database: {},
    ...allowed,
    loadAllCommunicationStatusRows: async () => {
      throw new Error('database failed');
    },
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Failed to export communication status report' });
  assert.equal(res.headers['content-type'], undefined);
  assert.equal(res.headers['content-disposition'], undefined);
});

test('export rejects stale expected totals without sending a partial CSV', async () => {
  const res = responseRecorder();
  await handleCommunicationStatusReportExport({
    method: 'POST',
    body: { expectedCount: 2, filters: { globalOptOut: 'no' } },
  }, res, {
    database: {},
    ...allowed,
    loadAllCommunicationStatusRows: async (_database, args) => {
      assert.equal(args.tenantId, 'tenant-a');
      assert.deepEqual(args.query, { globalOptOut: 'no' });
      return { categories: [], rows: [row(1)] };
    },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.actualCount, 1);
  assert.equal(res.headers['content-disposition'], undefined);
});