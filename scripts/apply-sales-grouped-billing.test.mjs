import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGroupedBillingApply } from './apply-sales-grouped-billing.mjs';
import { DESTINATION_PROJECT_REF } from './lib/destinationSupabaseTarget.mjs';
test('grouped billing migration requires reviewed hash, destination pins and disabled automation', () => {
  const digest = 'reviewed-fixture';
  const args = ['--apply', `--reviewed-sha256=${digest}`, `--confirm-destination=${DESTINATION_PROJECT_REF}`];
  const env = { DEST_SUPABASE_URL: `https://${DESTINATION_PROJECT_REF}.supabase.co`,
    DEST_DATABASE_URL: `postgresql://postgres.${DESTINATION_PROJECT_REF}:fixture@aws-0-eu-west-2.pooler.supabase.com:5432/postgres` };
  validateGroupedBillingApply(args, env, digest);
  assert.throws(() => validateGroupedBillingApply([], env, digest), /Explicit/);
  assert.throws(() => validateGroupedBillingApply(args, env, 'changed-sql'), /Explicit/);
  assert.throws(() => validateGroupedBillingApply(args, { ...env, SALES_INVOICE_SCHEDULE_ENABLED: 'true' }, digest), /Disable/);
  assert.throws(() => validateGroupedBillingApply(args, { ...env, DEST_DATABASE_URL: env.DEST_DATABASE_URL + '?sslmode=disable' }, digest), /verified DEST/);
  assert.throws(() => validateGroupedBillingApply(args, { ...env, DEST_SUPABASE_URL: 'https://source.supabase.co' }, digest), /verified DEST/);
});
