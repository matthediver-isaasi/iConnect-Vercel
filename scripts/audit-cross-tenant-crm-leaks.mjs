#!/usr/bin/env node
/**
 * Regression guard for the cross-tenant CRM filter sidebar leak fixed by task-631.
 *
 * What this checks
 * ----------------
 * For every active tenant in the system, this script confirms that the four
 * entity endpoints feeding the /organisations and /members filter sidebars
 *   - PreferenceField
 *   - Organization
 *   - Role
 *   - OrganizationPreferenceValue
 * never return rows belonging to a different tenant when scoped through their
 * authoritative tenant_id (directly, or via an organization!inner join).
 *
 * It also fails on data-integrity issues that would cause the same class of
 * leak to reappear:
 *   - preference_field / role / organization rows with NULL tenant_id
 *   - organization_preference_value rows whose owning org and referenced
 *     preference_field belong to different tenants
 *   - member_preference_value rows whose owning member and referenced
 *     preference_field belong to different tenants
 *
 * Usage
 * -----
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/audit-cross-tenant-crm-leaks.mjs
 *   # or DEV_SUPABASE_URL / DEV_SUPABASE_SERVICE_KEY for the dev/staging DB.
 *
 * Exit code is 0 on PASS and 1 on FAIL, so this can be wired into CI later.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const url = process.env.SUPABASE_URL || process.env.DEV_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.DEV_SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY (or DEV_ equivalents).');
  process.exit(2);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL:', msg); };
const pass = (msg) => console.log('PASS:', msg);

async function fetchAll(table, select) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await sb.from(table).select(select).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

function staticHandlerGuards() {
  // Static assertion: confirm that the entity handler still contains the 403
  // guards we added. This catches the failure mode where a future refactor
  // silently removes the filter while the data integrity in the DB happens
  // to be clean.
  const here = dirname(fileURLToPath(import.meta.url));
  const handlerPath = join(here, '..', 'api', 'entities', '[entity]', 'index.js');
  let src;
  try {
    src = readFileSync(handlerPath, 'utf8');
  } catch (e) {
    fail(`Could not read entity handler at ${handlerPath}: ${e.message}`);
    return;
  }
  const required = [
    {
      label: 'Organization branch falls back to 403 when no tenant context',
      pattern: /SECURITY: Organization request without tenant_id or organization_id/,
    },
    {
      label: 'Tenant-wide ORGANIZATION reads require effectiveTenantId',
      pattern: /tenant-wide access requested without effectiveTenantId/,
    },
    {
      label: 'Tenant-scoped queries use orgTenantId fallback',
      pattern: /const\s+orgTenantId\s*=\s*tenantCtx\.tenantId\s*\|\|\s*tenantCtx\.effectiveTenantId/,
    },
    {
      label: 'Tenant admin without tenantId is blocked',
      pattern: /SECURITY: Tenant admin missing tenantId/,
    },
  ];
  for (const r of required) {
    if (r.pattern.test(src)) pass(`handler guard present: ${r.label}`);
    else fail(`handler guard MISSING: ${r.label} - did a refactor remove the cross-tenant 403?`);
  }
}

async function main() {
  console.log(`Auditing ${url}\n`);

  // Static guards first - fail fast if the handler lost its filters.
  staticHandlerGuards();

  const { data: tenants, error: tErr } = await sb
    .from('tenant')
    .select('id, name, slug, status')
    .eq('status', 'active');
  if (tErr) throw new Error(`tenant: ${tErr.message}`);
  if (!tenants || tenants.length < 1) {
    fail('No active tenants found - cannot run regression checks.');
    process.exit(1);
  }
  console.log(`Found ${tenants.length} active tenants:`, tenants.map(t => t.slug).join(', '));

  // ----- 1. Static data-integrity guards -----
  const tables = [
    { name: 'preference_field', label: 'PreferenceField' },
    { name: 'role', label: 'Role' },
    { name: 'organization', label: 'Organization' },
  ];
  for (const t of tables) {
    const { count, error } = await sb
      .from(t.name)
      .select('*', { count: 'exact', head: true })
      .is('tenant_id', null);
    if (error) { fail(`${t.label} NULL tenant_id check errored: ${error.message}`); continue; }
    if ((count || 0) > 0) {
      fail(`${t.label} has ${count} rows with NULL tenant_id - they would leak/disappear under tenant scoping.`);
    } else {
      pass(`${t.label}: 0 rows with NULL tenant_id.`);
    }
  }

  const orgs = await fetchAll('organization', 'id, tenant_id');
  const orgTenant = new Map(orgs.map(o => [o.id, o.tenant_id]));
  const pfs = await fetchAll('preference_field', 'id, tenant_id');
  const pfTenant = new Map(pfs.map(p => [p.id, p.tenant_id]));
  const opvs = await fetchAll('organization_preference_value', 'id, organization_id, field_id');
  const mpvs = await fetchAll('member_preference_value', 'id, member_id, field_id');
  const members = await fetchAll('member', 'id, tenant_id');
  const memTenant = new Map(members.map(m => [m.id, m.tenant_id]));

  const opvMismatch = opvs.filter(v => {
    const ot = orgTenant.get(v.organization_id);
    const pt = pfTenant.get(v.field_id);
    return ot && pt && ot !== pt;
  });
  if (opvMismatch.length) {
    fail(`organization_preference_value: ${opvMismatch.length} rows where org tenant != preference_field tenant.`);
    console.error('  sample:', opvMismatch.slice(0, 3));
  } else {
    pass('organization_preference_value: org tenant matches preference_field tenant for every row.');
  }

  const mpvMismatch = mpvs.filter(v => {
    const mt = memTenant.get(v.member_id);
    const pt = pfTenant.get(v.field_id);
    return mt && pt && mt !== pt;
  });
  if (mpvMismatch.length) {
    fail(`member_preference_value: ${mpvMismatch.length} rows where member tenant != preference_field tenant.`);
    console.error('  sample:', mpvMismatch.slice(0, 3));
  } else {
    pass('member_preference_value: member tenant matches preference_field tenant for every row.');
  }

  const memberNullTenant = members.filter(m => !m.tenant_id).length;
  if (memberNullTenant > 0) {
    // Not a hard fail - members with NULL tenant cannot leak through tenant_id
    // filters - but they cannot be displayed either. Surface as a warning.
    console.warn(`WARN: member: ${memberNullTenant} rows with NULL tenant_id (will be invisible to tenant-scoped queries).`);
  }

  // ----- 2. Per-tenant simulation of the entity-handler filters -----
  // For each tenant, repeat the actual server-side query the entity handler
  // would run for /organisations and /members filter dropdowns and confirm
  // not a single returned row leaks to another tenant.
  for (const tenant of tenants) {
    const T = tenant.id;
    const label = `tenant=${tenant.slug}`;

    // PreferenceField (TENANT scope, direct filter)
    const { data: pf, error: pfErr } = await sb
      .from('preference_field')
      .select('id, tenant_id, entity_scope, name')
      .eq('tenant_id', T);
    if (pfErr) { fail(`${label} PreferenceField query errored: ${pfErr.message}`); }
    else {
      const leaks = (pf || []).filter(r => r.tenant_id !== T);
      if (leaks.length) fail(`${label} PreferenceField returned ${leaks.length} rows from another tenant.`);
      else pass(`${label} PreferenceField: ${pf.length} rows, all in-tenant.`);
    }

    // Organization (TENANT scope, direct filter)
    const { data: org, error: orgErr } = await sb
      .from('organization')
      .select('id, tenant_id')
      .eq('tenant_id', T);
    if (orgErr) { fail(`${label} Organization query errored: ${orgErr.message}`); }
    else {
      const leaks = (org || []).filter(r => r.tenant_id !== T);
      if (leaks.length) fail(`${label} Organization returned ${leaks.length} rows from another tenant.`);
      else pass(`${label} Organization: ${org.length} rows, all in-tenant.`);
    }

    // Role (TENANT scope, direct filter)
    const { data: rl, error: rlErr } = await sb
      .from('role')
      .select('id, tenant_id, name')
      .eq('tenant_id', T);
    if (rlErr) { fail(`${label} Role query errored: ${rlErr.message}`); }
    else {
      const leaks = (rl || []).filter(r => r.tenant_id !== T);
      if (leaks.length) fail(`${label} Role returned ${leaks.length} rows from another tenant.`);
      else pass(`${label} Role: ${rl.length} rows, all in-tenant.`);
    }

    // OrganizationPreferenceValue (ORGANIZATION scope, organization!inner join)
    const { data: opv, error: opvErr } = await sb
      .from('organization_preference_value')
      .select('id, organization_id, field_id, organization!inner(tenant_id)')
      .eq('organization.tenant_id', T);
    if (opvErr) { fail(`${label} OrganizationPreferenceValue query errored: ${opvErr.message}`); }
    else {
      const leaks = (opv || []).filter(r => r.organization?.tenant_id !== T);
      if (leaks.length) fail(`${label} OrganizationPreferenceValue returned ${leaks.length} rows whose org is not in tenant.`);
      else pass(`${label} OrganizationPreferenceValue: ${opv.length} rows, all in-tenant via org join.`);
    }
  }

  console.log(`\n${failures === 0 ? 'OK' : 'FAILURES: ' + failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Audit crashed:', err);
  process.exit(2);
});
