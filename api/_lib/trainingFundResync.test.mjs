// Source-level regression tests for the training fund balance resync tool.
//
// The resync RPC is a SECURITY DEFINER function that writes balances from
// arbitrary tenant/org ids, so its migration MUST lock down execution and
// extend the ledger type check constraint, or the feature is either a
// security hole or fails at insert time. These tests pin those invariants,
// plus the endpoint/UI surfaces every ledger `type` must be wired through.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const migration = read('supabase/migrations/20260811_resync_training_fund_balance.sql');

test('resync migration extends the ledger type check constraint with resync', () => {
  assert.match(migration, /training_fund_transaction_type_check/);
  assert.match(migration, /'resync'::text/);
});

test('resync RPC is SECURITY DEFINER with locked-down execution', () => {
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path = public, pg_temp/);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION resync_training_fund_balance\(uuid, uuid, uuid, boolean\) FROM PUBLIC/);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION resync_training_fund_balance\(uuid, uuid, uuid, boolean\) FROM anon/);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION resync_training_fund_balance\(uuid, uuid, uuid, boolean\) FROM authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION resync_training_fund_balance\(uuid, uuid, uuid, boolean\) TO service_role/);
});

test('resync audit row is zero-delta so it cannot reintroduce drift', () => {
  // balance_before = balance_after = the ledger-derived value, amount 0.
  assert.match(migration, /'resync',\s*0,\s*\n\s*v_ledger,\s*v_ledger/);
});

test('resync endpoint enforces admin access and supports dry-run', () => {
  const endpoint = read('api/admin/training-fund-transactions/resync.js');
  assert.match(endpoint, /getTenantContext/);
  assert.match(endpoint, /hasAdminAccess/);
  assert.match(endpoint, /p_dry_run: dry_run === true/);
  assert.match(endpoint, /resync_training_fund_balance/);
});

test('resync ledger type has label cases on both display surfaces', () => {
  assert.match(read('client/src/pages/TrainingFundManagement.jsx'), /case 'resync':/);
  assert.match(read('api/admin/training-fund-transactions/export-csv.js'), /case 'resync':/);
});
