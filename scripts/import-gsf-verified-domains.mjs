#!/usr/bin/env node
/**
 * Bulk-import verified email domains onto organisations in the GSF
 * tenant from a CSV (`organization_id;domain`, one pair per line, a given
 * organization_id may appear multiple times).
 *
 * The CSV is treated as authoritative: the resulting deduped, lowercased,
 * trimmed domain array REPLACES any existing `verified_domains` value on
 * each org.
 *
 * Values are written to `organization_preference_value` keyed by
 * (organization_id, field_id) with `value` stored as a JSON-stringified
 * array — matches the existing storage format, which the public domains
 * API tolerates as either stringified-JSON or native-array.
 *
 * Tenant-pinned by design: refuses to run for any other TENANT_ID.
 * Field-pinned: hard-pinned field_id, additionally verified at startup
 * to still exist, be active, and belong to the GSF tenant.
 * Idempotent: re-running with the same CSV produces zero updates.
 * Dry-run by default; require --apply to write.
 *
 * Usage:
 *   DEST_SUPABASE_URL=... DEST_SUPABASE_KEY=... \
 *   node scripts/import-gsf-verified-domains.mjs \
 *     [--apply] [--verbose] [--csv=<path>] [--org=<uuid>]
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const ALLOWED_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const TENANT_ID = process.env.TENANT_ID || ALLOWED_TENANT_ID;

if (TENANT_ID !== ALLOWED_TENANT_ID) {
  console.error(
    `[import-gsf-verified-domains] Refusing to run for tenant ${TENANT_ID}. ` +
    `This script is hard-pinned to ${ALLOWED_TENANT_ID}.`,
  );
  process.exit(1);
}

const VERIFIED_DOMAINS_FIELD_ID = '2dae5d47-3887-4d39-a7cf-f34cc45fedc1';
const DEFAULT_CSV_PATH = 'attached_assets/verified_domains_to_import_iConnect_1779959761913.csv';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const csvArg = args.find(a => a.startsWith('--csv='));
const orgArg = args.find(a => a.startsWith('--org='));
const CSV_PATH = csvArg ? csvArg.slice('--csv='.length) : DEFAULT_CSV_PATH;
const ONLY_ORG = orgArg ? orgArg.slice('--org='.length).trim().toLowerCase() : null;

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
  console.error('[import-gsf-verified-domains] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseExistingValue(raw) {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(s => String(s));
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter(Boolean).map(s => String(s));
      return [String(parsed)].filter(Boolean);
    } catch {
      return trimmed.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function setEquals(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a.map(s => s.toLowerCase()));
  for (const v of b) if (!sa.has(String(v).toLowerCase())) return false;
  return true;
}

function loadCsv(path) {
  const abs = resolvePath(path);
  let text = readFileSync(abs, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);

  const byOrg = new Map(); // orgId -> ordered array of lowercased domains
  let rowCount = 0;
  let blank = 0;
  let malformed = 0;
  let headerSkipped = false;
  const skippedSamples = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) { blank++; continue; }
    const parts = line.split(';');
    if (parts.length < 2) { malformed++; if (skippedSamples.length < 5) skippedSamples.push({ line: i + 1, text: line, reason: 'no_separator' }); continue; }
    const orgIdRaw = (parts[0] || '').trim();
    const domainRaw = (parts.slice(1).join(';') || '').trim();
    if (!headerSkipped && orgIdRaw.toLowerCase() === 'organization_id') {
      headerSkipped = true;
      continue;
    }
    if (!orgIdRaw && !domainRaw) { blank++; continue; }
    if (!orgIdRaw) {
      malformed++;
      if (skippedSamples.length < 5) skippedSamples.push({ line: i + 1, text: line, reason: 'missing_org_id' });
      continue;
    }
    if (!UUID_RE.test(orgIdRaw)) {
      malformed++;
      if (skippedSamples.length < 5) skippedSamples.push({ line: i + 1, text: line, reason: 'bad_uuid' });
      continue;
    }
    if (!domainRaw) {
      malformed++;
      if (skippedSamples.length < 5) skippedSamples.push({ line: i + 1, text: line, reason: 'empty_domain' });
      continue;
    }
    rowCount++;
    const orgId = orgIdRaw.toLowerCase();
    const domain = domainRaw.toLowerCase();
    if (!byOrg.has(orgId)) byOrg.set(orgId, []);
    const arr = byOrg.get(orgId);
    if (!arr.some(d => d === domain)) arr.push(domain);
  }

  return { byOrg, rowCount, blank, malformed, skippedSamples };
}

async function verifyFieldDefinition() {
  const { data, error } = await supabase
    .from('preference_field')
    .select('id, name, entity_scope, tenant_id, is_active, field_type')
    .eq('id', VERIFIED_DOMAINS_FIELD_ID)
    .maybeSingle();
  if (error) throw new Error(`preference_field lookup failed: ${error.message}`);
  if (!data) throw new Error(`preference_field ${VERIFIED_DOMAINS_FIELD_ID} not found`);
  if (data.tenant_id !== TENANT_ID) {
    throw new Error(`preference_field ${VERIFIED_DOMAINS_FIELD_ID} belongs to tenant ${data.tenant_id}, expected ${TENANT_ID}`);
  }
  if (data.entity_scope !== 'organization') {
    throw new Error(`preference_field ${VERIFIED_DOMAINS_FIELD_ID} entity_scope is ${data.entity_scope}, expected 'organization'`);
  }
  if (data.name !== 'verified_domains') {
    throw new Error(`preference_field ${VERIFIED_DOMAINS_FIELD_ID} name is '${data.name}', expected 'verified_domains'`);
  }
  if (!data.is_active) {
    throw new Error(`preference_field ${VERIFIED_DOMAINS_FIELD_ID} is not active`);
  }
  return data;
}

async function fetchOrgsByIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const { data, error } = await supabase
      .from('organization')
      .select('id, tenant_id, name')
      .in('id', batch);
    if (error) throw new Error(`organization fetch failed: ${error.message}`);
    out.push(...(data || []));
  }
  return out;
}

async function fetchExistingPrefValues(orgIds) {
  const out = [];
  for (let i = 0; i < orgIds.length; i += 200) {
    const batch = orgIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('organization_preference_value')
      .select('id, organization_id, value')
      .eq('field_id', VERIFIED_DOMAINS_FIELD_ID)
      .in('organization_id', batch);
    if (error) throw new Error(`organization_preference_value fetch failed: ${error.message}`);
    out.push(...(data || []));
  }
  return out;
}

async function main() {
  console.log(APPLY ? '=== LIVE RUN ===' : '=== DRY RUN ===');
  console.log('Tenant       :', TENANT_ID);
  console.log('Field id     :', VERIFIED_DOMAINS_FIELD_ID);
  console.log('CSV          :', CSV_PATH);
  if (ONLY_ORG) console.log('Limit to org :', ONLY_ORG);
  console.log('');

  const field = await verifyFieldDefinition();
  console.log(`Verified field definition: name=${field.name}, type=${field.field_type}, active=${field.is_active}\n`);

  const { byOrg, rowCount, blank, malformed, skippedSamples } = loadCsv(CSV_PATH);
  console.log('=== CSV parse ===');
  console.log(`Data rows     : ${rowCount}`);
  console.log(`Blank lines   : ${blank}`);
  console.log(`Malformed     : ${malformed}`);
  if (skippedSamples.length > 0) {
    console.log('First skipped sample(s):');
    for (const s of skippedSamples) console.log(`  line ${s.line} [${s.reason}]: ${s.text}`);
  }

  let orgIds = Array.from(byOrg.keys());
  if (ONLY_ORG) {
    orgIds = orgIds.filter(id => id === ONLY_ORG);
    console.log(`After --org filter: ${orgIds.length} org(s)`);
  }
  console.log(`Distinct orgs : ${orgIds.length}\n`);

  if (orgIds.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const orgs = await fetchOrgsByIds(orgIds);
  const orgById = new Map(orgs.map(o => [o.id.toLowerCase(), o]));

  const skippedMissing = [];
  const skippedForeignTenant = [];
  const validOrgIds = [];
  for (const id of orgIds) {
    const o = orgById.get(id);
    if (!o) { skippedMissing.push(id); continue; }
    if (o.tenant_id !== TENANT_ID) { skippedForeignTenant.push(id); continue; }
    validOrgIds.push(id);
  }

  const existing = await fetchExistingPrefValues(validOrgIds);
  const existingByOrg = new Map(existing.map(r => [r.organization_id.toLowerCase(), r]));

  const inserts = [];   // orgs with no existing row, will insert
  const updates = [];   // orgs with existing row whose set differs
  const unchanged = []; // orgs with existing row matching desired set
  const diffsToPrint = [];

  for (const id of validOrgIds) {
    const desired = byOrg.get(id);
    const row = existingByOrg.get(id);
    if (!row) {
      inserts.push({ organization_id: id, desired });
      if (diffsToPrint.length < 10) diffsToPrint.push({ id, before: [], after: desired, action: 'insert' });
      continue;
    }
    const current = parseExistingValue(row.value);
    if (setEquals(current, desired)) {
      unchanged.push(id);
    } else {
      updates.push({ id, rowId: row.id, desired, before: current });
      if (diffsToPrint.length < 10) diffsToPrint.push({ id, before: current, after: desired, action: 'update' });
    }
  }

  console.log('=== Plan ===');
  console.log(`Total CSV rows           : ${rowCount}`);
  console.log(`Distinct orgs in CSV     : ${orgIds.length}`);
  console.log(`Skipped (org missing)    : ${skippedMissing.length}`);
  console.log(`Skipped (foreign tenant) : ${skippedForeignTenant.length}`);
  console.log(`Unchanged                : ${unchanged.length}`);
  console.log(`Insert (new value rows)  : ${inserts.length}`);
  console.log(`Update (replace value)   : ${updates.length}`);
  const totalDomains = validOrgIds.reduce((n, id) => n + byOrg.get(id).length, 0);
  console.log(`Total domains in target  : ${totalDomains}`);

  if (skippedMissing.length > 0) {
    console.log(`Sample missing org ids   : ${skippedMissing.slice(0, 5).join(', ')}`);
  }
  if (skippedForeignTenant.length > 0) {
    console.log(`Sample foreign-tenant ids: ${skippedForeignTenant.slice(0, 5).join(', ')}`);
  }

  if (!APPLY && diffsToPrint.length > 0) {
    console.log('\n=== First diffs (dry-run preview) ===');
    for (const d of diffsToPrint) {
      console.log(`  [${d.action}] ${d.id}`);
      console.log(`    before: ${JSON.stringify(d.before)}`);
      console.log(`    after : ${JSON.stringify(d.after)}`);
    }
  }
  if (VERBOSE) {
    console.log('\nAll planned changes:');
    for (const i of inserts) console.log(`  insert ${i.organization_id} -> ${JSON.stringify(i.desired)}`);
    for (const u of updates) console.log(`  update ${u.id} ${JSON.stringify(u.before)} -> ${JSON.stringify(u.desired)}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN complete. Re-run with --apply to write.');
    return;
  }

  if (inserts.length === 0 && updates.length === 0) {
    console.log('\nNothing to write.');
    return;
  }

  // Upsert in chunks. Use onConflict on (organization_id, field_id) so we
  // collapse insert/update into one path; supply id when known so update
  // path is unambiguous to PostgREST.
  const rows = [
    ...inserts.map(i => ({
      organization_id: i.organization_id,
      field_id: VERIFIED_DOMAINS_FIELD_ID,
      value: JSON.stringify(i.desired),
    })),
    ...updates.map(u => ({
      id: u.rowId,
      organization_id: u.id,
      field_id: VERIFIED_DOMAINS_FIELD_ID,
      value: JSON.stringify(u.desired),
    })),
  ];

  let written = 0;
  let errors = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const { error } = await supabase
      .from('organization_preference_value')
      .upsert(batch, { onConflict: 'organization_id,field_id' });
    if (error) {
      console.error(`Upsert batch failed (${batch.length} rows):`, error.message);
      errors += batch.length;
    } else {
      written += batch.length;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Inserts attempted : ${inserts.length}`);
  console.log(`Updates attempted : ${updates.length}`);
  console.log(`Rows written      : ${written}`);
  console.log(`Errors            : ${errors}`);
  console.log(`Unchanged         : ${unchanged.length}`);
  console.log(`Skipped (missing) : ${skippedMissing.length}`);
  console.log(`Skipped (foreign) : ${skippedForeignTenant.length}`);
  if (errors > 0) process.exit(1);
}

main().catch(err => {
  console.error('[import-gsf-verified-domains] Failed:', err.message || err);
  process.exit(1);
});
