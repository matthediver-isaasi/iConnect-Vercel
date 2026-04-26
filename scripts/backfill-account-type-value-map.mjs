#!/usr/bin/env node

/**
 * #463 follow-up: backfill the `value_map` on a field-mapping row so that
 * the iConnect hyphen form of every dash-variant picklist option translates
 * to the canonical en-dash form on outbound push.
 *
 * The runtime fix (`canonicalizePicklistOptionForOutbound` in
 * api/_lib/zohoCrmSync.js) already handles dash-style drift via Zoho
 * picklist metadata. This script writes the same mapping into the
 * persisted value_map as a defence-in-depth: if for any reason the
 * metadata fetch is unavailable at sync time (Zoho rate-limit, transient
 * 5xx, etc.), the value_map keeps the canonicalisation working.
 *
 * #465: generalised so the same backfill works for any picklist field on
 * either side. Defaults preserve the original behaviour
 * (organization/Accounts/Account_Type) so existing run-books are
 * unaffected.
 *
 * Idempotent — reruns merge into the existing value_map without dropping
 * unrelated entries.
 *
 * Usage:
 *   node scripts/backfill-account-type-value-map.mjs                 (DRY RUN — default, organization/Accounts/Account_Type)
 *   node scripts/backfill-account-type-value-map.mjs --dry-run       (DRY RUN — explicit)
 *     Print the value_map entries that WOULD be added/changed for the
 *     selected field. No DB writes.
 *
 *   node scripts/backfill-account-type-value-map.mjs --apply
 *     Persist the additions into zoho_crm_sync_mapping.field_mappings.
 *
 *   node scripts/backfill-account-type-value-map.mjs --tenant <uuid>
 *     Override default tenant (gsf).
 *
 *   node scripts/backfill-account-type-value-map.mjs \
 *     --entity-type member --module Contacts --field Member_Status
 *     Generalised use: backfill a Contact picklist on the member mapping.
 */

import { createClient } from '@supabase/supabase-js';

if (process.env.DEST_SUPABASE_URL && process.env.DEST_SUPABASE_KEY) {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
} else {
  console.error('Need DEST_SUPABASE_URL and DEST_SUPABASE_KEY to talk to the production DB.');
  process.exit(1);
}

const { getZohoCrmModuleFields } = await import('../api/_lib/zohoCrmClient.js');

const GSF_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const DEFAULT_ENTITY_TYPE = 'organization';
const DEFAULT_MODULE = 'Accounts';
const DEFAULT_FIELD = 'Account_Type';
const VALID_ENTITY_TYPES = new Set(['organization', 'member']);

const DASH_VARIANTS_RE = /[\u002D\u2013\u2014]/g;
function normalizeDashesForCompare(s) {
  return typeof s === 'string' ? s.replace(DASH_VARIANTS_RE, '-') : s;
}
function toHyphenForm(s) {
  return typeof s === 'string' ? s.replace(/\u2013|\u2014/g, '-') : s;
}

function parseArgs(argv) {
  const args = {
    apply: false,
    tenant: GSF_TENANT_ID,
    entityType: DEFAULT_ENTITY_TYPE,
    module: DEFAULT_MODULE,
    field: DEFAULT_FIELD
  };
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a.startsWith('--tenant=')) args.tenant = a.split('=')[1];
    else if (a === '--entity-type') args.entityType = argv[++i];
    else if (a.startsWith('--entity-type=')) args.entityType = a.split('=')[1];
    else if (a === '--module') args.module = argv[++i];
    else if (a.startsWith('--module=')) args.module = a.split('=')[1];
    else if (a === '--field') args.field = argv[++i];
    else if (a.startsWith('--field=')) args.field = a.split('=')[1];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/backfill-account-type-value-map.mjs [--dry-run | --apply] [--tenant <uuid>] [--entity-type organization|member] [--module <ZohoModule>] [--field <Zoho_Field>]');
      process.exit(0);
    } else {
      console.error(`Error: unknown flag "${a}". Use --help to see supported flags.`);
      process.exit(2);
    }
  }
  if (explicitDryRun && args.apply) {
    console.error('Error: --dry-run and --apply are mutually exclusive.');
    process.exit(2);
  }
  if (!VALID_ENTITY_TYPES.has(args.entityType)) {
    console.error(`Error: --entity-type must be one of: ${[...VALID_ENTITY_TYPES].join(', ')} (got "${args.entityType}").`);
    process.exit(2);
  }
  if (!args.module || typeof args.module !== 'string') {
    console.error('Error: --module is required and must be a non-empty string.');
    process.exit(2);
  }
  if (!args.field || typeof args.field !== 'string') {
    console.error('Error: --field is required and must be a non-empty string.');
    process.exit(2);
  }
  return args;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.DEST_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.DEST_SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_KEY must be set');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = args.tenant;
  const entityType = args.entityType;
  const moduleName = args.module;
  const zohoField = args.field;

  console.log(`\n=== Backfill value_map for ${entityType}/${moduleName}.${zohoField} ===`);
  console.log(`tenant=${tenantId} apply=${args.apply}\n`);

  // 1. Fetch picklist options from Zoho metadata (canonical en-dash form).
  const fields = await getZohoCrmModuleFields(tenantId, moduleName);
  const fieldMeta = (fields || []).find(f => f?.api_name === zohoField);
  if (!fieldMeta) {
    console.error(`ABORT: ${zohoField} not found in ${moduleName} metadata for tenant ${tenantId}`);
    process.exit(2);
  }
  const options = (fieldMeta.pick_list_values || [])
    .map(p => p?.actual_value)
    .filter(v => typeof v === 'string' && v !== '');
  if (options.length === 0) {
    console.error(`ABORT: ${zohoField} has no picklist options in metadata`);
    process.exit(2);
  }
  console.log(`  ${zohoField} options from Zoho metadata (${options.length}):`);
  for (const o of options) console.log(`    "${o}"`);

  // 2. Compute desired iConnect→Zoho entries: for every option that
  //    contains a dash variant, also map the plain-hyphen form to the
  //    canonical option string. Skip options that are already pure
  //    hyphens (no rewrite needed).
  const desiredAdditions = {};
  for (const opt of options) {
    if (!DASH_VARIANTS_RE.test(opt)) continue;
    const hyphenated = toHyphenForm(opt);
    if (hyphenated !== opt) desiredAdditions[hyphenated] = opt;
  }
  if (Object.keys(desiredAdditions).length === 0) {
    console.log(`\n  No dash-variant options on ${zohoField} — nothing to backfill.`);
    return;
  }
  console.log(`\n  Computed iconnect_to_zoho entries to add/ensure (${Object.keys(desiredAdditions).length}):`);
  for (const [k, v] of Object.entries(desiredAdditions)) console.log(`    "${k}"  →  "${v}"`);

  // 3. Load mapping row.
  const supabase = getSupabase();
  const { data: rows, error } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('id, entity_type, zoho_module, field_mappings')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .eq('zoho_module', moduleName);
  if (error) throw error;
  if (!rows || rows.length !== 1) {
    console.error(`Expected exactly 1 ${entityType}/${moduleName} mapping row for tenant ${tenantId}, found ${rows?.length || 0}.`);
    process.exit(2);
  }
  const row = rows[0];
  const fms = Array.isArray(row.field_mappings) ? row.field_mappings : [];
  const targetIdx = fms.findIndex(m => m && m.zoho_field === zohoField);
  if (targetIdx === -1) {
    console.error(`ABORT: no field_mappings row maps ${zohoField} for tenant ${tenantId}.`);
    process.exit(2);
  }

  const target = fms[targetIdx];
  const existingVm = (target.value_map && typeof target.value_map === 'object') ? target.value_map : {};
  const existingI2Z = (existingVm.iconnect_to_zoho && typeof existingVm.iconnect_to_zoho === 'object') ? existingVm.iconnect_to_zoho : {};

  // Merge: don't clobber any existing entry — operator-set overrides win.
  // Also skip an entry if a dash-equivalent key already exists (e.g.
  // operator already wrote the en-dash form themselves).
  const additions = {};
  const skipped = {};
  const existingKeysNormalized = new Set(Object.keys(existingI2Z).map(normalizeDashesForCompare));
  for (const [k, v] of Object.entries(desiredAdditions)) {
    if (Object.prototype.hasOwnProperty.call(existingI2Z, k)) {
      skipped[k] = `already mapped to "${existingI2Z[k]}"`;
      continue;
    }
    if (existingKeysNormalized.has(normalizeDashesForCompare(k))) {
      skipped[k] = 'dash-equivalent key already present';
      continue;
    }
    additions[k] = v;
  }

  console.log(`\n  Existing iconnect_to_zoho entries on ${zohoField}: ${Object.keys(existingI2Z).length}`);
  console.log(`  New entries to add:                                  ${Object.keys(additions).length}`);
  console.log(`  Entries skipped (already present or equivalent):     ${Object.keys(skipped).length}`);
  for (const [k, reason] of Object.entries(skipped)) console.log(`    skip "${k}" — ${reason}`);

  if (Object.keys(additions).length === 0) {
    console.log(`\n  Nothing to write — ${zohoField} value_map already covers every dash variant.`);
    return;
  }

  if (!args.apply) {
    console.log(`\n  DRY RUN — re-run with --apply to persist the additions.`);
    return;
  }

  // 4. Persist.
  const nextI2Z = { ...existingI2Z, ...additions };
  const nextVm = { ...existingVm, iconnect_to_zoho: nextI2Z };
  const nextFms = fms.map((m, i) => i === targetIdx ? { ...m, value_map: nextVm } : m);

  const { error: updateErr } = await supabase
    .from('zoho_crm_sync_mapping')
    .update({ field_mappings: nextFms, updated_at: new Date().toISOString() })
    .eq('id', row.id);
  if (updateErr) {
    console.error(`FAIL: ${updateErr.message}`);
    process.exit(2);
  }
  console.log(`\n  [ok] mapping ${row.id} updated — ${Object.keys(additions).length} new value_map entries on ${zohoField}.`);

  // 5. Best-effort cache invalidation on the running app.
  await invalidateMappingCacheOnRunningApp(tenantId, moduleName);
}

async function invalidateMappingCacheOnRunningApp(tenantId, moduleName) {
  const baseUrl = (process.env.APP_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
  const url = `${baseUrl}/api/admin/zoho-crm-sync/invalidate-mapping-cache`;
  const cronSecret = process.env.CRON_SECRET;
  console.log(`\n  Invalidating mapping caches on running app at ${baseUrl} ...`);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cronSecret ? { authorization: `Bearer ${cronSecret}` } : {})
      },
      body: JSON.stringify({ tenantId, zohoModule: moduleName })
    });
    const text = await resp.text();
    if (resp.ok) {
      console.log(`  [ok] cache invalidated — ${text}`);
    } else {
      console.warn(`  [WARN] cache invalidation returned HTTP ${resp.status}: ${text}`);
      console.warn('         Restart the app workflow manually to drop the caches.');
    }
  } catch (err) {
    console.warn(`  [WARN] could not reach ${url}: ${err?.message || err}`);
    console.warn('         Restart the app workflow manually to drop the caches.');
  }
}

main().catch(err => {
  console.error('FATAL:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
