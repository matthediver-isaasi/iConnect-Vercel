import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { handleOutlookSend } from './send.js';

function responseRecorder() {
  return {
    statusCode: 200, body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function databaseFixture({
  member,
  connection,
  memberError = null,
  throwOnMemberRead = false,
  logError = null,
  throwOnLog = false,
} = {}) {
  const operations = [];
  return {
    operations,
    from(table) {
      const filters = [];
      let write = null;
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        update(value) { write = value; operations.push({ table, kind: 'update', value, filters }); return query; },
        insert(value) {
          operations.push({ table, kind: 'insert', value, filters });
          if (table === 'member_email' && throwOnLog) throw new Error('database transport failed');
          return Promise.resolve({ data: null, error: table === 'member_email' ? logError : null });
        },
        maybeSingle() {
          operations.push({ table, kind: 'read', filters: [...filters] });
          if (table === 'member' && throwOnMemberRead) throw new Error('database transport failed');
          const requestedTenant = filters.find(([column]) => column === 'tenant_id')?.[1];
          const matchesTenant = !member || !requestedTenant || member.tenant_id === requestedTenant;
          return Promise.resolve({
            data: table === 'member' && matchesTenant ? member : null,
            error: table === 'member' ? memberError : null,
          });
        },
        single() {
          operations.push({ table, kind: 'read', filters: [...filters] });
          return Promise.resolve({ data: table === 'outlook_connection' ? connection : null, error: connection ? null : { code: 'missing' } });
        },
        then(resolve, reject) {
          return Promise.resolve({ data: write, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

const activeMember = { id: 'member-a', tenant_id: 'tenant-a', email: 'Member@Example.com', login_enabled: true };
const activeConnection = { id: 'connection-a', status: 'active', microsoft_email: 'agent@example.com', display_name: 'Agent' };
const baseBody = {
  memberId: 'member-a', tenantId: 'tenant-a', to: 'member@example.com',
  cc: ' First@Example.org;second@example.net ', subject: 'Hello', body: 'Message', bodyType: 'text',
};

function dependencies(database, graphRequests, counters) {
  return {
    database,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', tenantUserId: 'admin-a' }),
    hasAdminAccess: async () => true,
    getSession: async () => ({ data: { tenantId: 'tenant-a', identityId: 'identity-a' } }),
    getValidMicrosoftAccessToken: async () => {
      counters.tokenAccess += 1;
      return 'token';
    },
    fetch: async (url, options) => {
      graphRequests.push({ url, options });
      return { ok: true };
    },
  };
}

async function invoke(body, options = {}) {
  const graphRequests = [];
  const counters = { tokenAccess: 0 };
  const database = databaseFixture({
    member: options.member === undefined ? activeMember : options.member,
    connection: options.connection === undefined ? activeConnection : options.connection,
    memberError: options.memberError,
    throwOnMemberRead: options.throwOnMemberRead,
    logError: options.logError,
    throwOnLog: options.throwOnLog,
  });
  const res = responseRecorder();
  await handleOutlookSend(
    { method: 'POST', headers: {}, body },
    res,
    {
      ...dependencies(database, graphRequests, counters),
      ...(options.fetchError ? {
        fetch: async (url, fetchOptions) => {
          graphRequests.push({ url, options: fetchOptions });
          throw options.fetchError;
        },
      } : {}),
      ...(options.dependencies || {}),
    },
  );
  return { res, database, graphRequests, counters };
}

test('sends exactly the final Graph payload and logs the exact recipient envelope', async () => {
  const { res, database, graphRequests } = await invoke(baseBody);
  assert.equal(res.statusCode, 200);
  assert.equal(graphRequests.length, 1);
  assert.equal(graphRequests[0].url, 'https://graph.microsoft.com/v1.0/me/sendMail');
  assert.equal(graphRequests[0].options.method, 'POST');
  assert.equal(graphRequests[0].options.headers.Authorization, 'Bearer token');
  const graphBody = JSON.parse(graphRequests[0].options.body);
  assert.deepEqual(graphBody, {
    message: {
      subject: 'Hello',
      body: { contentType: 'Text', content: 'Message' },
      toRecipients: [{ emailAddress: { address: 'Member@Example.com' } }],
      ccRecipients: [
        { emailAddress: { address: 'First@Example.org' } },
        { emailAddress: { address: 'second@example.net' } },
      ],
    },
    saveToSentItems: true,
  });
  const historyWrites = database.operations.filter(op => op.table === 'member_email' && op.kind === 'insert');
  assert.equal(historyWrites.length, 1);
  assert.deepEqual(historyWrites[0].value.to_addresses, [{ address: 'Member@Example.com', name: undefined }]);
  assert.deepEqual(historyWrites[0].value.cc_addresses, [
    { address: 'First@Example.org', name: undefined },
    { address: 'second@example.net', name: undefined },
  ]);
  assert.equal(historyWrites[0].value.tenant_id, 'tenant-a');
  assert.equal(historyWrites[0].value.member_id, 'member-a');
  assert.equal(historyWrites[0].value.subject, 'Hello');
  assert.equal(historyWrites[0].value.body_content, 'Message');
  assert.deepEqual(
    database.operations.find(op => op.table === 'outlook_connection').filters,
    [['tenant_id', 'tenant-a'], ['identity_id', 'identity-a']],
  );
});

test('omitted, blank, and single CC each produce one send with the exact CC payload', async () => {
  const cases = [
    { cc: undefined, expected: undefined },
    { cc: '   ', expected: undefined },
    { cc: 'Only@Example.org', expected: [{ emailAddress: { address: 'Only@Example.org' } }] },
  ];
  for (const { cc, expected } of cases) {
    const body = { ...baseBody };
    if (cc === undefined) delete body.cc;
    else body.cc = cc;
    const { res, graphRequests } = await invoke(body);
    assert.equal(res.statusCode, 200);
    assert.equal(graphRequests.length, 1);
    assert.deepEqual(JSON.parse(graphRequests[0].options.body).message.ccRecipients, expected);
  }
});

test('provider rejection is reported once and is never written to history', async () => {
  const graphRequests = [];
  const database = databaseFixture({ member: activeMember, connection: activeConnection });
  const counters = { tokenAccess: 0 };
  const res = responseRecorder();
  await handleOutlookSend(
    { method: 'POST', headers: {}, body: baseBody },
    res,
    {
      ...dependencies(database, graphRequests, counters),
      fetch: async (url, options) => {
        graphRequests.push({ url, options });
        return { ok: false };
      },
    },
  );
  assert.equal(res.statusCode, 500);
  assert.equal(graphRequests.length, 1);
  assert.equal(database.operations.some(op => op.table === 'member_email'), false);
});

test('rejects authorization, tenant, member, recipient, and header failures without sending or token access', async () => {
  const cases = [
    { body: baseBody, dependencies: { hasAdminAccess: async () => false }, status: 403 },
    { body: baseBody, dependencies: { getTenantContext: async () => ({ isAuthenticated: false }) }, status: 401 },
    { body: { ...baseBody, tenantId: 'tenant-b' }, status: 403 },
    { body: { ...baseBody, to: 'stale@example.com' }, status: 409 },
    { body: baseBody, member: { ...activeMember, email: 'deleted_x@deleted.local', login_enabled: false }, status: 404 },
    { body: baseBody, member: null, status: 404 },
    { body: baseBody, member: { ...activeMember, email: 'not-an-email' }, status: 409 },
    { body: baseBody, member: { ...activeMember, tenant_id: 'tenant-b' }, status: 404 },
    { body: { ...baseBody, memberId: [] }, status: 400 },
    { body: { ...baseBody, to: ['member@example.com'] }, status: 400 },
    { body: { ...baseBody, to: 'member@example.com,other@example.com' }, status: 400 },
    { body: { ...baseBody, cc: ['other@example.com'] }, status: 400 },
    { body: { ...baseBody, cc: 'bad-address' }, status: 400 },
    { body: { ...baseBody, cc: 'one@example.com\r\nBcc: other@example.com' }, status: 400 },
    { body: { ...baseBody, bcc: 'other@example.com' }, status: 400 },
    { body: { ...baseBody, subject: 'Hello\r\nBcc: other@example.com' }, status: 400 },
  ];
  for (const item of cases) {
    const { res, graphRequests, counters } = await invoke(item.body, item);
    assert.equal(res.statusCode, item.status, JSON.stringify(item.body));
    assert.equal(graphRequests.length, 0);
    assert.equal(counters.tokenAccess, 0);
  }
});

test('member lookup database errors and throws fail closed before token access or sending', async () => {
  for (const options of [
    { memberError: { message: 'lookup failed' } },
    { throwOnMemberRead: true },
  ]) {
    const { res, graphRequests, counters } = await invoke(baseBody, options);
    assert.equal(res.statusCode, 500);
    assert.equal(graphRequests.length, 0);
    assert.equal(counters.tokenAccess, 0);
  }
});

test('returns success with a warning when history logging fails after provider acceptance', async () => {
  const { res, graphRequests } = await invoke(baseBody, { logError: { message: 'db unavailable' } });
  assert.equal(graphRequests.length, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.match(res.body.warning, /history/i);
});

test('returns success with a warning when history logging throws after provider acceptance', async () => {
  const { res, graphRequests } = await invoke(baseBody, { throwOnLog: true });
  assert.equal(graphRequests.length, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.match(res.body.warning, /history/i);
});

test('marks delivery unknown when the provider request fails before a response', async () => {
  const { res, graphRequests, database } = await invoke(baseBody, { fetchError: new Error('socket reset') });
  assert.equal(graphRequests.length, 1);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.deliveryUnknown, true);
  assert.equal(database.operations.some(op => op.table === 'member_email'), false);
});

test('send handler has no campaign dependency and rejected input cannot reach global fetch', async () => {
  const source = readFileSync(new URL('./send.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /campaign/i);
  const database = databaseFixture({ member: activeMember, connection: activeConnection });
  const res = responseRecorder();
  await handleOutlookSend(
    { method: 'POST', headers: {}, body: { ...baseBody, to: ['member@example.com'] } },
    res,
    {
      database,
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }),
      hasAdminAccess: async () => true,
      getSession: async () => ({ data: { tenantId: 'tenant-a', identityId: 'identity-a' } }),
      getValidMicrosoftAccessToken: async () => assert.fail('token access was unexpected'),
    },
  );
  assert.equal(res.statusCode, 400);
});