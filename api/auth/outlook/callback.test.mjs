import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  buildOutlookErrorRedirect,
  buildOutlookSuccessRedirect,
  createOutlookCallbackHandler,
} from './callback.js';

const SECRET = 'isolated-outlook-callback-secret';
const NOW = 1_700_000_000_000;

function signedState(overrides = {}) {
  const data = JSON.stringify({
    nonce: 'nonce-value',
    tenantId: 'tenant-a',
    identityId: 'identity-a',
    returnTo: '/admin/settings?tab=integrations',
    originHost: 'gsf.dev.iconn.app',
    timestamp: NOW,
    ...overrides,
  });
  const signature = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, signature })).toString('base64url');
}

function responseRecorder() {
  return {
    headers: {},
    statusCode: null,
    redirectUrl: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    redirect(value) { this.redirectUrl = value; return this; },
  };
}

function databaseDouble({
  identity = null,
  microsoft = null,
  identityError = null,
  microsoftError = null,
  updateError = null,
  insertError = null,
} = {}) {
  const calls = [];
  let lookup = 0;
  const database = {
    calls,
    from(table) {
      const call = { table, filters: [], operation: null, value: null };
      calls.push(call);
      const builder = {
        select() { call.operation ||= 'select'; return builder; },
        order() { return builder; },
        limit() { return builder; },
        eq(column, value) { call.filters.push([column, value]); return builder; },
        update(value) { call.operation = 'update'; call.value = value; return builder; },
        insert(value) { call.operation = 'insert'; call.value = value; return builder; },
        maybeSingle() {
          const isIdentityLookup = lookup++ === 0;
          return Promise.resolve({
            data: isIdentityLookup ? identity : microsoft,
            error: isIdentityLookup ? identityError : microsoftError,
          });
        },
        single() { return Promise.resolve({ data: { id: 'new-id' }, error: insertError }); },
        then(resolve, reject) {
          return Promise.resolve({ error: updateError }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return database;
}

function providerFetch() {
  let request = 0;
  return async () => {
    request += 1;
    if (request === 1) {
      return {
        ok: true,
        async json() {
          return {
            access_token: 'access-secret',
            refresh_token: 'refresh-secret',
            expires_in: 3600,
            scope: 'openid offline_access User.Read Mail.Read',
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          id: 'microsoft-a',
          mail: 'person@example.test',
          displayName: 'Example Person',
        };
      },
    };
  };
}

async function invoke({ query, cookie = 'outlook_oauth_nonce=nonce-value', database } = {}) {
  const handler = createOutlookCallbackHandler({
    database: database || databaseDouble(),
    fetchImpl: providerFetch(),
    scopeEvaluator: () => ({ healthState: 'healthy', missingScopes: [] }),
    clientId: 'client-id',
    clientSecret: 'client-secret',
    sessionSecret: SECRET,
    now: () => NOW,
  });
  const req = {
    method: 'GET',
    headers: { cookie },
    query: query || { code: 'provider-code', state: signedState() },
  };
  const res = responseRecorder();
  await handler(req, res);
  return res;
}

test('redirect helpers reject hostile paths and hosts and allow nested iconn hosts', () => {
  assert.equal(
    buildOutlookSuccessRedirect({
      returnTo: 'https://evil.example/phish',
      originHost: 'evil.example',
      isProduction: true,
    }),
    'https://iconn.app/admin/settings?outlook_connected=true'
  );
  assert.equal(
    buildOutlookErrorRedirect({
      returnTo: '//evil.example/phish',
      errorCode: 'not-provider-controlled',
      originHost: 'gsf.dev.iconn.app',
      isProduction: true,
    }),
    'https://gsf.dev.iconn.app/admin/settings?outlook_error=callback_failed'
  );
});

test('first save persists scope health and clears nonce', async () => {
  const database = databaseDouble();
  const res = await invoke({ database });
  const insert = database.calls.find(call => call.operation === 'insert');
  assert.equal(insert.value.tenant_id, 'tenant-a');
  assert.equal(insert.value.health_state, 'healthy');
  assert.equal(insert.value.health_error, null);
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
  assert.equal(res.redirectUrl, '/admin/settings?tab=integrations&outlook_connected=true');
});

test('identity reconnect updates only the signed tenant', async () => {
  const database = databaseDouble({ identity: { id: 'connection-a' } });
  const res = await invoke({ database });
  const update = database.calls.find(call => call.operation === 'update');
  assert.deepEqual(update.filters, [['tenant_id', 'tenant-a'], ['id', 'connection-a']]);
  assert.equal(update.value.sync_error, null);
  assert.equal(res.redirectUrl, '/admin/settings?tab=integrations&outlook_connected=true');
});

test('Microsoft-account reconnect uses the second tenant-scoped lookup', async () => {
  const database = databaseDouble({ microsoft: { id: 'connection-b' } });
  await invoke({ database });
  const selects = database.calls.filter(call => call.operation === 'select');
  assert.deepEqual(selects[1].filters.slice(0, 2), [
    ['tenant_id', 'tenant-a'],
    ['microsoft_user_id', 'microsoft-a'],
  ]);
  assert.ok(database.calls.some(call => call.operation === 'update'));
});

test('all persistence failures return only the safe save_failed code', async () => {
  const cases = [
    {
      database: databaseDouble({
        identityError: {
          code: '23505',
          message: 'raw identity lookup detail',
          details: 'identity secret',
        },
      }),
      operation: 'identity_lookup',
      code: '23505',
    },
    {
      database: databaseDouble({
        microsoftError: {
          code: 'PGRST116',
          message: 'raw account lookup detail',
          details: 'profile secret',
        },
      }),
      operation: 'microsoft_account_lookup',
      code: 'PGRST116',
    },
    {
      database: databaseDouble({
        identity: { id: 'connection-a' },
        updateError: {
          code: '42501',
          message: 'raw update detail',
          details: 'token secret',
        },
      }),
      operation: 'connection_update',
      code: '42501',
    },
    {
      database: databaseDouble({
        insertError: {
          code: 'sensitive-internal-code',
          message: 'raw insert detail',
          details: 'insert secret',
        },
      }),
      operation: 'connection_insert',
      code: 'unknown',
    },
  ];
  const diagnostics = [];
  const originalConsoleError = console.error;
  console.error = (...args) => diagnostics.push(args);
  try {
    for (const persistenceCase of cases) {
      const before = diagnostics.length;
      const res = await invoke({ database: persistenceCase.database });
      assert.equal(res.redirectUrl, '/admin/settings?tab=integrations&outlook_error=save_failed');
      assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
      assert.deepEqual(diagnostics[before], [
        '[Outlook OAuth Callback]',
        { operation: persistenceCase.operation, code: persistenceCase.code },
      ]);
    }
  } finally {
    console.error = originalConsoleError;
  }
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /raw|secret|sensitive-internal-code|token|profile/i);
});

test('provider denial is accepted only after valid state and nonce, then clears nonce', async () => {
  const valid = await invoke({ query: { error: 'access_denied', state: signedState() } });
  assert.equal(valid.redirectUrl, '/admin/settings?tab=integrations&outlook_error=oauth_denied');
  assert.match(valid.headers['Set-Cookie'], /Max-Age=0/);

  const forged = await invoke({
    query: { error: 'access_denied', state: signedState().slice(0, -1) + 'x' },
  });
  assert.equal(forged.redirectUrl, '/admin/settings?outlook_error=invalid_state');
});

test('expired state and nonce mismatch use safe signed or fallback navigation and clear nonce', async () => {
  const expired = await invoke({
    query: { code: 'unused', state: signedState({ timestamp: NOW - 11 * 60 * 1000 }) },
  });
  assert.equal(expired.redirectUrl, '/admin/settings?outlook_error=invalid_state');
  assert.match(expired.headers['Set-Cookie'], /Max-Age=0/);

  const mismatch = await invoke({ cookie: 'outlook_oauth_nonce=wrong' });
  assert.equal(mismatch.redirectUrl, '/admin/settings?tab=integrations&outlook_error=csrf_error');
  assert.match(mismatch.headers['Set-Cookie'], /Max-Age=0/);
});