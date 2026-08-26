import assert from 'node:assert/strict';
import test from 'node:test';

import { createHealthHandler } from '../health.js';
import {
  DEFAULT_HEALTH_OVERALL_TIMEOUT_MS,
  runHealthChecks,
} from './healthChecks.js';
import {
  createHeartbeatReporter,
  HEARTBEAT_ENV_VARS,
  HEARTBEAT_MONITOR_REGISTRY,
  sendHeartbeat,
} from './heartbeat.js';

function responseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

function healthySupabase() {
  return {
    from() {
      return {
        select() {
          return {
            limit: async () => ({ data: [], error: null }),
          };
        },
      };
    },
    storage: {
      from() {
        return {
          list: async () => ({ data: [], error: null }),
        };
      },
    },
  };
}

test('health route rejects missing, invalid, and unconfigured tokens without probing', async () => {
  let probes = 0;
  const handler = createHealthHandler({
    getToken: () => 'configured-secret',
    checks: async () => {
      probes++;
      return { database: 'ok', auth: 'ok', storage: 'ok' };
    },
  });

  for (const token of [undefined, 'wrong']) {
    const res = responseRecorder();
    await handler({ headers: { 'x-health-token': token } }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
    assert.equal(res.headers['Cache-Control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }

  const unconfigured = createHealthHandler({ getToken: () => '' });
  const res = responseRecorder();
  await unconfigured({ headers: { 'x-health-token': 'anything' } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(probes, 0);
});

test('health route returns the sanitised healthy response', async () => {
  const handler = createHealthHandler({
    getToken: () => 'secret',
    checks: async () => ({
      database: 'ok',
      auth: 'ok',
      storage: 'ok',
      providerError: 'must not be exposed',
    }),
    clock: () => new Date('2026-08-25T12:00:00.000Z'),
  });
  const res = responseRecorder();
  await handler({ headers: { 'X-Health-Token': 'secret' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    status: 'ok',
    database: 'ok',
    auth: 'ok',
    storage: 'ok',
    timestamp: '2026-08-25T12:00:00.000Z',
  });
  assert.equal(res.headers.Pragma, 'no-cache');
});

test('health route returns 503 when any dependency fails and never exposes its error', async () => {
  for (const failedCheck of ['database', 'auth', 'storage']) {
    const handler = createHealthHandler({
      getToken: () => 'secret',
      checks: async () => ({
        database: failedCheck === 'database' ? 'error' : 'ok',
        auth: failedCheck === 'auth' ? 'error' : 'ok',
        storage: failedCheck === 'storage' ? 'error' : 'ok',
        detail: 'connection string and provider stack',
      }),
    });
    const res = responseRecorder();
    await handler({ headers: { 'x-health-token': 'secret' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, 'error');
    assert.equal(res.body[failedCheck], 'error');
    assert.equal(JSON.stringify(res.body).includes('connection string'), false);
  }
});

test('health checks run database, auth, and storage concurrently and pass', async () => {
  const calls = [];
  const result = await runHealthChecks({
    dbClient: healthySupabase(),
    url: 'https://example.supabase.co/',
    serviceKey: 'test-key',
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true };
    },
    probeTimeoutMs: 100,
    overallTimeoutMs: 500,
  });
  assert.deepEqual(result, { database: 'ok', auth: 'ok', storage: 'ok' });
  assert.deepEqual(calls, ['https://example.supabase.co/auth/v1/health']);
});

test('health checks convert dependency failures and timeouts to error values', async () => {
  const dbClient = healthySupabase();
  dbClient.from = () => ({
    select: () => ({ limit: async () => ({ error: { message: 'secret db detail' } }) }),
  });
  dbClient.storage.from = () => ({
    list: async () => {
      await new Promise(() => {});
    },
  });
  const startedAt = Date.now();
  const result = await runHealthChecks({
    dbClient,
    url: 'https://example.supabase.co',
    serviceKey: 'test-key',
    fetchImpl: async () => {
      throw new Error('secret auth provider detail');
    },
    probeTimeoutMs: 15,
    overallTimeoutMs: DEFAULT_HEALTH_OVERALL_TIMEOUT_MS,
  });
  assert.deepEqual(result, { database: 'error', auth: 'error', storage: 'error' });
  assert.ok(Date.now() - startedAt < 500);
});

test('health checks fail closed at the overall deadline', async () => {
  const aborted = { database: false, auth: false, storage: false };
  const databaseQuery = new Promise(() => {});
  databaseQuery.abortSignal = (signal) => {
    signal.addEventListener('abort', () => { aborted.database = true; });
    return databaseQuery;
  };
  const result = await runHealthChecks({
    dbClient: {
      from: () => ({ select: () => ({ limit: () => databaseQuery }) }),
      storage: {
        from: () => ({
          list: (_path, _options, parameters) => {
            parameters.signal.addEventListener('abort', () => { aborted.storage = true; });
            return new Promise(() => {});
          },
        }),
      },
    },
    url: 'https://example.supabase.co',
    serviceKey: 'key',
    fetchImpl: (_url, parameters) => {
      parameters.signal.addEventListener('abort', () => { aborted.auth = true; });
      return new Promise(() => {});
    },
    probeTimeoutMs: 1000,
    overallTimeoutMs: 20,
  });
  assert.deepEqual(result, { database: 'error', auth: 'error', storage: 'error' });
  assert.deepEqual(aborted, { database: true, auth: true, storage: true });
});

test('heartbeat does nothing without a configured URL', async () => {
  let calls = 0;
  const result = await sendHeartbeat({
    envVar: HEARTBEAT_ENV_VARS.membershipRenewals,
    success: true,
    env: {},
    fetchImpl: async () => {
      calls++;
      return { ok: true };
    },
  });
  assert.deepEqual(result, { sent: false });
  assert.equal(calls, 0);
});

test('heartbeat registry contains exactly the ten selected production schedules', () => {
  const expected = [
    ['membershipRenewals', 'BETTERSTACK_HEARTBEAT_MEMBERSHIP_RENEWALS_URL', '/api/cron/process-membership-renewals'],
    ['membershipPaymentReconciliation', 'BETTERSTACK_HEARTBEAT_MEMBERSHIP_PAYMENT_RECONCILIATION_URL', '/api/cron/reconcile-membership-invoice-payments'],
    ['gocardlessReconciliation', 'BETTERSTACK_HEARTBEAT_GOCARDLESS_RECONCILIATION_URL', '/api/cron/reconcile-gocardless'],
    ['stripeCardPlanReconciliation', 'BETTERSTACK_HEARTBEAT_STRIPE_CARD_PLAN_RECONCILIATION_URL', '/api/cron/reconcile-stripe-card-plans'],
    ['scheduledWorkflows', 'BETTERSTACK_HEARTBEAT_SCHEDULED_WORKFLOWS_URL', '/api/cron/run-scheduled-workflows'],
    ['scheduledCampaigns', 'BETTERSTACK_HEARTBEAT_SCHEDULED_CAMPAIGNS_URL', '/api/email-campaigns/process-scheduled'],
    ['databaseBackup', 'BETTERSTACK_HEARTBEAT_DATABASE_BACKUP_URL', '/api/cron/backup-database-to-r2'],
    ['storageBackup', 'BETTERSTACK_HEARTBEAT_STORAGE_BACKUP_URL', '/api/cron/backup-storage-to-r2'],
    ['formPaymentReconciliation', 'BETTERSTACK_HEARTBEAT_FORM_PAYMENT_RECONCILIATION_URL', '/api/cron/reconcile-form-payments'],
    ['automaticMembershipProcessing', 'BETTERSTACK_HEARTBEAT_AUTOMATIC_MEMBERSHIP_PROCESSING_URL', '/api/cron/process-automatic-memberships'],
  ];

  assert.deepEqual(
    HEARTBEAT_MONITOR_REGISTRY.map(({ key, envVar, path }) => [key, envVar, path]),
    expected,
  );
  assert.deepEqual(Object.keys(HEARTBEAT_ENV_VARS), expected.map(([key]) => key));
});

test('each newly monitored job is an independent optional heartbeat', async () => {
  let calls = 0;
  for (const { envVar } of HEARTBEAT_MONITOR_REGISTRY.slice(6)) {
    const result = await sendHeartbeat({
      envVar,
      success: true,
      env: {},
      fetchImpl: async () => {
        calls++;
        return { ok: true };
      },
    });
    assert.deepEqual(result, { sent: false });
  }
  assert.equal(calls, 0);
});

test('heartbeat sends success and failure requests, once per reporter', async () => {
  const requests = [];
  const env = {
    [HEARTBEAT_ENV_VARS.scheduledCampaigns]: 'https://uptime.example/heartbeat?source=cron',
  };
  const fetchImpl = async (url) => {
    requests.push(url);
    return { ok: true };
  };
  await sendHeartbeat({
    envVar: HEARTBEAT_ENV_VARS.scheduledCampaigns,
    success: true,
    env,
    fetchImpl,
  });
  const reporter = createHeartbeatReporter({
    envVar: HEARTBEAT_ENV_VARS.scheduledCampaigns,
    env,
    fetchImpl,
  });
  await reporter(false);
  await reporter(true);
  assert.deepEqual(requests, [
    'https://uptime.example/heartbeat?source=cron',
    'https://uptime.example/heartbeat/fail?source=cron',
  ]);
});

test('heartbeat delivery errors are non-fatal and safely logged', async () => {
  const logs = [];
  const result = await sendHeartbeat({
    envVar: HEARTBEAT_ENV_VARS.gocardlessReconciliation,
    success: true,
    env: { [HEARTBEAT_ENV_VARS.gocardlessReconciliation]: 'https://uptime.example/secret-token' },
    fetchImpl: async () => {
      throw new Error('secret URL and provider response');
    },
    logger: { warn: (message) => logs.push(message) },
  });
  assert.deepEqual(result, { sent: false });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].includes('secret URL'), false);
  assert.equal(logs[0].includes('provider response'), false);
});