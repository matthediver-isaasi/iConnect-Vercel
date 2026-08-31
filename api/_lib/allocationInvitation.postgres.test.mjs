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

test('claim locks the source booking before the shared ticket lock', async () => {
  const migration = await readFile(fileURLToPath(new URL(
    '../../supabase/migrations/20260913_sales_concurrency_hardening.sql', import.meta.url,
  )), 'utf8');
  const claim = migration.slice(migration.indexOf('claim_sales_allocation_invitation'));
  assert.ok(claim.indexOf("IF p_booking_kind='simple'") < claim.lastIndexOf('pg_advisory_xact_lock'),
    'booking row must be locked before the ticket advisory lock');
  assert.match(claim, /booking is already reconciled to an allocation/);
  assert.match(claim, /REVOKE ALL ON FUNCTION public\.claim_sales_allocation_invitation/);
});

test('reservation locks expired invitations before the shared ticket lock', async () => {
  const migration = await readFile(fileURLToPath(new URL(
    '../../supabase/migrations/20260913_sales_concurrency_hardening.sql', import.meta.url,
  )), 'utf8');
  const reserve = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION public.reserve_sales_allocation_invitation'),
    migration.indexOf('CREATE OR REPLACE FUNCTION public.claim_sales_allocation_invitation'),
  );
  assert.ok(reserve.indexOf('ORDER BY id FOR UPDATE') < reserve.indexOf('pg_advisory_xact_lock'),
    'expired invitation rows must be locked before the ticket advisory lock');
  assert.match(reserve, /REVOKE ALL ON FUNCTION public\.reserve_sales_allocation_invitation/);
});

test('booking cancellation does not confuse invite conversion with unreconciliation', async () => {
  const migration = await readFile(fileURLToPath(new URL(
    '../../supabase/migrations/20260913_sales_concurrency_hardening.sql', import.meta.url,
  )), 'utf8');
  const unreconcile = migration.slice(
    migration.indexOf('DROP INDEX IF EXISTS public.sales_allocation_booking_unreconciled_once'),
    migration.indexOf('CREATE OR REPLACE FUNCTION public.reserve_sales_allocation_invitation'),
  );
  assert.match(unreconcile, /movement_kind='unnamed'[\s\S]*NOT \(metadata \? 'invitationId'\)/);
  assert.match(unreconcile, /NOT \(m\.movement_kind='unreserved' AND m\.metadata \? 'invitationId'\)/);
  assert.match(unreconcile, /REVOKE ALL ON FUNCTION public\.unreconcile_sales_commercial_booking/);
});

test('public quote rate limits are shared, hashed, bounded, and service-role only', async () => {
  const migration = await readFile(fileURLToPath(new URL(
    '../../supabase/migrations/20260913_sales_concurrency_hardening.sql', import.meta.url,
  )), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.sales_quote_public_rate_limit/);
  assert.match(migration, /PRIMARY KEY \(token_hash, client_key_hash\)/);
  assert.match(migration, /digest\(p_client_key, 'sha256'\)/);
  assert.match(migration, /ON CONFLICT \(token_hash, client_key_hash\) DO UPDATE SET/);
  assert.match(migration, /LIMIT 100/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.consume_sales_quote_public_rate_limit/);
  assert.match(migration, /TO service_role/);
});
