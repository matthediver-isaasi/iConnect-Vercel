/**
 * Backfill member_class=Alumni for GFI Alumni Community members
 *
 * For every member in the GFI (Graduate Futures Institute) tenant who holds
 * the "Alumni Community" role — via either their primary member.role_id or
 * the multi-role member_role association table — sets their `member_class`
 * custom preference field to the value "Alumni".
 *
 * The script is idempotent: a second --apply run will report all rows as
 * already-correct and make no changes.
 *
 * Usage:
 *   node scripts/backfill-gfi-alumni-member-class.mjs              # Dry run (default)
 *   node scripts/backfill-gfi-alumni-member-class.mjs --apply      # Apply writes
 *   node scripts/backfill-gfi-alumni-member-class.mjs --tenant=<uuid>  # Override auto-detection
 *
 * IMPORTANT: Even with --tenant, the script validates that the resolved tenant
 * name/slug matches "Graduate Futures" or "GFI" and refuses to run against any
 * other tenant. This prevents accidental cross-tenant writes.
 *
 * Prerequisites:
 *   DEST_SUPABASE_URL and DEST_SUPABASE_KEY env vars must be set.
 *   The `member_class` preference_field must already exist for the GFI tenant
 *   (the script fails loudly if it is missing — it will NOT create it).
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL || 'https://lvmzliemqnieeoruhkik.supabase.co';
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;

if (!SUPABASE_KEY) {
  console.error('ERROR: DEST_SUPABASE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TENANT_OVERRIDE = args.find(a => a.startsWith('--tenant='))?.split('=')[1];

const BATCH_SIZE = 500;
const TARGET_VALUE = 'Alumni';
const ROLE_NAME = 'Alumni Community';
const FIELD_NAME = 'member_class';

/** Returns true when the tenant name/slug confirms this is the GFI tenant. */
function isGfiTenant(tenant) {
  const name = (tenant.name || '').toLowerCase();
  const slug = (tenant.slug || '').toLowerCase();
  return (
    name.includes('graduate futures') ||
    name.includes('gfi') ||
    slug.includes('gfi')
  );
}

console.log('='.repeat(60));
console.log('GFI Alumni Community — member_class backfill');
console.log('='.repeat(60));
console.log(`Mode: ${APPLY ? 'APPLY (writes will be made)' : 'DRY RUN (no changes will be made)'}`);
if (TENANT_OVERRIDE) console.log(`Tenant override: ${TENANT_OVERRIDE}`);
console.log('');

// ─── Step 1: Resolve GFI tenant ──────────────────────────────────────────────

async function resolveGfiTenant() {
  if (TENANT_OVERRIDE) {
    const { data, error } = await supabase
      .from('tenant')
      .select('id, name, slug')
      .eq('id', TENANT_OVERRIDE)
      .single();

    if (error || !data) {
      console.error(`ERROR: --tenant override ${TENANT_OVERRIDE} not found:`, error?.message || 'no record');
      process.exit(1);
    }

    // Safety check: even with an override, refuse to run against a non-GFI tenant.
    if (!isGfiTenant(data)) {
      console.error(
        `ERROR: --tenant override ${TENANT_OVERRIDE} resolved to "${data.name}" ` +
        `(slug: "${data.slug}") which does not appear to be the GFI tenant.`
      );
      console.error(
        'This script is GFI-only. If this tenant IS GFI, contact the developer ' +
        'to update the GFI detection logic in isGfiTenant().'
      );
      process.exit(1);
    }

    console.log(`Tenant (override): "${data.name}" (slug: ${data.slug}, id: ${data.id})`);
    return data;
  }

  // Auto-detect GFI tenant by name/slug.
  const { data, error } = await supabase
    .from('tenant')
    .select('id, name, slug')
    .or('name.ilike.%Graduate Futures%,name.ilike.%GFI%,slug.ilike.%gfi%');

  if (error) {
    console.error('ERROR: Failed to look up GFI tenant:', error.message);
    process.exit(1);
  }

  // Filter to only those that pass the GFI check.
  const gfiMatches = (data || []).filter(isGfiTenant);

  if (gfiMatches.length === 0) {
    console.error('ERROR: No tenant matching "Graduate Futures" / "GFI" found.');
    console.error('Use --tenant=<uuid> to specify the tenant ID explicitly.');
    console.error('Raw query returned:', (data || []).map(t => `"${t.name}" (${t.id})`).join(', ') || '(none)');
    process.exit(1);
  }

  if (gfiMatches.length > 1) {
    console.error(`ERROR: Found ${gfiMatches.length} tenants matching "GFI" — cannot auto-select:`);
    gfiMatches.forEach(t => console.error(`  - ${t.id}  name: "${t.name}"  slug: "${t.slug}"`));
    console.error('Use --tenant=<uuid> to pin one of the above.');
    process.exit(1);
  }

  const tenant = gfiMatches[0];
  console.log(`Tenant: "${tenant.name}" (slug: ${tenant.slug}, id: ${tenant.id})`);
  return tenant;
}

// ─── Step 2: Resolve "Alumni Community" role ─────────────────────────────────

async function resolveAlumniRole(tenantId) {
  const { data, error } = await supabase
    .from('role')
    .select('id, name')
    .eq('tenant_id', tenantId)
    .ilike('name', ROLE_NAME);

  if (error) {
    console.error('ERROR: Failed to look up Alumni Community role:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.error(`ERROR: No role named "${ROLE_NAME}" found in tenant ${tenantId}.`);
    console.error('Available roles for this tenant:');
    const { data: allRoles } = await supabase
      .from('role')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .order('name');
    (allRoles || []).forEach(r => console.error(`  - "${r.name}" (${r.id})`));
    process.exit(1);
  }

  if (data.length > 1) {
    console.error(`ERROR: Found ${data.length} roles matching "${ROLE_NAME}":`);
    data.forEach(r => console.error(`  - "${r.name}" (${r.id})`));
    process.exit(1);
  }

  const role = data[0];
  console.log(`Role: "${role.name}" (id: ${role.id})`);
  return role;
}

// ─── Step 3: Resolve member_class preference field ───────────────────────────

async function resolveMemberClassField(tenantId) {
  const { data, error } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, entity_scope')
    .eq('tenant_id', tenantId)
    .eq('name', FIELD_NAME)
    .eq('entity_scope', 'member');

  if (error) {
    console.error('ERROR: Failed to look up member_class preference field:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.error(
      `ERROR: No preference_field named "${FIELD_NAME}" with entity_scope="member" ` +
      `found for tenant ${tenantId}.`
    );
    console.error('This script will NOT create the field. Please create it first.');
    console.error('\nExisting member-scoped preference fields for this tenant:');
    const { data: allFields } = await supabase
      .from('preference_field')
      .select('id, name, label, field_type')
      .eq('tenant_id', tenantId)
      .eq('entity_scope', 'member')
      .order('name');
    (allFields || []).forEach(f =>
      console.error(`  - name: "${f.name}"  label: "${f.label}"  type: ${f.field_type}  id: ${f.id}`)
    );
    process.exit(1);
  }

  if (data.length > 1) {
    console.error(`ERROR: Found ${data.length} member_class fields — ambiguous:`);
    data.forEach(f => console.error(`  - "${f.name}" (${f.id}) scope: ${f.entity_scope}`));
    process.exit(1);
  }

  const field = data[0];
  console.log(
    `Preference field: "${field.label || field.name}" (name: ${field.name}, ` +
    `type: ${field.field_type}, id: ${field.id})`
  );
  return field;
}

// ─── Step 4: Collect all members with the Alumni Community role ───────────────
// Covers both single-role (member.role_id) and multi-role (member_role table).
// All queries are scoped to the GFI tenant to guarantee no cross-tenant reads.

async function collectAlumniMembers(tenantId, roleId) {
  const memberMap = new Map(); // id → { id, email, first_name, last_name, source }

  // 4a. Primary role: member.role_id
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('member')
      .select('id, email, first_name, last_name')
      .eq('tenant_id', tenantId)
      .eq('role_id', roleId)
      .range(offset, offset + BATCH_SIZE - 1)
      .order('id');

    if (error) {
      console.error(`ERROR: Failed to fetch members (primary role) at offset ${offset}:`, error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) break;
    for (const m of data) {
      if (!memberMap.has(m.id)) memberMap.set(m.id, { ...m, source: 'primary' });
    }
    if (data.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  const primaryCount = memberMap.size;

  // 4b. Multi-role association table: member_role
  // Fetch member_role rows where role_id matches, then verify tenant scope by
  // re-fetching the member row (or checking against the full GFI member set).
  // To avoid pulling all GFI member IDs into memory, we paginate member_role
  // by role_id and do a batch membership check per page.

  offset = 0;
  while (true) {
    const { data: mrRows, error: mrErr } = await supabase
      .from('member_role')
      .select('member_id')
      .eq('role_id', roleId)
      .range(offset, offset + BATCH_SIZE - 1)
      .order('member_id');

    if (mrErr) {
      // If the table doesn't exist or is inaccessible, warn and continue with primary results.
      if (mrErr.code === '42P01' || mrErr.message?.includes('does not exist')) {
        console.log('  NOTE: member_role table not found — skipping multi-role association check.');
        break;
      }
      console.error(`ERROR: Failed to fetch member_role at offset ${offset}:`, mrErr.message);
      process.exit(1);
    }

    if (!mrRows || mrRows.length === 0) break;

    // Filter to IDs not already mapped, then tenant-scope verify in batch.
    const newIds = mrRows.map(r => r.member_id).filter(id => !memberMap.has(id));

    if (newIds.length > 0) {
      // Verify these members belong to the GFI tenant (tenant scoping for member_role).
      for (let i = 0; i < newIds.length; i += BATCH_SIZE) {
        const batch = newIds.slice(i, i + BATCH_SIZE);
        const { data: members, error: mErr } = await supabase
          .from('member')
          .select('id, email, first_name, last_name, tenant_id')
          .in('id', batch)
          .eq('tenant_id', tenantId);

        if (mErr) {
          console.error(`ERROR: Failed to verify multi-role members at batch ${i}:`, mErr.message);
          process.exit(1);
        }

        for (const m of members || []) {
          if (!memberMap.has(m.id)) {
            memberMap.set(m.id, { id: m.id, email: m.email, first_name: m.first_name, last_name: m.last_name, source: 'multi-role' });
          }
        }
      }
    }

    if (mrRows.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  const multiRoleCount = memberMap.size - primaryCount;

  console.log(`Members via primary role_id:    ${primaryCount}`);
  console.log(`Members via multi-role table:   ${multiRoleCount}`);
  console.log(`Total unique members:           ${memberMap.size}`);

  return Array.from(memberMap.values());
}

// ─── Step 5: Fetch existing member_class preference values ───────────────────

async function fetchExistingValues(memberIds, fieldId) {
  const valueMap = new Map(); // member_id → current value string

  for (let i = 0; i < memberIds.length; i += BATCH_SIZE) {
    const batch = memberIds.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from('member_preference_value')
      .select('member_id, value')
      .eq('field_id', fieldId)
      .in('member_id', batch);

    if (error) {
      console.error('ERROR: Failed to fetch existing preference values:', error.message);
      process.exit(1);
    }

    for (const row of data || []) {
      valueMap.set(row.member_id, row.value);
    }
  }

  return valueMap;
}

// ─── Step 6: Upsert in batches ────────────────────────────────────────────────

async function upsertInBatches(records, fieldId) {
  let created = 0;
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const rows = batch.map(r => ({
      member_id: r.member_id,
      field_id: fieldId,
      value: TARGET_VALUE,
    }));

    const { error } = await supabase
      .from('member_preference_value')
      .upsert(rows, { onConflict: 'member_id,field_id', ignoreDuplicates: false });

    if (error) {
      console.error(`  ERROR upserting batch at index ${i}:`, error.message);
      failed += batch.length;
    } else {
      for (const r of batch) {
        if (r.action === 'create') created++;
        else updated++;
      }
    }
  }

  return { created, updated, failed };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const tenant = await resolveGfiTenant();
  const role = await resolveAlumniRole(tenant.id);
  const field = await resolveMemberClassField(tenant.id);
  console.log('');

  // Collect members (both primary and multi-role association)
  const members = await collectAlumniMembers(tenant.id, role.id);
  console.log('');

  if (members.length === 0) {
    console.log('Nothing to do — no members found with this role.');
    return;
  }

  // Compare existing values
  const memberIds = members.map(m => m.id);
  const existingValues = await fetchExistingValues(memberIds, field.id);

  const toCreate = [];
  const toUpdate = [];
  const alreadyCorrect = [];

  for (const m of members) {
    const existing = existingValues.get(m.id);
    if (existing === undefined || existing === null) {
      toCreate.push({ member_id: m.id, action: 'create', member: m });
    } else if (existing !== TARGET_VALUE) {
      toUpdate.push({ member_id: m.id, action: 'update', prev: existing, member: m });
    } else {
      alreadyCorrect.push(m);
    }
  }

  console.log('─── Plan ───────────────────────────────────────────────────');
  console.log(`  Would create (no existing value):    ${toCreate.length}`);
  console.log(`  Would update (wrong existing value): ${toUpdate.length}`);
  console.log(`  Already correct (value = Alumni):    ${alreadyCorrect.length}`);
  console.log('');

  if (toUpdate.length > 0) {
    const SAMPLE = 5;
    console.log(`  Sample of rows to update (first ${Math.min(SAMPLE, toUpdate.length)}):`);
    toUpdate.slice(0, SAMPLE).forEach(r =>
      console.log(
        `    - ${r.member.first_name || ''} ${r.member.last_name || ''} ` +
        `<${r.member.email || r.member_id}> | current: "${r.prev}" → "Alumni"`
      )
    );
    if (toUpdate.length > SAMPLE) console.log(`    ... and ${toUpdate.length - SAMPLE} more`);
    console.log('');
  }

  const needsWrite = [...toCreate, ...toUpdate];

  if (!APPLY) {
    console.log('DRY RUN complete — no changes made.');
    console.log('Run with --apply to write these changes.');
    return;
  }

  if (needsWrite.length === 0) {
    console.log('Nothing to write — all members already have member_class=Alumni.');
    return;
  }

  console.log(`Upserting ${needsWrite.length} record(s)...`);
  const { created, updated, failed } = await upsertInBatches(needsWrite, field.id);

  console.log('');
  console.log('─── Summary ────────────────────────────────────────────────');
  console.log(`  Created:         ${created}`);
  console.log(`  Updated:         ${updated}`);
  console.log(`  Already correct: ${alreadyCorrect.length}`);
  console.log(`  Failed:          ${failed}`);
  console.log('');

  if (failed > 0) {
    console.error(`WARN: ${failed} record(s) failed to upsert — check errors above.`);
    process.exit(1);
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
