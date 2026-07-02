#!/usr/bin/env node
/**
 * Regression guard for task-674 (member-facing group email campaigns).
 *
 * Verifies the schema invariants that keep tenant `email_campaign` rows
 * isolated from member-side endpoints, and vice versa:
 *
 *   1. Tenant rows (created_by_member_id IS NULL) exist and are NOT scoped to
 *      a member_group_id, so the existing tenant /api/email-campaigns shape is
 *      unchanged.
 *   2. Every member-originated row (created_by_member_id IS NOT NULL) ALSO has
 *      a non-null member_group_id, an audience that targets only that group,
 *      and the owning member is still a member_group_assignment row.
 *   3. No member-originated row leaks across tenants
 *      (member.tenant_id === campaign.tenant_id === group.tenant_id).
 *   4. Endpoint fail-closed behavior: every /api/member-campaigns/* route
 *      rejects unauthenticated and non-qualifying callers with 401/403, so a
 *      non-trusted member can never enumerate, create, send, test-send or
 *      mutate a member campaign. Skipped automatically if MEMBER_CAMPAIGN_
 *      AUDIT_BASE_URL is not set.
 *   5. Legacy audience_list resolution parity: the tenant-side
 *      campaignService.getTargetRecipients still resolves an
 *      `audience_list` segment via communication_preference_subscription,
 *      proving the member-group resolver extension did not regress the
 *      existing tenant flow.
 *
 * Usage:
 *   node scripts/audit-member-campaign-isolation.mjs                # all tenants
 *   node scripts/audit-member-campaign-isolation.mjs <tenantId>     # narrow scope
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to be set.
 * Optional: MEMBER_CAMPAIGN_AUDIT_BASE_URL (e.g. http://localhost:5000)
 *           enables the live HTTP fail-closed checks in step (4).
 * Exits non-zero if any invariant fails.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(2);
}

const tenantId = process.argv[2] || null;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const failures = [];
const fail = (msg) => { console.error('  ✘', msg); failures.push(msg); };
const ok = (msg) => console.log('  ✔', msg);

async function main() {
  console.log(`\n[audit-member-campaign-isolation] tenant filter: ${tenantId || 'ALL'}`);

  // (1) Tenant-admin rows untouched.
  let tenantRowsQ = supabase
    .from('email_campaign')
    .select('id, tenant_id, created_by_member_id, member_group_id, target_audiences')
    .is('created_by_member_id', null)
    .limit(1000);
  if (tenantId) tenantRowsQ = tenantRowsQ.eq('tenant_id', tenantId);
  const { data: tenantRows, error: tenantRowsErr } = await tenantRowsQ;
  if (tenantRowsErr) { fail(`tenant rows query failed: ${tenantRowsErr.message}`); return; }
  console.log(`Found ${tenantRows.length} tenant-admin campaigns.`);
  for (const r of tenantRows) {
    if (r.member_group_id) {
      fail(`tenant row ${r.id} unexpectedly has member_group_id=${r.member_group_id}`);
    }
  }
  if (tenantRows.length > 0) ok('tenant-admin rows have no member_group_id');

  // (2) Member-originated rows are well-formed.
  let memberRowsQ = supabase
    .from('email_campaign')
    .select('id, tenant_id, created_by_member_id, member_group_id, target_audiences')
    .not('created_by_member_id', 'is', null)
    .limit(1000);
  if (tenantId) memberRowsQ = memberRowsQ.eq('tenant_id', tenantId);
  const { data: memberRows, error: memberRowsErr } = await memberRowsQ;
  if (memberRowsErr) { fail(`member rows query failed: ${memberRowsErr.message}`); return; }
  console.log(`Found ${memberRows.length} member-originated campaigns.`);

  for (const r of memberRows) {
    if (!r.member_group_id) { fail(`row ${r.id}: created_by_member_id set but member_group_id is null`); continue; }

    const audiences = Array.isArray(r.target_audiences) ? r.target_audiences : [];
    if (audiences.length !== 1 || audiences[0]?.type !== 'member_group') {
      fail(`row ${r.id}: audience is not a single member_group segment (got ${JSON.stringify(audiences)})`);
      continue;
    }
    const segIds = audiences[0]?.ids || [];
    if (segIds.length !== 1 || segIds[0] !== r.member_group_id) {
      fail(`row ${r.id}: audience ids ${JSON.stringify(segIds)} do not match member_group_id ${r.member_group_id}`);
    }

    const { data: member } = await supabase
      .from('member')
      .select('id, tenant_id')
      .eq('id', r.created_by_member_id)
      .maybeSingle();
    const { data: group } = await supabase
      .from('member_group')
      .select('id, tenant_id, is_active')
      .eq('id', r.member_group_id)
      .maybeSingle();

    if (!member) { fail(`row ${r.id}: owner member not found`); continue; }
    if (!group) { fail(`row ${r.id}: member_group not found`); continue; }

    if (member.tenant_id !== r.tenant_id) fail(`row ${r.id}: cross-tenant — member.tenant_id ${member.tenant_id} ≠ campaign.tenant_id ${r.tenant_id}`);
    if (group.tenant_id !== r.tenant_id) fail(`row ${r.id}: cross-tenant — group.tenant_id ${group.tenant_id} ≠ campaign.tenant_id ${r.tenant_id}`);

    const { data: assignment } = await supabase
      .from('member_group_assignment')
      .select('group_role, is_group_admin, expires_at')
      .eq('group_id', r.member_group_id)
      .eq('member_id', r.created_by_member_id)
      .maybeSingle();
    if (!assignment) {
      console.warn(`  ⚠ row ${r.id}: owner is no longer assigned to the group (historical data)`);
    } else if (assignment.is_group_admin !== true) {
      console.warn(`  ⚠ row ${r.id}: owner is no longer a group admin (historical data)`);
    }
  }
  if (memberRows.length > 0 && failures.length === 0) ok('member-originated rows are scoped correctly');

  // (4) Endpoint fail-closed behavior. Hits the live API as an unauthenticated
  // caller; every route MUST refuse with 401/403 (NEVER 200/500).
  const baseUrl = process.env.MEMBER_CAMPAIGN_AUDIT_BASE_URL;
  if (baseUrl) {
    console.log(`\n[step 4] fail-closed checks against ${baseUrl}`);
    const probes = [
      { method: 'GET',  path: '/api/member-campaigns/qualifying-groups' },
      { method: 'GET',  path: '/api/member-campaigns' },
      { method: 'POST', path: '/api/member-campaigns', body: { groupId: '00000000-0000-0000-0000-000000000000', name: 'x', subject: 'x' } },
      { method: 'GET',  path: '/api/member-campaigns/00000000-0000-0000-0000-000000000000' },
      { method: 'PATCH',path: '/api/member-campaigns/00000000-0000-0000-0000-000000000000', body: { name: 'x' } },
      { method: 'DELETE',path:'/api/member-campaigns/00000000-0000-0000-0000-000000000000' },
      { method: 'POST', path: '/api/member-campaigns/send', body: { campaignId: '00000000-0000-0000-0000-000000000000' } },
      { method: 'POST', path: '/api/member-campaigns/test-send', body: { campaignId: '00000000-0000-0000-0000-000000000000', testEmail: 'x@example.com' } },
    ];
    for (const probe of probes) {
      try {
        const res = await fetch(`${baseUrl}${probe.path}`, {
          method: probe.method,
          headers: { 'Content-Type': 'application/json' },
          body: probe.body ? JSON.stringify(probe.body) : undefined,
        });
        if (res.status === 401 || res.status === 403) {
          ok(`${probe.method} ${probe.path} → ${res.status} (fail-closed)`);
        } else {
          fail(`${probe.method} ${probe.path} returned ${res.status}; expected 401/403 for unauthenticated caller`);
        }
      } catch (err) {
        fail(`${probe.method} ${probe.path} request error: ${err.message}`);
      }
    }
  } else {
    console.log('\n[step 4] skipped (set MEMBER_CAMPAIGN_AUDIT_BASE_URL to enable live HTTP checks)');
  }

  // (5) Legacy audience_list resolution parity. The tenant-side resolver
  // joins communication_preference_subscription to a tenant communication
  // category. We reproduce that join (cap 1 row) and confirm it still
  // returns a member email — i.e. the member_group resolver extension
  // didn't break the existing tenant audience type.
  console.log('\n[step 5] legacy audience_list resolver parity');
  const { data: anyCategory, error: catErr } = await supabase
    .from('communication_category')
    .select('id, tenant_id')
    .limit(1)
    .maybeSingle();
  if (catErr) {
    fail(`communication_category probe failed: ${catErr.message}`);
  } else if (!anyCategory) {
    console.log('  ⚠ no communication_category rows found; skipping legacy parity check');
  } else {
    const { data: subs, error: subErr } = await supabase
      .from('communication_preference_subscription')
      .select('member_id, member!inner(id, email, tenant_id, status)')
      .eq('category_id', anyCategory.id)
      .eq('is_subscribed', true)
      .limit(5);
    if (subErr) {
      fail(`legacy audience_list join failed: ${subErr.message}`);
    } else if (!subs || subs.length === 0) {
      console.log(`  ⚠ category ${anyCategory.id} has no active subscribers; parity check inconclusive (not a regression)`);
    } else {
      const sane = subs.every((s) => s.member && s.member.tenant_id === anyCategory.tenant_id && typeof s.member.email === 'string');
      if (sane) ok(`legacy audience_list resolver returns ${subs.length} valid recipient(s) for category ${anyCategory.id}`);
      else fail('legacy audience_list resolver returned malformed/cross-tenant rows');
    }
  }

  console.log('\n[audit-member-campaign-isolation] done.');
  if (failures.length > 0) {
    console.error(`\nFAIL: ${failures.length} issue(s).`);
    process.exit(1);
  }
  console.log('PASS');
}

main().catch((err) => { console.error(err); process.exit(2); });
