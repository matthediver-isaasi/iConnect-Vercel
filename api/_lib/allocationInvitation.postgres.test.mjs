import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migrationPath = fileURLToPath(new URL(
  '../../supabase/migrations/20260912_sales_allocation_delegate_registration.sql',
  import.meta.url,
));
const sql = await readFile(migrationPath, 'utf8');

test('delegate migration stores hashes and enforces single-use expiring claims', () => {
  assert.match(sql, /token_hash bytea NOT NULL/i);
  assert.doesNotMatch(sql, /\btoken text\b/i);
  assert.match(sql, /octet_length\(token_hash\)=32/i);
  assert.match(sql, /claimed_at IS NULL AND released_at IS NULL AND expires_at>now\(\)/i);
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /invalid, expired, or used allocation invitation/i);
});

test('reservation and claim use shared ticket advisory locks and balanced movements', () => {
  assert.match(sql, /reserve_sales_allocation_invitation[\s\S]*pg_advisory_xact_lock/i);
  assert.match(sql, /claim_sales_allocation_invitation[\s\S]*pg_advisory_xact_lock/i);
  assert.match(sql, /'reserved',1/i);
  assert.match(sql, /'unreserved',1,'invite-claim-unreserve:/i);
  assert.match(sql, /'named',1,'invite-claim:/i);
  assert.match(sql, /'unreserved',1,'invite-release:/i);
});

test('all delegate SECURITY DEFINER RPCs are service-role only', () => {
  for (const name of [
    'grant_sales_allocation_manager',
    'reserve_sales_allocation_invitation',
    'resolve_sales_allocation_invitation',
    'claim_sales_allocation_invitation',
    'release_sales_allocation_invitation',
  ]) {
    assert.match(sql, new RegExp(`${name}[\\s\\S]*SECURITY DEFINER`, 'i'));
  }
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC,anon,authenticated/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/i);
});
test('allocation claims are delayed until after ordinary booking capacity verification', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const simple = await readFile(fileURLToPath(new URL('../functions/[functionName].js', import.meta.url)), 'utf8');
  const complex = await readFile(fileURLToPath(new URL('../public/complex-event-booking.js', import.meta.url)), 'utf8');
  assert.ok(simple.indexOf("check_oneoff_ticket_capacity") < simple.lastIndexOf("claimAllocationInvitation"));
  assert.ok(complex.indexOf("rollbackFinancialDeductions") < complex.lastIndexOf("claimAllocationInvitation"));
  assert.match(complex, /await rollbackFinancialDeductions\(\);[\s\S]*await rollbackBookingsAndSeats\(\);[\s\S]*await refundCardPayment\(\)/);
});

test('tenant admins can reserve before a manager grant using sale ownership', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const sql = await readFile(fileURLToPath(new URL('../../supabase/migrations/20260912_sales_allocation_delegate_registration.sql', import.meta.url)), 'utf8');
  const reserve = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.reserve_sales_allocation_invitation'));
  assert.match(sql, /ALTER COLUMN manager_id DROP NOT NULL/);
  assert.match(reserve, /p_actor_kind='member'[\s\S]*allocation manager access denied/);
  assert.match(reserve, /JOIN public\.sales_commercial_sale[\s\S]*JOIN public\.opportunity/);
  assert.match(reserve, /v_manager:=NULL/);
});

test('reservation idempotency is actor-bound and checked under the capacity lock', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const sql = await readFile(fileURLToPath(new URL('../../supabase/migrations/20260912_sales_allocation_delegate_registration.sql', import.meta.url)), 'utf8');
  const reserve = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.reserve_sales_allocation_invitation'));
  assert.match(sql, /sales_allocation_invitation_idempotency[\s\S]*tenant_id,allocation_id,actor_kind,actor_id,idempotency_key/);
  assert.ok(reserve.indexOf('pg_advisory_xact_lock') < reserve.indexOf('AND idempotency_key=p_idempotency_key'));
  assert.ok(reserve.indexOf('AND idempotency_key=p_idempotency_key') < reserve.indexOf("'reserved',1,p_idempotency_key"));
  assert.match(reserve, /'replayed',true/);
  assert.match(reserve, /v_existing_claimed IS NOT NULL OR v_existing_released IS NOT NULL[\s\S]*v_existing_expires<=now\(\)/);
  assert.match(reserve, /invitation request key is no longer reusable; use a new idempotency key[\s\S]*ERRCODE='23514'/);
});
