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
 *      and the owning member is still a member_group_assignment row whose
 *      group_role is in member_group.ems_enabled_roles.
 *   3. No member-originated row leaks across tenants
 *      (member.tenant_id === campaign.tenant_id === group.tenant_id).
 *
 * Usage:
 *   node scripts/audit-member-campaign-isolation.mjs                # all tenants
 *   node scripts/audit-member-campaign-isolation.mjs <tenantId>     # narrow scope
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to be set.
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
      .select('id, tenant_id, ems_enabled_roles, is_active')
      .eq('id', r.member_group_id)
      .maybeSingle();

    if (!member) { fail(`row ${r.id}: owner member not found`); continue; }
    if (!group) { fail(`row ${r.id}: member_group not found`); continue; }

    if (member.tenant_id !== r.tenant_id) fail(`row ${r.id}: cross-tenant — member.tenant_id ${member.tenant_id} ≠ campaign.tenant_id ${r.tenant_id}`);
    if (group.tenant_id !== r.tenant_id) fail(`row ${r.id}: cross-tenant — group.tenant_id ${group.tenant_id} ≠ campaign.tenant_id ${r.tenant_id}`);

    const { data: assignment } = await supabase
      .from('member_group_assignment')
      .select('group_role, expires_at')
      .eq('group_id', r.member_group_id)
      .eq('member_id', r.created_by_member_id)
      .maybeSingle();
    if (!assignment) {
      console.warn(`  ⚠ row ${r.id}: owner is no longer assigned to the group (historical data)`);
    } else {
      const allowed = Array.isArray(group.ems_enabled_roles) ? group.ems_enabled_roles : [];
      if (!allowed.includes(assignment.group_role)) {
        console.warn(`  ⚠ row ${r.id}: owner role "${assignment.group_role}" no longer in ems_enabled_roles (historical data)`);
      }
    }
  }
  if (memberRows.length > 0 && failures.length === 0) ok('member-originated rows are scoped correctly');

  console.log('\n[audit-member-campaign-isolation] done.');
  if (failures.length > 0) {
    console.error(`\nFAIL: ${failures.length} issue(s).`);
    process.exit(1);
  }
  console.log('PASS');
}

main().catch((err) => { console.error(err); process.exit(2); });
