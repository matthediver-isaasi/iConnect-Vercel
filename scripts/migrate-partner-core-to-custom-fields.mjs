#!/usr/bin/env node

/**
 * Task #805 — Migrate Partner orgs' core website_url / phone into the
 * `partner_website` and `partner_phone` custom (preference) fields, then
 * NULL out the original core columns.
 *
 * Tenant: fd82da65-aab7-4a5c-85b8-b2febeb2003d
 *
 * Usage:
 *   node scripts/migrate-partner-core-to-custom-fields.mjs                 (DRY RUN)
 *   node scripts/migrate-partner-core-to-custom-fields.mjs --dry-run       (DRY RUN, explicit)
 *   node scripts/migrate-partner-core-to-custom-fields.mjs --apply         (perform writes)
 *   node scripts/migrate-partner-core-to-custom-fields.mjs --tenant <uuid> (override tenant)
 *
 * Notes / conventions:
 * - Partner orgs are detected by joining `organization_preference_value`
 *   on the "Organisation Type" preference_field for the tenant where the
 *   stored value equals "Partner". Both the JSON-encoded form ('"Partner"')
 *   and the bare form ('Partner') are accepted because earlier imports
 *   wrote text values JSON-encoded (see scripts/import-gsf-organisations.mjs)
 *   while other paths write plain text (see backfill-task653-...).
 * - The destination value is written using aggregateForFieldType-style
 *   serialisation: plain string for text/single fields, JSON-encoded array
 *   for multi-select / list field types.
 * - The script is idempotent: a partial run can be replayed with --apply.
 */

import { createClient } from '@supabase/supabase-js';

if (process.env.DEST_SUPABASE_URL && process.env.DEST_SUPABASE_KEY) {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
}

const DEFAULT_TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const PARTNER_VALUE = 'Partner';

const ORG_TYPE_NAME_CANDIDATES = new Set([
  'organisation_type',
  'organization_type',
  'org_type',
  'organisation type',
  'organization type',
]);
const ORG_TYPE_LABEL_CANDIDATES = new Set([
  'organisation type',
  'organization type',
]);

const PARTNER_WEBSITE_NAME_CANDIDATES = new Set([
  'partner_website',
  'partner_webite', // typo fallback per task spec
  'partner website',
]);
const PARTNER_WEBSITE_LABEL_CANDIDATES = new Set([
  'partner website',
]);

const PARTNER_PHONE_NAME_CANDIDATES = new Set([
  'partner_phone',
  'partner phone',
]);
const PARTNER_PHONE_LABEL_CANDIDATES = new Set([
  'partner phone',
]);

const MULTI_FIELD_TYPES = new Set([
  'picklist', 'checkbox', 'multi_select', 'multiselect', 'list',
]);

function parseArgs(argv) {
  const args = { apply: false, tenant: DEFAULT_TENANT_ID };
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a.startsWith('--tenant=')) args.tenant = a.split('=')[1];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/migrate-partner-core-to-custom-fields.mjs [--dry-run | --apply] [--tenant <uuid>]');
      process.exit(0);
    } else {
      console.error(`Error: unknown flag "${a}". Use --help.`);
      process.exit(2);
    }
  }
  if (explicitDryRun && args.apply) {
    console.error('Error: --dry-run and --apply are mutually exclusive.');
    process.exit(2);
  }
  return args;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL + SUPABASE_SERVICE_KEY (or DEST_SUPABASE_URL + DEST_SUPABASE_KEY) must be set.');
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function matchField(rows, nameCandidates, labelCandidates) {
  const norm = (s) => (s || '').toString().trim().toLowerCase();
  return rows.find(r => nameCandidates.has(norm(r.name)) || labelCandidates.has(norm(r.label))) || null;
}

function serialiseForFieldType(rawValue, fieldType) {
  const t = (fieldType || '').toLowerCase();
  if (MULTI_FIELD_TYPES.has(t)) {
    const arr = Array.isArray(rawValue) ? rawValue : [rawValue];
    return JSON.stringify(arr);
  }
  return String(rawValue);
}

function pad(s, n) {
  const str = s == null ? '' : String(s);
  if (str.length >= n) return str;
  return str + ' '.repeat(n - str.length);
}

async function loadOrgScopedFields(supabase, tenantId) {
  const { data, error } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, entity_scope, tenant_id')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization');
  if (error) throw error;
  return data || [];
}

async function findPartnerOrgIds(supabase, tenantId, orgTypeFieldId) {
  // The stored value may be either the raw "Partner" or the JSON-encoded
  // '"Partner"' depending on the writing path. Accept both.
  const { data, error } = await supabase
    .from('organization_preference_value')
    .select('organization_id, value')
    .eq('field_id', orgTypeFieldId)
    .in('value', [PARTNER_VALUE, JSON.stringify(PARTNER_VALUE)]);
  if (error) throw error;
  // Restrict to orgs in the target tenant.
  const ids = Array.from(new Set((data || []).map(r => r.organization_id)));
  if (ids.length === 0) return [];
  const out = [];
  // Fetch in chunks to keep the IN clause manageable.
  const chunk = 500;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const { data: orgs, error: oErr } = await supabase
      .from('organization')
      .select('id, name, website_url, phone, tenant_id')
      .eq('tenant_id', tenantId)
      .in('id', slice);
    if (oErr) throw oErr;
    out.push(...(orgs || []));
  }
  return out;
}

async function loadExistingPrefValues(supabase, orgIds, fieldIds) {
  if (orgIds.length === 0 || fieldIds.length === 0) return new Map();
  const map = new Map(); // key = `${organization_id}::${field_id}` -> { id, value }
  const chunk = 500;
  for (let i = 0; i < orgIds.length; i += chunk) {
    const slice = orgIds.slice(i, i + chunk);
    const { data, error } = await supabase
      .from('organization_preference_value')
      .select('id, organization_id, field_id, value')
      .in('organization_id', slice)
      .in('field_id', fieldIds);
    if (error) throw error;
    for (const r of data || []) {
      map.set(`${r.organization_id}::${r.field_id}`, { id: r.id, value: r.value });
    }
  }
  return map;
}

async function upsertPrefValue(supabase, orgId, field, rawValue, existing) {
  const stored = serialiseForFieldType(rawValue, field.field_type);
  if (existing) {
    if (existing.value === stored) return { action: 'noop' };
    const { error } = await supabase
      .from('organization_preference_value')
      .update({ value: stored })
      .eq('id', existing.id);
    if (error) throw error;
    return { action: 'updated', stored };
  }
  const { error } = await supabase
    .from('organization_preference_value')
    .insert({ organization_id: orgId, field_id: field.id, value: stored });
  if (error) throw error;
  return { action: 'inserted', stored };
}

async function clearCoreColumn(supabase, orgId, column) {
  const patch = {};
  patch[column] = null;
  const { error } = await supabase.from('organization').update(patch).eq('id', orgId);
  if (error) throw error;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = args.tenant;

  console.log(`\n=== Migrate Partner core website_url/phone -> partner_website/partner_phone custom fields ===`);
  console.log(`tenant=${tenantId}  apply=${args.apply}\n`);

  const supabase = getSupabase();

  // 1. Locate the relevant preference fields.
  const orgFields = await loadOrgScopedFields(supabase, tenantId);
  const orgTypeField = matchField(orgFields, ORG_TYPE_NAME_CANDIDATES, ORG_TYPE_LABEL_CANDIDATES);
  const websiteField = matchField(orgFields, PARTNER_WEBSITE_NAME_CANDIDATES, PARTNER_WEBSITE_LABEL_CANDIDATES);
  const phoneField = matchField(orgFields, PARTNER_PHONE_NAME_CANDIDATES, PARTNER_PHONE_LABEL_CANDIDATES);

  const missing = [];
  if (!orgTypeField) missing.push('Organisation Type');
  if (!websiteField) missing.push('partner_website (or partner_webite)');
  if (!phoneField) missing.push('partner_phone');
  if (missing.length > 0) {
    console.error(`ERROR: could not find required preference field(s): ${missing.join(', ')}`);
    console.error(`Available org-scoped preference fields for tenant ${tenantId}:`);
    for (const f of orgFields) {
      console.error(`  id=${f.id}  name=${JSON.stringify(f.name)}  label=${JSON.stringify(f.label)}  field_type=${f.field_type}`);
    }
    process.exit(1);
  }

  console.log(`  Organisation Type field: id=${orgTypeField.id}  name=${orgTypeField.name}  label=${orgTypeField.label}  type=${orgTypeField.field_type}`);
  console.log(`  partner_website field:   id=${websiteField.id}  name=${websiteField.name}  label=${websiteField.label}  type=${websiteField.field_type}`);
  console.log(`  partner_phone field:     id=${phoneField.id}  name=${phoneField.name}  label=${phoneField.label}  type=${phoneField.field_type}`);

  // 2. Find Partner orgs.
  const partnerOrgs = await loadPartnerOrgs(supabase, tenantId, orgTypeField.id);
  console.log(`\n  Partner organisations found: ${partnerOrgs.length}`);
  if (partnerOrgs.length === 0) {
    console.log('  Nothing to do.\n');
    return;
  }

  // 3. Pre-load any existing partner_website / partner_phone preference values.
  const existingMap = await loadExistingPrefValues(
    supabase,
    partnerOrgs.map(o => o.id),
    [websiteField.id, phoneField.id],
  );

  // 4. Build a per-org plan and print the dry-run table.
  const plans = partnerOrgs.map(org => {
    const websiteExisting = existingMap.get(`${org.id}::${websiteField.id}`) || null;
    const phoneExisting   = existingMap.get(`${org.id}::${phoneField.id}`)   || null;
    const websiteAction = planAction(org.website_url, websiteExisting, websiteField);
    const phoneAction   = planAction(org.phone,       phoneExisting,   phoneField);
    return { org, websiteExisting, phoneExisting, websiteAction, phoneAction };
  });

  console.log(`\n  ${pad('org id', 38)} ${pad('name', 32)} ${pad('website_url', 36)} ${pad('phone', 22)} ${pad('web pref?', 9)} ${pad('phone pref?', 11)} ${pad('website action', 22)} ${pad('phone action', 22)}`);
  console.log(`  ${'-'.repeat(38)} ${'-'.repeat(32)} ${'-'.repeat(36)} ${'-'.repeat(22)} ${'-'.repeat(9)} ${'-'.repeat(11)} ${'-'.repeat(22)} ${'-'.repeat(22)}`);
  for (const p of plans) {
    const webExists = p.websiteExisting ? 'yes' : 'no';
    const phoneExists = p.phoneExisting ? 'yes' : 'no';
    console.log(`  ${pad(p.org.id, 38)} ${pad((p.org.name || '').slice(0, 32), 32)} ${pad(p.org.website_url || '(empty)', 36)} ${pad(p.org.phone || '(empty)', 22)} ${pad(webExists, 9)} ${pad(phoneExists, 11)} ${pad(p.websiteAction.label, 22)} ${pad(p.phoneAction.label, 22)}`);
  }

  // 5. Tally per-field skip counts.
  const tally = (planActions) => {
    const t = { skipEmpty: 0, willMove: 0, willOverwrite: 0, alreadyMatches: 0 };
    for (const a of planActions) {
      if (a.kind === 'skip-empty') t.skipEmpty++;
      else if (a.kind === 'insert') t.willMove++;
      else if (a.kind === 'update') t.willOverwrite++;
      else if (a.kind === 'noop-target-matches') t.alreadyMatches++;
    }
    return t;
  };
  const wt = tally(plans.map(p => p.websiteAction));
  const pt = tally(plans.map(p => p.phoneAction));
  console.log(`\n  Website plan: skip(empty)=${wt.skipEmpty}  insert=${wt.willMove}  update(overwrite)=${wt.willOverwrite}  already-matches=${wt.alreadyMatches}`);
  console.log(`  Phone plan:   skip(empty)=${pt.skipEmpty}  insert=${pt.willMove}  update(overwrite)=${pt.willOverwrite}  already-matches=${pt.alreadyMatches}`);

  if (!args.apply) {
    console.log(`\n  DRY RUN — re-run with --apply to perform the migration.\n`);
    return;
  }

  // 6. Apply: per-org, per-field.
  console.log(`\n  Applying ...`);
  const results = {
    website: { skipped: 0, moved: 0, failed: [] },
    phone:   { skipped: 0, moved: 0, failed: [] },
  };

  for (const p of plans) {
    await applyOneField(supabase, p.org, websiteField, 'website_url', p.org.website_url, p.websiteExisting, p.websiteAction, results.website);
    await applyOneField(supabase, p.org, phoneField,   'phone',       p.org.phone,       p.phoneExisting,   p.phoneAction,   results.phone);
  }

  // 7. Summary.
  console.log(`\n=== Summary ===`);
  console.log(`  Partner orgs found: ${partnerOrgs.length}`);
  console.log(`  Website: skipped(no value)=${results.website.skipped}  moved OK=${results.website.moved}  failed=${results.website.failed.length}`);
  console.log(`  Phone:   skipped(no value)=${results.phone.skipped}  moved OK=${results.phone.moved}  failed=${results.phone.failed.length}`);
  if (results.website.failed.length > 0) {
    console.log(`\n  Website failures:`);
    for (const f of results.website.failed) console.log(`    ${f.orgId} (${f.orgName}) — ${f.error}`);
  }
  if (results.phone.failed.length > 0) {
    console.log(`\n  Phone failures:`);
    for (const f of results.phone.failed) console.log(`    ${f.orgId} (${f.orgName}) — ${f.error}`);
  }
  console.log('');
}

async function loadPartnerOrgs(supabase, tenantId, orgTypeFieldId) {
  return findPartnerOrgIds(supabase, tenantId, orgTypeFieldId);
}

function planAction(coreValue, existing, field) {
  if (coreValue === null || coreValue === undefined || String(coreValue).trim() === '') {
    return { kind: 'skip-empty', label: 'skip (no value)' };
  }
  const stored = serialiseForFieldType(coreValue, field.field_type);
  if (!existing) {
    return { kind: 'insert', label: 'INSERT pref + clear core' };
  }
  if (existing.value === stored) {
    return { kind: 'noop-target-matches', label: 'matches; clear core' };
  }
  return { kind: 'update', label: 'UPDATE pref + clear core' };
}

async function applyOneField(supabase, org, field, coreColumn, coreValue, existing, action, bucket) {
  if (action.kind === 'skip-empty') {
    bucket.skipped++;
    return;
  }
  try {
    await upsertPrefValue(supabase, org.id, field, coreValue, existing);
    await clearCoreColumn(supabase, org.id, coreColumn);
    bucket.moved++;
    console.log(`    [ok] ${coreColumn} ${org.id} (${org.name || ''}) — ${action.label}`);
  } catch (err) {
    const msg = err?.message || String(err);
    bucket.failed.push({ orgId: org.id, orgName: org.name || '', error: msg });
    console.log(`    [error] ${coreColumn} ${org.id} (${org.name || ''}) — ${msg}`);
  }
}

main().catch(err => {
  console.error('FATAL:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
