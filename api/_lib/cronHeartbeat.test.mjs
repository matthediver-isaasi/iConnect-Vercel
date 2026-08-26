import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isDatabaseBackupHeartbeatHealthy,
} from '../cron/backup-database-to-r2.js';
import {
  isStorageBackupHeartbeatHealthy,
} from '../cron/backup-storage-to-r2.js';
import {
  isFormPaymentReconciliationHeartbeatHealthy,
} from '../cron/reconcile-form-payments.js';
import {
  isAutomaticMembershipHeartbeatHealthy,
  default as processAutomaticMemberships,
} from '../cron/process-automatic-memberships.js';
import {
  default as backupDatabase,
} from '../cron/backup-database-to-r2.js';
import {
  default as backupStorage,
} from '../cron/backup-storage-to-r2.js';
import {
  default as reconcileFormPayments,
} from '../cron/reconcile-form-payments.js';
import {
  reconcileFormPayments as runFormPaymentReconciliation,
} from './formPaymentReconciliation.js';

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
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

async function withHeartbeatEnvironment(callback) {
  const priorSecret = process.env.CRON_SECRET;
  const priorUrls = Object.entries(process.env)
    .filter(([key]) => key.startsWith('BETTERSTACK_HEARTBEAT_'));
  const priorFetch = globalThis.fetch;
  try {
    process.env.CRON_SECRET = 'test-cron-secret';
    for (const [key] of priorUrls) delete process.env[key];
    process.env.BETTERSTACK_HEARTBEAT_DATABASE_BACKUP_URL = 'https://uptime.example/database';
    process.env.BETTERSTACK_HEARTBEAT_STORAGE_BACKUP_URL = 'https://uptime.example/storage';
    process.env.BETTERSTACK_HEARTBEAT_FORM_PAYMENT_RECONCILIATION_URL = 'https://uptime.example/forms';
    process.env.BETTERSTACK_HEARTBEAT_AUTOMATIC_MEMBERSHIP_PROCESSING_URL = 'https://uptime.example/automatic-memberships';
    await callback();
  } finally {
    if (priorSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorSecret;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('BETTERSTACK_HEARTBEAT_')) delete process.env[key];
    }
    for (const [key, value] of priorUrls) process.env[key] = value;
    globalThis.fetch = priorFetch;
  }
}

function rejectedSupabaseResult(message) {
  const query = {};
  for (const method of ['select', 'eq', 'not', 'gte', 'lte', 'order', 'filter', 'or']) {
    query[method] = () => query;
  }
  query.limit = async () => ({ data: null, error: new Error(message) });
  return { from: () => query };
}

test('backup heartbeat classifiers treat clean, skipped, and resumable runs as healthy', () => {
  assert.equal(isDatabaseBackupHeartbeatHealthy({ ok: true, complete: true }), true);
  assert.equal(isDatabaseBackupHeartbeatHealthy({ ok: true, complete: false, skipped: ['public.members'] }), true);
  assert.equal(isDatabaseBackupHeartbeatHealthy({ ok: true, complete: false }), true);
  assert.equal(isDatabaseBackupHeartbeatHealthy({ ok: true, erroredTables: [] }), true);
  assert.equal(isStorageBackupHeartbeatHealthy({ ok: true, deferred: true }), true);
  assert.equal(isStorageBackupHeartbeatHealthy({ ok: true, copied: 0, skipped: 0 }), true);
});

test('backup heartbeat classifiers fail on runner and meaningful partial errors', () => {
  assert.equal(isDatabaseBackupHeartbeatHealthy({ ok: false, error: 'runner failed' }), false);
  assert.equal(isDatabaseBackupHeartbeatHealthy({ ok: true, erroredTables: [{ table: 'member' }] }), false);
  assert.equal(isStorageBackupHeartbeatHealthy({ ok: false, error: 'runner failed' }), false);
  assert.equal(isStorageBackupHeartbeatHealthy({ ok: true, errored: 1 }), false);
});

test('form-payment reconciliation heartbeat uses its existing row error summary', () => {
  assert.equal(isFormPaymentReconciliationHeartbeatHealthy({ checked: 0, errors: [] }), true);
  assert.equal(isFormPaymentReconciliationHeartbeatHealthy({ checked: 4, errors: [{ id: 'submission-1' }] }), false);
  assert.equal(isFormPaymentReconciliationHeartbeatHealthy({ errors: 0 }), true);
  assert.equal(isFormPaymentReconciliationHeartbeatHealthy({ errors: 2 }), false);

  const partialSweep = { checked: 0, errors: [] };
  Object.defineProperty(partialSweep, '__heartbeatFailures', {
    value: [{ scope: 'pending-payment-sweep' }],
    enumerable: false,
  });
  assert.equal(isFormPaymentReconciliationHeartbeatHealthy(partialSweep), false);
});

test('form-payment reconciliation treats returned Supabase errors as heartbeat failures without changing its summary fields', async () => {
  const results = await runFormPaymentReconciliation(rejectedSupabaseResult('database temporarily unavailable'));
  assert.deepEqual(results, { checked: 0, paid: 0, failed: 0, finalized: 0, errors: [] });
  assert.equal(Object.keys(results).includes('__heartbeatFailures'), false);
  assert.equal(isFormPaymentReconciliationHeartbeatHealthy(results), false);
});

test('automatic membership heartbeat accepts stale and continuation outcomes', () => {
  assert.equal(isAutomaticMembershipHeartbeatHealthy([], 0), true);
  assert.equal(isAutomaticMembershipHeartbeatHealthy([{ status: 'idle' }, { status: 'running' }, { status: 'stale' }], 0), true);
  assert.equal(isAutomaticMembershipHeartbeatHealthy([{ status: 'error' }], 0), false);
  assert.equal(isAutomaticMembershipHeartbeatHealthy([{ status: 'error', code: 'RPC_FAILURE' }], 0), false);
  assert.equal(isAutomaticMembershipHeartbeatHealthy([], 1), false);
});

test('selected handlers never ping Better Stack before cron authentication', async () => {
  await withHeartbeatEnvironment(async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: true };
    };
    const request = { method: 'GET', headers: { authorization: 'Bearer wrong-secret' } };

    for (const handler of [backupDatabase, backupStorage, reconcileFormPayments, processAutomaticMemberships]) {
      const res = responseRecorder();
      await handler(request, res);
      assert.equal(res.statusCode, 401);
    }
    assert.equal(calls, 0);
  });
});