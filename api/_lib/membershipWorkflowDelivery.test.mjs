import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fireWorkflowForPaidRow } from './membershipPaymentReconciliation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ORG_TABLE = 'organisation_membership_history';
const MEMBER_TABLE = 'member_membership_history';

// --- Tiny fake Supabase-style DB ---------------------------------------------
// Supports the exact chain fireWorkflowForPaidRow uses:
//   db.from(table).select('*').eq('id', id).maybeSingle()
function makeDb({ entity = undefined, error = null } = {}) {
  const calls = [];
  return {
    calls,
    from(tableName) {
      const state = { tableName };
      calls.push(state);
      const chain = {
        select(cols) { state.select = cols; return chain; },
        eq(col, val) { state.eq = { col, val }; return chain; },
        async maybeSingle() {
          state.resolved = true;
          return { data: entity ?? null, error };
        },
      };
      return chain;
    },
  };
}

function makeTrigger(deliveryResult) {
  const calls = [];
  const trigger = async (...args) => {
    calls.push(args);
    if (typeof deliveryResult === 'function') return deliveryResult(...args);
    return deliveryResult;
  };
  trigger.calls = calls;
  return trigger;
}

const baseOrgRow = {
  id: 'row-1',
  organization_id: 'org-1',
  accounting_invoice_number: 'INV-100',
  membership_year: 2026,
  final_cost: 500,
  currency: 'GBP',
};

// --- (1) deliveryKey passed through + completed confirmation returns fired ----
test('deliveryKey is passed in workflow context and completed confirmation returns fired', async () => {
  const db = makeDb({ entity: { id: 'org-1', tenant_id: 't-1', name: 'Acme' } });
  const trigger = makeTrigger({ delivery: { status: 'completed' } });

  const result = await fireWorkflowForPaidRow(
    {
      table: ORG_TABLE,
      row: baseOrgRow,
      snapshot: { paidAt: '2026-01-01T00:00:00.000Z' },
      deliveryKey: 'dk-abc',
    },
    { db, trigger },
  );

  assert.deepEqual(result, { fired: true });
  assert.equal(trigger.calls.length, 1);

  const [entityType, entityId, beforeData, afterData, triggerType, baseUrl, ctx] =
    trigger.calls[0];
  assert.equal(entityType, 'organization');
  assert.equal(entityId, 'org-1');
  assert.equal(triggerType, 'field_change');
  assert.equal(beforeData.payment_status, 'unpaid');
  assert.equal(afterData.payment_status, 'paid');
  assert.equal(afterData.last_membership_invoice_number, 'INV-100');
  // deliveryKey must be threaded into the trigger context.
  assert.equal(ctx.deliveryKey, 'dk-abc');
  assert.equal(ctx.historyTable, ORG_TABLE);
  assert.equal(ctx.historyRecordId, 'row-1');
});

test('completed delivery for member table works the same', async () => {
  const db = makeDb({ entity: { id: 'm-1', tenant_id: 't-1' } });
  const trigger = makeTrigger({ delivery: { status: 'completed', duplicate: true } });

  const result = await fireWorkflowForPaidRow(
    {
      table: MEMBER_TABLE,
      row: { id: 'row-2', member_id: 'm-1' },
      snapshot: {},
      deliveryKey: 'dk-member',
    },
    { db, trigger },
  );

  assert.deepEqual(result, { fired: true });
  const [entityType] = trigger.calls[0];
  assert.equal(entityType, 'member');
});

// --- (2) in_progress / unconfirmed delivery throws so settlement retries ------
test('in_progress delivery throws so settlement retries', async () => {
  const db = makeDb({ entity: { id: 'org-1', tenant_id: 't-1' } });
  const trigger = makeTrigger({ delivery: { status: 'in_progress' } });

  await assert.rejects(
    fireWorkflowForPaidRow(
      { table: ORG_TABLE, row: baseOrgRow, snapshot: {}, deliveryKey: 'dk-x' },
      { db, trigger },
    ),
    /workflow delivery dk-x is in_progress/,
  );
});

test('unconfirmed delivery (no delivery field) throws so settlement retries', async () => {
  const db = makeDb({ entity: { id: 'org-1', tenant_id: 't-1' } });
  const trigger = makeTrigger({}); // no `delivery` at all

  await assert.rejects(
    fireWorkflowForPaidRow(
      { table: ORG_TABLE, row: baseOrgRow, snapshot: {}, deliveryKey: 'dk-y' },
      { db, trigger },
    ),
    /workflow delivery dk-y is unconfirmed/,
  );
});

test('failed delivery status throws so settlement retries', async () => {
  const db = makeDb({ entity: { id: 'org-1', tenant_id: 't-1' } });
  const trigger = makeTrigger({ delivery: { status: 'failed' } });

  await assert.rejects(
    fireWorkflowForPaidRow(
      { table: ORG_TABLE, row: baseOrgRow, snapshot: {}, deliveryKey: 'dk-z' },
      { db, trigger },
    ),
    /workflow delivery dk-z is failed/,
  );
});

// --- (3) entity DB error / missing entity: retryable w/ deliveryKey, legacy skip w/o -
test('entity DB error is retryable (throws) when deliveryKey is present', async () => {
  const db = makeDb({ error: { message: 'connection reset' } });
  const trigger = makeTrigger({ delivery: { status: 'completed' } });

  await assert.rejects(
    fireWorkflowForPaidRow(
      { table: ORG_TABLE, row: baseOrgRow, snapshot: {}, deliveryKey: 'dk-err' },
      { db, trigger },
    ),
    /load workflow entity for durable delivery failed: connection reset/,
  );
  assert.equal(trigger.calls.length, 0);
});

test('missing entity is retryable (throws) when deliveryKey is present', async () => {
  const db = makeDb({ entity: null });
  const trigger = makeTrigger({ delivery: { status: 'completed' } });

  await assert.rejects(
    fireWorkflowForPaidRow(
      { table: ORG_TABLE, row: baseOrgRow, snapshot: {}, deliveryKey: 'dk-missing' },
      { db, trigger },
    ),
    /workflow entity organization#org-1 is not available for durable delivery/,
  );
  assert.equal(trigger.calls.length, 0);
});

test('entity DB error retains legacy skip behavior without a deliveryKey', async () => {
  const db = makeDb({ error: { message: 'connection reset' } });
  const trigger = makeTrigger({ delivery: { status: 'completed' } });

  // No deliveryKey: a DB error must NOT throw; the row is hydrated as absent and
  // the legacy "entity not found -> skip" path is taken.
  const result = await fireWorkflowForPaidRow(
    { table: ORG_TABLE, row: baseOrgRow, snapshot: {} },
    { db, trigger },
  );
  assert.deepEqual(result, { fired: false, skippedReason: 'entity-not-found' });
  assert.equal(trigger.calls.length, 0);
});

test('missing entity retains legacy skip behavior without a deliveryKey', async () => {
  const db = makeDb({ entity: null });
  const trigger = makeTrigger({ delivery: { status: 'completed' } });

  const result = await fireWorkflowForPaidRow(
    { table: MEMBER_TABLE, row: { id: 'r', member_id: 'm-1' }, snapshot: {} },
    { db, trigger },
  );
  assert.deepEqual(result, { fired: false, skippedReason: 'entity-not-found' });
  assert.equal(trigger.calls.length, 0);
});

test('no entity id skips without hitting the DB, regardless of deliveryKey', async () => {
  const db = makeDb({ entity: { id: 'org-1' } });
  const trigger = makeTrigger({ delivery: { status: 'completed' } });

  const result = await fireWorkflowForPaidRow(
    { table: ORG_TABLE, row: { id: 'r' }, snapshot: {}, deliveryKey: 'dk' },
    { db, trigger },
  );
  assert.deepEqual(result, { fired: false, skippedReason: 'no-entity-id' });
  assert.equal(db.calls.length, 0);
  assert.equal(trigger.calls.length, 0);
});

// --- Source contract assertions: triggerWorkflows durable delivery -----------
const workflowsSrc = readFileSync(join(__dirname, 'workflows.js'), 'utf8');

test('triggerWorkflows uses the workflow_delivery_claim table', () => {
  assert.match(workflowsSrc, /\.from\(\s*['"]workflow_delivery_claim['"]\s*\)/);
});

test('completed claims still dedupe (never re-run)', () => {
  assert.match(workflowsSrc, /existing\.status === 'completed'\)?\s*return \{ owned: false, completed: true \}/);
});

test('ambiguous processing/failed claims are NEVER auto-reclaimed', () => {
  // The reclaim/lease machinery was deliberately removed: any existing,
  // non-completed claim is returned as un-owned and flagged for attention.
  assert.match(
    workflowsSrc,
    /return \{ owned: false, inProgress: true, needsAttention: true \}/,
  );
  // No lease-based reclaim machinery may remain.
  assert.doesNotMatch(workflowsSrc, /WORKFLOW_DELIVERY_LEASE_MS/);
  // No reclaim code path (identifiers), only the policy comment may say "reclaim".
  assert.doesNotMatch(workflowsSrc, /\breclaimed\b/);
  assert.doesNotMatch(workflowsSrc, /\breclaimErr\b/);
  assert.doesNotMatch(workflowsSrc, /workflow delivery reclaim failed/);
  // No guarded "flip back to processing" update inside the claim helper.
  assert.doesNotMatch(
    workflowsSrc,
    /\.update\(\{\s*[\s\S]{0,120}?status:\s*'processing'/,
  );
});

test('production comments document the operator-review / non-idempotent-sink policy', () => {
  assert.match(workflowsSrc, /Never auto-reclaim an ambiguous action batch/);
  assert.match(workflowsSrc, /idempotency keys/);
  // The comment wraps across lines, so match across whitespace/comment markers.
  assert.match(workflowsSrc, /duplicate[\s\S]{0,12}side\s+effects/);
  assert.match(workflowsSrc, /operator review/);
});

test('completed is marked only after the workflow loop runs', () => {
  const finishIdx = workflowsSrc.indexOf('await finishWorkflowDelivery(');
  const loopIdx = workflowsSrc.indexOf('await executeWorkflowActions(');
  assert.ok(loopIdx > -1, 'workflow action loop must exist');
  assert.ok(finishIdx > -1, 'finishWorkflowDelivery must be called');
  assert.ok(finishIdx > loopIdx, 'finishWorkflowDelivery must run after the workflow loop');
  // finish is guarded by ownership and emits delivery.status completed
  assert.match(workflowsSrc, /if \(deliveryClaim\?\.owned\) \{\s*await finishWorkflowDelivery/);
  assert.match(workflowsSrc, /delivery: \{ status: 'completed' \}/);
});

test('delivery errors are marked failed and rethrown when a deliveryKey is present', () => {
  assert.match(workflowsSrc, /if \(deliveryClaim\?\.owned\) \{\s*await failWorkflowDelivery/);
  assert.match(workflowsSrc, /if \(context\.deliveryKey\) throw err;/);
});

test('hard initial insert/read failures still throw so callers retry', () => {
  // A non-conflict insert error (not 23505) throws.
  assert.match(workflowsSrc, /insertErr\?\.code !== '23505'/);
  assert.match(workflowsSrc, /workflow delivery claim failed:/);
  // A read-back error/missing row after a conflict throws.
  assert.match(workflowsSrc, /workflow delivery claim reload failed:/);
  // Completion ownership failures throw.
  assert.match(workflowsSrc, /workflow delivery completion failed:/);
});

// --- Migration contract assertions -------------------------------------------
const migrationPath = join(
  __dirname,
  '..',
  '..',
  'supabase',
  'migrations',
  '20260819_member_membership_history_billing_agreement_unique.sql',
);
const migrationSrc = readFileSync(migrationPath, 'utf8');

test('migration creates the workflow_delivery_claim table with a delivery_key PK', () => {
  assert.match(migrationSrc, /CREATE TABLE IF NOT EXISTS workflow_delivery_claim/);
  assert.match(migrationSrc, /delivery_key TEXT PRIMARY KEY/);
  assert.match(migrationSrc, /status TEXT NOT NULL CHECK \(status IN \('processing', 'completed', 'failed'\)\)/);
});

test('migration locks the table to service_role only', () => {
  assert.match(migrationSrc, /ALTER TABLE workflow_delivery_claim ENABLE ROW LEVEL SECURITY;/);
  assert.match(migrationSrc, /REVOKE ALL ON TABLE workflow_delivery_claim FROM PUBLIC;/);
  assert.match(migrationSrc, /REVOKE ALL ON TABLE workflow_delivery_claim FROM anon;/);
  assert.match(migrationSrc, /REVOKE ALL ON TABLE workflow_delivery_claim FROM authenticated;/);
  assert.match(migrationSrc, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE workflow_delivery_claim TO service_role;/);
});
