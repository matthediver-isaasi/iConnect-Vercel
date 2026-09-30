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