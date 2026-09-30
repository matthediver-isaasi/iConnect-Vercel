#!/usr/bin/env node
/**
 * One-off (task #1121): For the GSF tenant, force guest access ON for
 * every organisation whose `org_status` custom field equals "Active".
 *
 * Behaviour:
 *   - Sets guest_access_enabled = true
 *   - Sets guest_access_period_days = NULL  (inherit tenant default = 7d)
 *   - Sets guest_access_unlimited = false
 *
 * Tenant-pinned by design: refuses to run for any other TENANT_ID.
 * Idempotent: orgs already in the desired state are skipped.
 * Dry-run by default; require --apply to write.
 *
 * Usage:
 *   DEST_SUPABASE_URL=... DEST_SUPABASE_KEY=... \
 *   node scripts/enable-guest-access-active-gsf-orgs.mjs [--apply] [--verbose]
 */

import { createClient } from '@supabase/supabase-js';

const ALLOWED_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const TENANT_ID = process.env.TENANT_ID || ALLOWED_TENANT_ID;

if (TENANT_ID !== ALLOWED_TENANT_ID) {
  console.error(
    `[enable-guest-access-active-gsf-orgs] Refusing to run for tenant ${TENANT_ID}. ` +
    `This script is hard-pinned to ${ALLOWED_TENANT_ID}.`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');

const SUPABASE_URL =
  process.env.DEST_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  process.env.DEV_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.DEST_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[enable-guest-access-active-gsf-orgs] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log(APPLY ? '=== LIVE RUN ===' : '=== DRY RUN ===');
  console.log('Tenant:', TENANT_ID);
  console.log('');

  // 1. Resolve org_status preference_field id.
  const { data: fields, error: fErr } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type')
    .eq('tenant_id', TENANT_ID)
    .eq('entity_scope', 'organization')
    .eq('name', 'org_status');
  if (fErr) throw new Error(`preference_field lookup failed: ${fErr.message}`);
  if (!fields || fields.length === 0) {
    throw new Error(`No organization-scoped preference_field with name='org_status' found for tenant ${TENANT_ID}`);
  }
  const field = fields[0];
  console.log(`Resolved org_status field: ${field.id} (label: ${field.label}, type: ${field.field_type})`);

  // 2. Collect all preference values for that field where value = 'Active'.
  const { data: prefRows, error: pErr } = await supabase
    .from('organization_preference_value')
    .select('organization_id, value')
    .eq('field_id', field.id);
  if (pErr) throw new Error(`organization_preference_value fetch failed: ${pErr.message}`);

  const activeOrgIds = [];
  for (const row of prefRows || []) {
    const v = row.value;
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') {
      throw new Error(
        `Non-scalar value seen in organization_preference_value for org ${row.organization_id}: ${JSON.stringify(v)}. ` +
        `Aborting — script assumes single-string dropdown values.`,
      );
    }
    if (v === 'Active') activeOrgIds.push(row.organization_id);
  }

  console.log(`Active orgs (by org_status pref): ${activeOrgIds.length}`);

  if (activeOrgIds.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // 3. Fetch those orgs (verify tenant + read current guest access state).
  const orgs = [];
  for (let i = 0; i < activeOrgIds.length; i += 200) {
    const batch = activeOrgIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('organization')
      .select('id, tenant_id, name, guest_access_enabled, guest_access_period_days, guest_access_unlimited')
      .in('id', batch);
    if (error) throw new Error(`organization fetch failed: ${error.message}`);
    orgs.push(...(data || []));
  }

  const foreign = orgs.filter(o => o.tenant_id !== TENANT_ID);
  if (foreign.length > 0) {
    throw new Error(
      `Found ${foreign.length} organization(s) whose tenant_id != GSF tenant. ` +
      `Refusing to proceed. First offender: ${foreign[0].id} (tenant ${foreign[0].tenant_id}).`,
    );
  }

  const missing = activeOrgIds.filter(id => !orgs.find(o => o.id === id));
  if (missing.length > 0) {
    console.log(`Warning: ${missing.length} pref-value org_id(s) had no matching organization row (skipped).`);
  }

  const alreadyCorrect = [];
  const toUpdate = [];
  for (const o of orgs) {
    if (
      o.guest_access_enabled === true &&
      o.guest_access_period_days === null &&
      o.guest_access_unlimited === false
    ) {
      alreadyCorrect.push(o.id);
    } else {
      toUpdate.push(o);
    }
  }

  console.log('');
  console.log('=== Plan ===');
  console.log(`Already correct : ${alreadyCorrect.length}`);
  console.log(`Will change     : ${toUpdate.length}`);

  const sample = toUpdate.slice(0, 10);
  if (sample.length > 0) {
    console.log('');
    console.log('Sample changes (first 10):');
    for (const o of sample) {
      console.log(
        `  ${o.id}  ${o.name || ''}  ` +
        `enabled:${o.guest_access_enabled}->true  ` +
        `days:${o.guest_access_period_days}->null  ` +
        `unlimited:${o.guest_access_unlimited}->false`,
      );
    }
  }
  if (VERBOSE) {
    console.log('');
    console.log('All target organization ids:');
    for (const o of toUpdate) console.log('  ', o.id);
  }

  if (!APPLY) {
    console.log('\nDRY RUN complete. Re-run with --apply to write.');
    return;
  }

  if (toUpdate.length === 0) {
    console.log('\nNothing to write.');
    return;
  }

  let updated = 0, errors = 0;
  for (let i = 0; i < toUpdate.length; i += 100) {
    const batch = toUpdate.slice(i, i + 100);
    const ids = batch.map(o => o.id);
    const { error } = await supabase
      .from('organization')
      .update({
        guest_access_enabled: true,
        guest_access_period_days: null,
        guest_access_unlimited: false,
      })
      .in('id', ids)
      .eq('tenant_id', TENANT_ID);
    if (error) {
      console.error(`Update batch failed (${ids.length} ids):`, error.message);
      errors += ids.length;
    } else {
      updated += ids.length;
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Already correct : ${alreadyCorrect.length}`);
  console.log(`Updated         : ${updated}`);
  console.log(`Errors          : ${errors}`);
  if (errors > 0) process.exit(1);
}

main().catch(err => {
  console.error('[enable-guest-access-active-gsf-orgs] Failed:', err.message || err);
  process.exit(1);
});
