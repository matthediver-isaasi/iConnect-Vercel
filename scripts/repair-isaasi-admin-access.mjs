// Task #1054: Repair iSaaSi admin access.
//
// Ensures Mat (mat@teeone.co.uk) has:
//   - An active 'owner' tenant_membership on the iSaaSi tenant.
//   - A tenant_membership_credentials row for (identity_id, tenant_id) carrying
//     a fresh 24h reset_token.
// Then prints a working setup URL:
//   https://iconn.app/admin/login?setup=<token>&email=mat%40teeone.co.uk
//
// Idempotent: re-runs will not duplicate rows; they will always mint a fresh
// reset token and print a usable URL.
//
// Run: node scripts/repair-isaasi-admin-access.mjs

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const TENANT_SLUG = 'isaasi';
const ADMIN_EMAIL = 'mat@teeone.co.uk';

export async function ensureOwnerMembershipAndCredentials({ supabase, tenantId, identityId, email }) {
  const changes = [];

  // 1) Ensure a member row exists (membership.member_id is required on insert
  //    for legacy schema compatibility; we re-use one if present).
  const { data: existingMember } = await supabase
    .from('member')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('identity_id', identityId)
    .maybeSingle();
  let memberId = existingMember?.id || null;

  // 2) Ensure owner tenant_membership
  const { data: existingMembership } = await supabase
    .from('tenant_membership')
    .select('id, member_id, status, membership_type')
    .eq('identity_id', identityId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (existingMembership) {
    const patch = {};
    if (existingMembership.status !== 'active') patch.status = 'active';
    if (existingMembership.membership_type !== 'owner') patch.membership_type = 'owner';
    if (memberId && !existingMembership.member_id) patch.member_id = memberId;
    if (Object.keys(patch).length > 0) {
      const { error } = await supabase
        .from('tenant_membership')
        .update(patch)
        .eq('id', existingMembership.id);
      if (error) throw new Error(`Failed to update tenant_membership: ${error.message}`);
      changes.push(`updated tenant_membership ${existingMembership.id} (${Object.keys(patch).join(',')})`);
    } else {
      changes.push(`tenant_membership ${existingMembership.id} already correct`);
    }
  } else {
    const insertPayload = {
      identity_id: identityId,
      tenant_id: tenantId,
      role: 'owner',
      membership_type: 'owner',
      status: 'active',
      is_default: true,
    };
    if (memberId) insertPayload.member_id = memberId;
    const { data: newMembership, error } = await supabase
      .from('tenant_membership')
      .insert(insertPayload)
      .select('id')
      .single();
    if (error) throw new Error(`Failed to insert tenant_membership: ${error.message}`);
    changes.push(`created tenant_membership ${newMembership.id}`);
  }

  // 3) Upsert tenant_membership_credentials with a fresh reset token (24h)
  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { data: existingCreds } = await supabase
    .from('tenant_membership_credentials')
    .select('id')
    .eq('identity_id', identityId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (existingCreds) {
    const { error } = await supabase
      .from('tenant_membership_credentials')
      .update({ reset_token: resetToken, reset_token_expires: resetExpires })
      .eq('id', existingCreds.id);
    if (error) throw new Error(`Failed to update tenant_membership_credentials: ${error.message}`);
    changes.push(`refreshed reset_token on tenant_membership_credentials ${existingCreds.id}`);
  } else {
    const { data: newCreds, error } = await supabase
      .from('tenant_membership_credentials')
      .insert({
        identity_id: identityId,
        tenant_id: tenantId,
        reset_token: resetToken,
        reset_token_expires: resetExpires,
      })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to insert tenant_membership_credentials: ${error.message}`);
    changes.push(`created tenant_membership_credentials ${newCreds.id} with reset_token`);
  }

  const setupUrl = `https://iconn.app/admin/login?setup=${resetToken}&email=${encodeURIComponent(email)}`;
  return { resetToken, setupUrl, changes };
}

async function main() {
  console.log('=== Repairing iSaaSi admin access ===');

  const { data: tenant, error: tErr } = await sb
    .from('tenant')
    .select('id, slug, name')
    .eq('slug', TENANT_SLUG)
    .single();
  if (tErr || !tenant) {
    console.error(`Could not find tenant slug=${TENANT_SLUG}:`, tErr?.message);
    process.exit(1);
  }
  console.log(`tenant: ${tenant.id} (${tenant.slug})`);

  const { data: identity, error: iErr } = await sb
    .from('tenant_identity')
    .select('id, email')
    .ilike('email', ADMIN_EMAIL)
    .single();
  if (iErr || !identity) {
    console.error(`Could not find tenant_identity for ${ADMIN_EMAIL}:`, iErr?.message);
    process.exit(1);
  }
  console.log(`identity: ${identity.id} (${identity.email})`);

  const { setupUrl, changes } = await ensureOwnerMembershipAndCredentials({
    supabase: sb,
    tenantId: tenant.id,
    identityId: identity.id,
    email: identity.email,
  });

  for (const change of changes) {
    console.log(`[ok] ${change}`);
  }
  console.log('\n=== DONE ===');
  console.log(`Setup URL: ${setupUrl}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
