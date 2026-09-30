#!/usr/bin/env node
/**
 * Update existing BNMS organisations from the reviewed 268-row CSV.
 *
 * Destination-only and dry-run by default:
 *   node scripts/update-bnms-organisations-from-csv.mjs
 *   node scripts/update-bnms-organisations-from-csv.mjs --apply
 */

import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = path.join(ROOT, 'attached_assets', 'Organisation_data_updated_to_import_31.08.26_1788194727640.csv');
const BNMS_TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const EXPECTED_HEADERS = [
  'id', 'name', 'Type', 'Country', 'Region', 'Town/city', 'Website',
  'Invoicing Address', 'Invoicing Email', 'Email', 'Phone', 'Site code', 'Parent code',
];
const EXPECTED_ROWS = 268;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVED_SOURCE_CORRECTIONS = new Map([
  ['56b21482-c150-4f2f-9d3e-767012209714', {
    reason: 'Website cell contained an email address; moved to Email and cleared Website.',
  }],
  ['55b65591-6a02-4370-9805-c0c720924d79', {
    exclude: true,
    reason: 'Approved exclusion: duplicate University of Oxford row; row 246 carries the valid existing BNMS ID.',
  }],
]);

const CORE_SPECS = [
  { header: 'name', key: 'name', column: 'name' },
  { header: 'Website', key: 'website', column: 'website_url' },
  { header: 'Invoicing Address', key: 'invoicingAddress', column: 'invoicing_address' },
  { header: 'Invoicing Email', key: 'invoicingEmail', column: 'invoicing_email' },
  { header: 'Email', key: 'email', column: 'email' },
  { header: 'Phone', key: 'phone', column: 'phone' },
];
const CUSTOM_SPECS = [
  { header: 'Type', key: 'type', name: 'organisation_type', label: 'Type', fieldType: 'dropdown' },
  { header: 'Country', key: 'country', name: 'country', label: 'Country', fieldType: 'country' },
  { header: 'Region', key: 'region', name: 'region', label: 'Region', fieldType: 'dropdown' },
  { header: 'Town/city', key: 'townCity', name: 'town_city', label: 'Town/city', fieldType: 'text' },
  { header: 'Site code', key: 'siteCode', name: 'site_code', label: 'Site code', fieldType: 'text' },
  { header: 'Parent code', key: 'parentCode', name: 'parent_code', label: 'Parent code', fieldType: 'text' },
];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const unknown = argv.filter((arg) => !['--apply', '--dry-run', '--help', '-h'].includes(arg));
  if (unknown.length) fail(`Unknown argument "${unknown[0]}".`);
  if (argv.includes('--apply') && argv.includes('--dry-run')) fail('--apply and --dry-run are mutually exclusive.');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/update-bnms-organisations-from-csv.mjs [--dry-run | --apply]');
    process.exit(0);
  }
  return { apply: argv.includes('--apply') };
}

function getSupabase() {
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; source and bare Supabase credentials are forbidden.');
  return createClient(url, key, { auth: { persistSession: false } });
}

function validateEmail(value, sourceRow, header) {
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    fail(`Source row ${sourceRow}, "${header}" is not a valid email address: "${value}".`);
  }
}

function validateWebsite(value, sourceRow) {
  if (!value) return;
  if (/\s/.test(value)) fail(`Source row ${sourceRow}, "Website" contains whitespace: "${value}".`);
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (!parsed.hostname.includes('.')) fail('hostname has no dot');
    } catch {
      fail(`Source row ${sourceRow}, "Website" is not a valid HTTP(S) URL: "${value}".`);
    }
  } else if (!/^(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:[/?#].*)?$/i.test(value)) {
    fail(`Source row ${sourceRow}, "Website" is neither an HTTP(S) URL nor a valid hostname: "${value}".`);
  }
}

function readSource() {
  const text = new TextDecoder('windows-1252', { fatal: true }).decode(fs.readFileSync(SOURCE_FILE));
  const grid = parse(text, { bom: true, columns: false, relax_column_count: false, skip_empty_lines: true });
  const headers = (grid[0] || []).map((value) => String(value ?? '').trim());
  if (headers.length !== EXPECTED_HEADERS.length || headers.some((value, index) => value !== EXPECTED_HEADERS[index])) {
    fail(`CSV headers must be exactly: ${EXPECTED_HEADERS.join(' | ')}. Found: ${headers.join(' | ') || '(none)'}.`);
  }
  if (grid.length - 1 !== EXPECTED_ROWS) fail(`CSV must contain exactly ${EXPECTED_ROWS} data rows; found ${grid.length - 1}.`);

  const seenIds = new Map();
  const excludedRows = [];
  const rows = grid.slice(1).map((raw, index) => {
    const sourceRow = index + 2;
    if (raw.length !== EXPECTED_HEADERS.length) fail(`Source row ${sourceRow} has ${raw.length} columns; expected ${EXPECTED_HEADERS.length}.`);
    const values = raw.map((value) => String(value ?? '').trim());
    const originalId = values[0];
    const correction = APPROVED_SOURCE_CORRECTIONS.get(originalId);
    const id = originalId;
    const [ignoredId, name, type, country, region, townCity, website, invoicingAddress, invoicingEmail, email, phone, siteCode, parentCode] = values;
    if (!UUID_RE.test(id)) fail(`Source row ${sourceRow} has a blank or invalid UUID: "${originalId}".`);
    if (seenIds.has(id)) fail(`Duplicate source ID ${id} at rows ${seenIds.get(id)} and ${sourceRow}.`);
    if (!name) fail(`Source row ${sourceRow} has a blank organisation name.`);
    if (values.some((value) => value.includes('\uFFFD'))) fail(`Source row ${sourceRow} contains a replacement character from a lossy decode.`);
    if (correction) {
      if (originalId === '56b21482-c150-4f2f-9d3e-767012209714'
        && (website !== 'uhsussex.nuclearmedicine@nhs.net' || email)) {
        fail(`Approved correction no longer matches source row ${sourceRow}; review the source before applying.`);
      }
      if (originalId === '56b21482-c150-4f2f-9d3e-767012209714') {
        values[6] = '';
        values[9] = website;
      }
    }
    validateWebsite(values[6], sourceRow);
    validateEmail(invoicingEmail, sourceRow, 'Invoicing Email');
    validateEmail(values[9], sourceRow, 'Email');
    const row = {
      sourceRow, id, originalId, name: values[1], type: values[2], country: values[3], region: values[4],
      townCity: values[5], website: values[6], invoicingAddress: values[7], invoicingEmail: values[8],
      email: values[9], phone: values[10], siteCode: values[11], parentCode: values[12],
      sourceCorrection: correction?.reason || null,
    };
    if (correction?.exclude) {
      excludedRows.push(row);
      return null;
    }
    seenIds.set(id, sourceRow);
    return row;
  }).filter(Boolean);
  return { rows, excludedRows };
}

async function auditTenant(supabase) {
  const { data, error } = await supabase.from('tenant').select('id, name').eq('id', BNMS_TENANT_ID).single();
  if (error || !data?.id) fail(`Could not resolve BNMS tenant ${BNMS_TENANT_ID}: ${error?.message || 'not found'}.`);
  if (!/^(BNMS|British Nuclear Medicine Society)$/i.test(String(data.name || '').trim())) {
    fail(`Tenant ${BNMS_TENANT_ID} is "${data.name}", not the expected BNMS tenant.`);
  }
  return data;
}

function optionValues(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { fail('A destination dropdown has invalid JSON options.'); }
  }
  if (!Array.isArray(raw)) fail('A destination dropdown options value is not an array.');
  return raw.map((option) => String(option && typeof option === 'object' ? (option.value ?? option.label ?? '') : option).trim()).filter(Boolean);
}

async function auditFields(supabase, rows) {
  const { data, error } = await supabase.from('preference_field')
    .select('id, tenant_id, name, label, field_type, options, is_active, entity_scope')
    .eq('tenant_id', BNMS_TENANT_ID)
    .eq('entity_scope', 'organization')
    .in('name', CUSTOM_SPECS.map((spec) => spec.name))
    .order('id', { ascending: true });
  if (error) fail(`Could not read BNMS organisation field definitions: ${error.message}`);
  return CUSTOM_SPECS.map((spec) => {
    const matches = (data || []).filter((field) => field.name === spec.name);
    if (matches.length !== 1) fail(`Expected exactly one BNMS organisation field named "${spec.name}"; found ${matches.length}.`);
    const field = matches[0];
    if (!field.is_active || field.label !== spec.label || field.field_type !== spec.fieldType
      || field.entity_scope !== 'organization' || field.tenant_id !== BNMS_TENANT_ID) {
      fail(`Invalid mapping for "${spec.header}": ${spec.name} must be the active BNMS organization field labelled "${spec.label}" with type "${spec.fieldType}".`);
    }
    const options = spec.fieldType === 'dropdown' ? optionValues(field.options) : [];
    const desiredValues = [...new Set(rows.map((row) => row[spec.key]).filter(Boolean))].sort();
    const unsupported = spec.fieldType === 'dropdown' ? desiredValues.filter((value) => !options.includes(value)) : [];
    if (unsupported.length) fail(`Unsupported ${spec.name} dropdown value(s): ${unsupported.join(', ')}.`);
    return { ...spec, ...field, optionValues: options, desiredValues };
  });
}

async function loadOrganizationsByIds(supabase, ids) {
  const result = new Map();
  const columns = ['id', 'tenant_id', ...CORE_SPECS.map((spec) => spec.column)].join(', ');
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    const { data, error } = await supabase.from('organization').select(columns).in('id', batch).order('id', { ascending: true });
    if (error) fail(`Could not resolve source organisation IDs: ${error.message}`);
    for (const organization of data || []) {
      if (result.has(organization.id)) fail(`Destination returned duplicate organisation ID ${organization.id}.`);
      result.set(organization.id, organization);
    }
  }
  return result;
}

function prefKey(organizationId, fieldId) {
  return `${organizationId}::${fieldId}`;
}

async function loadValues(supabase, organizationIds, fieldIds) {
  const result = new Map();
  for (let start = 0; start < organizationIds.length; start += 100) {
    const ids = organizationIds.slice(start, start + 100);
    for (let from = 0; ; from += 500) {
      const { data, error } = await supabase.from('organization_preference_value')
        .select('id, organization_id, field_id, value')
        .in('organization_id', ids).in('field_id', fieldIds)
        .order('id', { ascending: true }).range(from, from + 499);
      if (error) fail(`Could not read BNMS organisation custom values: ${error.message}`);
      for (const value of data || []) {
        const key = prefKey(value.organization_id, value.field_id);
        if (result.has(key)) fail(`Duplicate stored custom values for ${key}; apply is blocked.`);
        result.set(key, value);
      }
      if ((data || []).length < 500) break;
    }
  }
  return result;
}

function makePlan(rows, organizations, fields, values) {
  const missing = rows.filter((row) => !organizations.has(row.id));
  const crossTenant = rows.filter((row) => organizations.get(row.id)?.tenant_id !== BNMS_TENANT_ID);
  if (missing.length) fail(`Source IDs missing from destination: ${missing.map((row) => `${row.id} (row ${row.sourceRow})`).join(', ')}.`);
  if (crossTenant.length) fail(`Source IDs outside BNMS tenant: ${crossTenant.map((row) => `${row.id} (row ${row.sourceRow})`).join(', ')}.`);

  return rows.map((row) => {
    const organization = organizations.get(row.id);
    const core = CORE_SPECS.map((spec) => {
      const current = String(organization[spec.column] ?? '');
      const desired = row[spec.key];
      return { spec, current, desired, action: current === desired ? 'unchanged' : desired ? 'update' : 'clear' };
    });
    const custom = fields.map((field) => {
      const existing = values.get(prefKey(row.id, field.id)) || null;
      const current = String(existing?.value ?? '');
      const desired = row[field.key];
      return { field, existing, current, desired, action: current === desired ? 'unchanged' : desired ? (existing ? 'update' : 'create') : 'clear' };
    });
    return { row, organization, core, custom };
  });
}

function summarize(plans, specs, accessor) {
  return specs.map((spec) => {
    const actions = plans.map((plan) => accessor(plan).find((item) => (item.spec || item.field).key === spec.key).action);
    return {
      label: spec.header,
      updates: actions.filter((action) => action === 'update').length,
      creates: actions.filter((action) => action === 'create').length,
      clears: actions.filter((action) => action === 'clear').length,
      unchanged: actions.filter((action) => action === 'unchanged').length,
    };
  });
}

function printPlan(rows, excludedRows, tenant, fields, plans) {
  console.log(`\nTenant: ${tenant.name} (${tenant.id})`);
  console.log('\n--- Validated source-to-destination mappings ---');
  console.log('  id -> organization.id (authoritative lookup only; never changed)');
  CORE_SPECS.forEach((spec) => console.log(`  ${spec.header} -> organization.${spec.column} (core)`));
  fields.forEach((field) => console.log(`  ${field.header} -> ${field.name} (${field.field_type}, ${field.id})`));
  console.log('\n--- Source and destination identity ---');
  console.log(`  Exact headers:              ${EXPECTED_HEADERS.length}/${EXPECTED_HEADERS.length}`);
  console.log(`  Source rows:                ${rows.length + excludedRows.length}/${EXPECTED_ROWS}`);
  console.log(`  Approved exclusions:        ${excludedRows.length}`);
  excludedRows.forEach((row) => console.log(`    row ${row.sourceRow} (${row.originalId}): ${row.sourceCorrection}`));
  console.log(`  Rows included for update:   ${rows.length}`);
  console.log(`  Unique nonblank UUIDs:      ${new Set(rows.map((row) => row.id)).size}/${rows.length}`);
  console.log(`  Existing BNMS matches:      ${plans.length}/${rows.length}`);
  console.log('  Missing/cross-tenant IDs:   0');
  console.log('  Unmapped columns:           0');
  console.log('  Unsupported dropdowns:      0');
  const corrections = rows.filter((row) => row.sourceCorrection);
  console.log(`  Approved source corrections: ${corrections.length}`);
  corrections.forEach((row) => console.log(`    row ${row.sourceRow} (${row.originalId} -> ${row.id}): ${row.sourceCorrection}`));
  console.log('\n--- Change summary (blank source values are explicit clears) ---');
  for (const item of summarize(plans, CORE_SPECS, (plan) => plan.core)) {
    console.log(`  ${item.label}: updates=${item.updates}, clears=${item.clears}, unchanged=${item.unchanged}`);
  }
  for (const item of summarize(plans, fields, (plan) => plan.custom)) {
    console.log(`  ${item.label}: creates=${item.creates}, updates=${item.updates}, clears=${item.clears}, unchanged=${item.unchanged}`);
  }
  const changes = plans.flatMap((plan) => [...plan.core, ...plan.custom]).filter((item) => item.action !== 'unchanged');
  console.log(`  Total remaining changes:    ${changes.length}`);
  return changes.length;
}

async function applyPlans(supabase, plans) {
  const result = { coreRowsUpdated: 0, coreValuesChanged: 0, customCreated: 0, customUpdated: 0, customCleared: 0 };
  const customCreates = [];
  for (const plan of plans) {
    const changedCore = plan.core.filter((item) => item.action !== 'unchanged');
    if (changedCore.length) {
      const payload = Object.fromEntries(changedCore.map((item) => [item.spec.column, item.desired || null]));
      const { data, error } = await supabase.from('organization').update(payload)
        .eq('id', plan.row.id).eq('tenant_id', BNMS_TENANT_ID)
        .select('id, tenant_id').single();
      if (error || data?.id !== plan.row.id || data?.tenant_id !== BNMS_TENANT_ID) {
        fail(`Could not update organisation ${plan.row.id}: ${error?.message || 'unexpected response'}.`);
      }
      result.coreRowsUpdated += 1;
      result.coreValuesChanged += changedCore.length;
    }
    for (const item of plan.custom.filter((value) => value.action !== 'unchanged')) {
      if (item.action === 'clear') {
        if (!item.existing) continue;
        const { error, count } = await supabase.from('organization_preference_value')
          .delete({ count: 'exact' }).eq('id', item.existing.id)
          .eq('organization_id', plan.row.id).eq('field_id', item.field.id);
        if (error || count !== 1) fail(`Could not clear ${item.field.name} for organisation ${plan.row.id}: ${error?.message || `deleted ${count} rows`}.`);
        result.customCleared += 1;
      } else if (item.action === 'update') {
        const { data, error } = await supabase.from('organization_preference_value')
          .update({ value: item.desired, updated_at: new Date().toISOString() })
          .eq('id', item.existing.id).eq('organization_id', plan.row.id).eq('field_id', item.field.id)
          .select('id, value').single();
        if (error || data?.value !== item.desired) fail(`Could not update ${item.field.name} for organisation ${plan.row.id}: ${error?.message || 'unexpected response'}.`);
        result.customUpdated += 1;
      } else {
        customCreates.push({
          organization_id: plan.row.id,
          field_id: item.field.id,
          value: item.desired,
        });
      }
    }
  }
  for (let start = 0; start < customCreates.length; start += 100) {
    const batch = customCreates.slice(start, start + 100);
    const { data, error } = await supabase.from('organization_preference_value')
      .insert(batch).select('id, organization_id, field_id, value');
    if (error || data?.length !== batch.length) {
      fail(`Could not create custom-value batch beginning at item ${start + 1}: ${error?.message || `expected ${batch.length} rows, received ${data?.length ?? 0}`}.`);
    }
    const returned = new Map(data.map((item) => [prefKey(item.organization_id, item.field_id), item.value]));
    const mismatch = batch.find((item) => returned.get(prefKey(item.organization_id, item.field_id)) !== item.value);
    if (mismatch) fail(`Custom-value batch response mismatch for ${prefKey(mismatch.organization_id, mismatch.field_id)}.`);
    result.customCreated += batch.length;
  }
  return result;
}

async function loadAndPlan(supabase, rows) {
  const tenant = await auditTenant(supabase);
  const fields = await auditFields(supabase, rows);
  const organizations = await loadOrganizationsByIds(supabase, rows.map((row) => row.id));
  const values = await loadValues(supabase, rows.map((row) => row.id), fields.map((field) => field.id));
  return { tenant, fields, plans: makePlan(rows, organizations, fields, values) };
}

async function verify(supabase, rows) {
  const { tenant, fields, plans } = await loadAndPlan(supabase, rows);
  const mismatches = plans.flatMap((plan) => [
    ...plan.core.filter((item) => item.action !== 'unchanged').map((item) => `${plan.row.id}: ${item.spec.column}`),
    ...plan.custom.filter((item) => item.action !== 'unchanged').map((item) => `${plan.row.id}: ${item.field.name}`),
  ]);
  if (mismatches.length) fail(`Post-import verification found ${mismatches.length} mismatch(es):\n  ${mismatches.slice(0, 50).join('\n  ')}`);
  console.log('\n=== Post-import verification passed ===');
  console.log(`  Tenant:                       ${tenant.name} (${tenant.id})`);
  console.log(`  Organisations re-read:        ${plans.length}/${rows.length}`);
  console.log('  Missing records:              0');
  console.log('  Tenant mismatches:            0');
  console.log('  Duplicate IDs/custom values:  0');
  console.log('  Unmapped columns:             0');
  console.log('  Unsupported dropdown values:  0');
  console.log('  Value mismatches:             0');
  fields.forEach((field) => console.log(`  Verified ${field.header}: ${plans.length}`));
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const { rows, excludedRows } = readSource();
  const supabase = getSupabase();
  console.log('\n=== Update BNMS organisations from CSV ===');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Source: ${SOURCE_FILE}`);
  const { tenant, fields, plans } = await loadAndPlan(supabase, rows);
  const changes = printPlan(rows, excludedRows, tenant, fields, plans);
  if (!apply) {
    console.log('\nNo writes performed. Re-run with --apply after reviewing this report.\n');
    return;
  }
  const result = await applyPlans(supabase, plans);
  console.log('\n=== Apply summary ===');
  Object.entries(result).forEach(([key, value]) => console.log(`  ${key}: ${value}`));
  console.log(`  Planned changes applied: ${changes}`);
  await verify(supabase, rows);
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});