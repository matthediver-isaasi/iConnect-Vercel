import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('retry migration keeps automatic accounting separate and tenant-auditable', async () => {
  const source = await readFile(
    new URL('../../supabase/migrations/20260917_gocardless_auto_retries.sql', import.meta.url),
    'utf8',
  );
  assert.match(source, /auto_retry_attempts INTEGER NOT NULL DEFAULT 0/);
  assert.match(source, /auto_retry_next_at TIMESTAMPTZ/);
  assert.match(source, /auto_retry_claim_token TEXT/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS gocardless_payment_retry_attempts/);
  assert.match(source, /tenant_id UUID NOT NULL/);
  assert.match(source, /CHECK \(mode IN \('automatic', 'manual'\)\)/);
  assert.match(source, /\(gocardless_payment_id, mode, attempt_number\)/);
});

test('all retry entry points use the shared safe service', async () => {
  const [admin, member, webhook, cron, integrationApi, adminUi] = await Promise.all([
    readFile(new URL('../admin/gocardless-dd.js', import.meta.url), 'utf8'),
    readFile(new URL('../membership/dd-self-service.js', import.meta.url), 'utf8'),
    readFile(new URL('./gocardlessWebhookProcessor.js', import.meta.url), 'utf8'),
    readFile(new URL('../cron/gocardless-auto-retries.js', import.meta.url), 'utf8'),
    readFile(new URL('../admin/integrations.js', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/DirectDebitAdmin.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(admin, /retryPaymentSafely/);
  assert.match(admin, /claimPlanForCancellation/);
  assert.match(member, /retryPaymentSafely/);
  assert.match(webhook, /scheduleAutomaticRetry/);
  assert.match(webhook, /clearAutomaticRetryForPlan/);
  assert.match(webhook, /closeAutomaticRetrySchedule/);
  assert.match(cron, /retryPaymentSafely/);
  assert.match(integrationApi, /\(credentials \|\| autoRetryPolicy\)[\s\S]*updateData\.credentials = encryptedCreds/);
  assert.match(integrationApi, /autoRetryPolicy \|\| is_enabled === false/);
  assert.doesNotMatch(integrationApi, /retryStateUpdate = \{[\s\S]{0,300}auto_retry_claimed_at/);
  assert.match(adminUi, /retryAttempts/);
  assert.match(adminUi, /data-testid="tab-retry-attempts"/);
});