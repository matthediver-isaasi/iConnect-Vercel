#!/usr/bin/env node

/**
 * #476: re-push every Zoho Account whose `Account_Type` is the bare value
 * "Vendor" through the existing iConnect → Zoho outbound sync pipeline so
 * the configured `value_map` translates the iConnect value into the
 * correct canonical Zoho option (e.g. "Vendor – Primary").
 *
 * No iConnect data is modified — this is a push-only correction. The
 * runtime sync (`syncEntityToZohoCrm` in api/_lib/zohoCrmSync.js) is the
 * one and only writer.
 *
 * Steps:
 *   1. Page Zoho `(Account_Type:equals:Vendor)` for the GSF tenant and
 *      collect every affected Zoho Account id (+ Name + current
 *      Account_Type for the report).
 *   2. For each Zoho id, look up the iConnect organisation by
 *      `organization.zoho_crm_id`. Anything that does not match is
 *      collected separately and surfaced in the summary so it can be
 *      relinked (via the existing relink-organisations admin endpoint)
 *      or flagged manually.
 *   3. In dry-run (default), print a per-record table with the iConnect
 *      Organisation Type and the value the outbound sync would produce
 *      after `value_map` translation — without calling the sync.
 *   4. In `--apply`, call `syncEntityToZohoCrm(tenantId, 'organization',
 *      orgId, { source: 'manual-vendor-correction' })` for each matched
 *      record, awaiting each call so failures are captured per-record.
 *   5. Print a final summary: total found, matched, pushed OK, failed
 *      (with error), unmatched (no iConnect link).
 *
 * Usage:
 *   node scripts/repush-vendor-account-type.mjs                          (DRY RUN — default, current-value=Vendor)
 *   node scripts/repush-vendor-account-type.mjs --dry-run                (DRY RUN — explicit)
 *   node scripts/repush-vendor-account-type.mjs --apply                  (perform the push)
 *   node scripts/repush-vendor-account-type.mjs --tenant <uuid>          (override default GSF tenant)
 *   node scripts/repush-vendor-account-type.mjs --current-value "Member – SO"
 *     Operate on a different bare/non-canonical Zoho Account_Type value
 *     (the same flow applies to any picklist drift caught by the value_map).
 */

import { createClient } from '@supabase/supabase-js';

if (process.env.DEST_SUPABASE_URL && process.env.DEST_SUPABASE_KEY) {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
} else {
  console.error('Need DEST_SUPABASE_URL and DEST_SUPABASE_KEY to talk to the production DB.');
  process.exit(1);
}

const { zohoCrmApiCall } = await import('../api/_lib/zohoCrmClient.js');
const { syncEntityToZohoCrm } = await import('../api/_lib/zohoCrmSync.js');

const GSF_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const ZOHO_MODULE = 'Accounts';
const ZOHO_FIELD = 'Account_Type';
const DEFAULT_CURRENT_VALUE = 'Vendor';
const ENTITY_TYPE = 'organization';
const ORG_TABLE = 'organization';
const PREF_VALUE_TABLE = 'organization_preference_value';
const PREF_VALUE_FK = 'organization_id';

const DASH_VARIANTS_RE = /[\u002D\u2013\u2014]/g;
function normalizeDashesForCompare(s) {
  return typeof s === 'string' ? s.replace(DASH_VARIANTS_RE, '-') : s;
}

function parseArgs(argv) {
  const args = { apply: false, tenant: GSF_TENANT_ID, currentValue: DEFAULT_CURRENT_VALUE };
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a.startsWith('--tenant=')) args.tenant = a.split('=')[1];
    else if (a === '--current-value') args.currentValue = argv[++i];
    else if (a.startsWith('--current-value=')) args.currentValue = a.split('=').slice(1).join('=');
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/repush-vendor-account-type.mjs [--dry-run | --apply] [--tenant <uuid>] [--current-value <string>]');
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
  if (typeof args.currentValue !== 'string' || args.currentValue === '') {
    console.error('Error: --current-value must be a non-empty string.');
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

async function fetchAffectedZohoAccounts(tenantId, currentValue) {
  const criteria = `(${ZOHO_FIELD}:equals:${currentValue})`;
  const fields = ['id', 'Account_Name', ZOHO_FIELD].join(',');
  const perPage = 200;
  const out = [];
  let page = 1;
  while (true) {
    const endpoint = `/${ZOHO_MODULE}/search?criteria=${encodeURIComponent(criteria)}&fields=${fields}&per_page=${perPage}&page=${page}`;
    let resp;
    try {
      resp = await zohoCrmApiCall(tenantId, endpoint);
    } catch (err) {
      // Zoho returns 204 No Content when there are zero matches on the first
      // page; the helper turns that into an Error string we can recognise.
      if (typeof err?.message === 'string' && err.message.includes('204')) break;
      throw err;
    }
    const records = resp?.data || [];
    for (const r of records) {
      out.push({
        zohoId: r.id,
        zohoName: r.Account_Name || '',
        zohoCurrentValue: r[ZOHO_FIELD] ?? null
      });
    }
    if (!resp?.info?.more_records) break;
    page += 1;
    if (page > 50) {
      console.warn(`  [WARN] stopped paging at page ${page} as a safety guard (${out.length} records collected)`);
      break;
    }
  }
  return out;
}

async function loadAccountTypeMappingRow(supabase, tenantId) {
  const { data: rows, error } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('id, entity_type, zoho_module, field_mappings')
    .eq('tenant_id', tenantId)
    .eq('entity_type', ENTITY_TYPE)
    .eq('zoho_module', ZOHO_MODULE);
  if (error) throw error;
  if (!rows || rows.length !== 1) {
    throw new Error(`Expected exactly 1 ${ENTITY_TYPE}/${ZOHO_MODULE} mapping row for tenant ${tenantId}, found ${rows?.length || 0}.`);
  }
  const mapping = rows[0];
  const fms = Array.isArray(mapping.field_mappings) ? mapping.field_mappings : [];
  const fm = fms.find(m => m && m.zoho_field === ZOHO_FIELD);
  if (!fm) {
    throw new Error(`No field_mappings row maps ${ZOHO_FIELD} for tenant ${tenantId}.`);
  }
  return { mapping, fieldMapping: fm };
}

function applyIconnectToZohoValueMap(fieldMapping, value) {
  // Mirrors the relevant subset of `applyValueMap` from zohoCrmSync.js for
  // dry-run preview: direct hit, then dash-equivalent fallback. The
  // case-insensitive and alias paths are deliberately omitted — they are
  // not required for the Account_Type / Vendor case and adding them here
  // would silently diverge from the live runtime if either side changes.
  if (value === undefined || value === null || value === '') return { translated: value, hit: null };
  const vm = fieldMapping?.value_map;
  if (!vm || typeof vm !== 'object') return { translated: value, hit: null };
  const dir = vm.iconnect_to_zoho;
  if (!dir || typeof dir !== 'object' || Object.keys(dir).length === 0) {
    return { translated: value, hit: null };
  }
  const key = String(value);
  if (Object.prototype.hasOwnProperty.call(dir, key)) {
    return { translated: dir[key], hit: 'direct' };
  }
  const compareKey = normalizeDashesForCompare(key);
  if (compareKey !== key) {
    for (const k of Object.keys(dir)) {
      if (normalizeDashesForCompare(k) === compareKey) {
        return { translated: dir[k], hit: 'dash' };
      }
    }
  }
  return { translated: value, hit: 'unmapped' };
}

async function readIconnectAccountTypeValue(supabase, fieldMapping, org) {
  const src = fieldMapping.iconnect_field;
  if (!src) return null;
  if (src.startsWith('custom:')) {
    const fieldId = src.slice('custom:'.length);
    const { data, error } = await supabase
      .from(PREF_VALUE_TABLE)
      .select('value')
      .eq(PREF_VALUE_FK, org.id)
      .eq('field_id', fieldId)
      .maybeSingle();
    if (error) throw error;
    return data?.value ?? null;
  }
  return org?.[src] ?? null;
}

function pad(s, n) {
  const str = s == null ? '' : String(s);
  if (str.length >= n) return str;
  return str + ' '.repeat(n - str.length);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = args.tenant;
  const currentValue = args.currentValue;

  console.log(`\n=== Re-push Zoho Accounts where ${ZOHO_FIELD}="${currentValue}" ===`);
  console.log(`tenant=${tenantId}  apply=${args.apply}\n`);

  // 1. Pull every affected Zoho Account id.
  console.log(`Searching Zoho for (${ZOHO_FIELD}:equals:${currentValue}) ...`);
  const affected = await fetchAffectedZohoAccounts(tenantId, currentValue);
  console.log(`  Found ${affected.length} Zoho Account(s) with ${ZOHO_FIELD}="${currentValue}".`);
  if (affected.length === 0) {
    console.log('\n  Nothing to do.\n');
    return;
  }

  // 2. Resolve each to an iConnect org by zoho_crm_id.
  const supabase = getSupabase();
  const zohoIds = affected.map(a => a.zohoId);
  const { data: orgs, error: orgsErr } = await supabase
    .from(ORG_TABLE)
    .select('id, name, zoho_crm_id, zoho_crm_module')
    .eq('tenant_id', tenantId)
    .in('zoho_crm_id', zohoIds);
  if (orgsErr) throw orgsErr;
  const orgByZohoId = new Map();
  for (const o of orgs || []) {
    if (o?.zoho_crm_id) orgByZohoId.set(o.zoho_crm_id, o);
  }

  const matched = [];
  const unmatched = [];
  for (const a of affected) {
    const org = orgByZohoId.get(a.zohoId);
    if (org) matched.push({ ...a, org });
    else unmatched.push(a);
  }
  console.log(`  Matched to local organisation: ${matched.length}`);
  console.log(`  Unmatched (no iConnect link):  ${unmatched.length}`);

  // 3. Load the field_mapping row so dry-run can preview the translated value.
  const { fieldMapping } = await loadAccountTypeMappingRow(supabase, tenantId);
  console.log(`\n  Mapping field_mappings row: iconnect_field="${fieldMapping.iconnect_field}", zoho_field="${fieldMapping.zoho_field}"`);
  const vmEntries = (fieldMapping.value_map?.iconnect_to_zoho && typeof fieldMapping.value_map.iconnect_to_zoho === 'object')
    ? Object.keys(fieldMapping.value_map.iconnect_to_zoho).length : 0;
  console.log(`  iconnect_to_zoho value_map entries: ${vmEntries}`);

  // 4. Compute the dry-run preview (also used as the per-record context in --apply).
  console.log(`\n  ${pad('Zoho ID', 20)} ${pad('iConnect ID', 38)} ${pad('Name', 40)} ${pad('iConnect type → expected outbound', 60)} hit`);
  console.log(`  ${'-'.repeat(20)} ${'-'.repeat(38)} ${'-'.repeat(40)} ${'-'.repeat(60)} ---`);
  const previewByOrgId = new Map();
  for (const m of matched) {
    const iconnectVal = await readIconnectAccountTypeValue(supabase, fieldMapping, m.org);
    const { translated, hit } = applyIconnectToZohoValueMap(fieldMapping, iconnectVal);
    const preview = `${iconnectVal ?? '(empty)'} → ${translated ?? '(empty)'}`;
    previewByOrgId.set(m.org.id, { iconnectVal, translated, hit });
    console.log(`  ${pad(m.zohoId, 20)} ${pad(m.org.id, 38)} ${pad(m.org.name || '', 40)} ${pad(preview, 60)} ${hit ?? '-'}`);
  }
  if (unmatched.length > 0) {
    console.log(`\n  Unmatched Zoho Accounts (no iConnect organisation linked by zoho_crm_id):`);
    for (const u of unmatched) {
      console.log(`    ${pad(u.zohoId, 20)} ${u.zohoName}`);
    }
  }

  if (!args.apply) {
    console.log(`\n  DRY RUN — re-run with --apply to push ${matched.length} record(s) through syncEntityToZohoCrm.`);
    console.log(`            Resolve unmatched records (typically via the relink-organisations admin endpoint) before applying.\n`);
    return;
  }

  // 5. Apply: push each matched record through the standard outbound sync.
  console.log(`\n  Pushing ${matched.length} record(s) via syncEntityToZohoCrm (source=manual-vendor-correction) ...`);
  const pushed = [];
  const failed = [];
  for (const m of matched) {
    const ctx = previewByOrgId.get(m.org.id) || {};
    try {
      const log = await syncEntityToZohoCrm(tenantId, ENTITY_TYPE, m.org.id, {
        source: 'manual-vendor-correction'
      });
      const status = log?.status || 'unknown';
      const note = log?.error_message || '';
      pushed.push({ ...m, status, note, ctx });
      console.log(`    [${status}] ${m.zohoId} (${m.org.id}) — ${m.org.name || ''}  iConnect="${ctx.iconnectVal ?? ''}" → expected="${ctx.translated ?? ''}"  ${note ? `(${note})` : ''}`);
    } catch (err) {
      const msg = err?.message || String(err);
      failed.push({ ...m, error: msg, ctx });
      console.log(`    [error] ${m.zohoId} (${m.org.id}) — ${m.org.name || ''}  ${msg}`);
    }
  }

  // 6. Summary.
  const okCount = pushed.filter(p => p.status === 'success' || p.status === 'ok').length;
  const skippedCount = pushed.filter(p => p.status === 'skipped').length;
  const otherStatuses = pushed.filter(p => p.status !== 'success' && p.status !== 'ok' && p.status !== 'skipped' && p.status !== 'failed').length;
  const failedFromLog = pushed.filter(p => p.status === 'failed').length;
  console.log(`\n=== Summary ===`);
  console.log(`  Total Zoho records found with ${ZOHO_FIELD}="${currentValue}": ${affected.length}`);
  console.log(`  Matched to local organisation:                                ${matched.length}`);
  console.log(`  Unmatched (no iConnect link):                                 ${unmatched.length}`);
  console.log(`  Pushed via syncEntityToZohoCrm:                               ${pushed.length}`);
  console.log(`    success:                                                    ${okCount}`);
  console.log(`    skipped (no-op / debounced / inbound-only / no fields):     ${skippedCount}`);
  console.log(`    failed (from sync log):                                     ${failedFromLog}`);
  console.log(`    other status:                                               ${otherStatuses}`);
  console.log(`  Threw before producing a sync log:                            ${failed.length}`);
  if (failedFromLog > 0) {
    console.log(`\n  Failed (from sync log):`);
    for (const p of pushed.filter(x => x.status === 'failed')) {
      console.log(`    ${p.zohoId} (${p.org.id}) — ${p.org.name || ''}  ${p.note}`);
    }
  }
  if (failed.length > 0) {
    console.log(`\n  Threw:`);
    for (const f of failed) {
      console.log(`    ${f.zohoId} (${f.org.id}) — ${f.org.name || ''}  ${f.error}`);
    }
  }
  if (unmatched.length > 0) {
    console.log(`\n  Unmatched Zoho IDs (left untouched — relink and rerun):`);
    for (const u of unmatched) console.log(`    ${u.zohoId}  ${u.zohoName}`);
  }
  console.log(`\n  After this completes, re-run the Zoho search (${ZOHO_FIELD}:equals:${currentValue}) to confirm the count is zero (or matches the unmatched/skipped set).\n`);
}

main().catch(err => {
  console.error('FATAL:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
