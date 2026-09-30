// One-off, idempotent data fix (Task #1164): grant Sharon admin access to
// Graduate Futures Institute (gfi).
//
// Sharon (sharon@onlinem.co.uk) could not reach the GFI admin dashboard because
// her tenant_membership for GFI was role='member' / membership_type='member'
// rather than an admin-level row. The admin dashboard rejects member-only
// access, which (combined with the now-fixed destructive session deletion in
// api/_lib/session.js) produced a 401 "cannot coerce result to single JSON
// object". The user confirmed Sharon SHOULD be an owner/admin of GFI.
//
// This script flips that single membership row to role='owner',
// membership_type='owner' and re-reads it to verify. It is idempotent (a
// re-run on an already-fixed row is a no-op) and hard-pinned to the known
// membership/identity/tenant ids so it cannot touch anything else.
//
// Usage:
//   node scripts/fix-gfi-sharon-admin-access.mjs            # dry-run (default)
//   node scripts/fix-gfi-sharon-admin-access.mjs --apply    # apply the fix
//
// Uses @supabase/supabase-js against the DESTINATION (prod) Supabase — the
// direct Postgres host is unreachable from the Replit workspace; the REST
// endpoint is IPv4-reachable. See replit.md "Database connection".

import { createClient } from '@supabase/supabase-js';

const MEMBERSHIP_ID = '05a31060-3581-414e-bf2e-041cc991b445';
const EXPECTED_IDENTITY_ID = 'dc156a30-ae8d-4aee-b965-b54fe4b17105';
const EXPECTED_TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';

const apply = process.argv.includes('--apply');

const url = process.env.DEST_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY;
if (!url || !key) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  const { data: before, error: readErr } = await supabase
    .from('tenant_membership')
    .select('id, identity_id, tenant_id, role, membership_type, status, tenant:tenant_id(name, slug)')
    .eq('id', MEMBERSHIP_ID)
    .single();

  if (readErr || !before) {
    console.error('Could not read target membership row:', readErr?.message || 'not found');
    process.exit(1);
  }

  // Safety: refuse to touch the row if it is not the expected identity/tenant.
  if (before.identity_id !== EXPECTED_IDENTITY_ID || before.tenant_id !== EXPECTED_TENANT_ID) {
    console.error('Refusing to proceed: membership row does not match expected identity/tenant.', {
      identity_id: before.identity_id,
      tenant_id: before.tenant_id,
    });
    process.exit(1);
  }

  console.log('BEFORE:', JSON.stringify(before));

  const alreadyAdmin = before.role === 'owner' && before.membership_type === 'owner';
  if (alreadyAdmin) {
    console.log('No change needed — already role=owner, membership_type=owner (idempotent no-op).');
    return;
  }

  if (!apply) {
    console.log('DRY-RUN: would set role=owner, membership_type=owner. Re-run with --apply to commit.');
    return;
  }

  const { data: after, error: updErr } = await supabase
    .from('tenant_membership')
    .update({ role: 'owner', membership_type: 'owner' })
    .eq('id', MEMBERSHIP_ID)
    .eq('identity_id', EXPECTED_IDENTITY_ID)
    .eq('tenant_id', EXPECTED_TENANT_ID)
    .select('id, identity_id, tenant_id, role, membership_type, status, tenant:tenant_id(name, slug)');

  if (updErr) {
    console.error('Update failed:', updErr.message);
    process.exit(1);
  }

  console.log('AFTER:', JSON.stringify(after));
  console.log('Done — Sharon now has owner-level admin access to Graduate Futures Institute.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
