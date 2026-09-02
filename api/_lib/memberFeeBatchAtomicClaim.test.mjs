import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../../supabase/migrations/20260919_atomic_member_fee_token_claim.sql', import.meta.url),
  'utf8',
);
const sender = fs.readFileSync(new URL('./membershipFeeTokenEmail.js', import.meta.url), 'utf8');
const batchScript = fs.readFileSync(
  new URL('../../scripts/bulk-process-imported-member-fees.mjs', import.meta.url),
  'utf8',
);

test('member token claim serializes tenant/member/year and checks protected state under the lock', () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /p_tenant_id::text \|\| ':' \|\| p_member_id::text \|\| ':' \|\| p_membership_year/);
  const lockAt = migration.indexOf('pg_advisory_xact_lock');
  assert.ok(migration.indexOf('member_membership_history', lockAt) > lockAt);
  assert.ok(migration.indexOf("status = 'po_submitted'", lockAt) > lockAt);
  assert.ok(migration.indexOf("status = 'paid'", lockAt) > lockAt);
  assert.match(migration, /FOR UPDATE/);
});

test('atomic claim is server-only and batch apply fails closed when it is unavailable', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/);
  assert.match(sender, /requireAtomicMemberClaim = false/);
  assert.match(sender, /membership_fee_token_atomic_claim_unavailable/);
  assert.match(batchScript, /requireAtomicMemberClaim: true/);
});

test('atomic claim reuses one pending row and never updates PO-submitted or paid rows', () => {
  const pendingUpdateAt = migration.indexOf('UPDATE public.membership_fee_token');
  assert.ok(pendingUpdateAt > migration.indexOf("status = 'po_submitted'"));
  assert.ok(pendingUpdateAt > migration.indexOf("status = 'paid'"));
  assert.match(migration.slice(pendingUpdateAt - 900, pendingUpdateAt), /status = 'pending'/);
});