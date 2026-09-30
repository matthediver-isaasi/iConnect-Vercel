#!/usr/bin/env node
/**
 * Import the BNMS student/university organisation CSV.
 *
 * Destination-only and dry-run by default:
 *   node scripts/import-bnms-universities.mjs
 *   node scripts/import-bnms-universities.mjs --apply
 */

import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = path.join(
  repoRoot,
  'attached_assets',
  'Student_university_data_to_import_25.08.26_1787810761075.csv',
);
const EXPECTED_HEADERS = ['Organisation', 'Category', 'Country', 'BNMS region', 'City', 'Website'];
const EXPECTED_ROWS = 36;
const BNMS_TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const FIELD_SPECS = [
  { header: 'Category', name: 'organisation_type', type: 'dropdown', key: 'category' },
  { header: 'Country', name: 'country', type: 'dropdown', key: 'country' },
  { header: 'BNMS region', name: 'region', type: 'dropdown', key: 'region' },
  { header: 'City', name: 'town_city', type: 'text', key: 'city' },
];
const SOURCE_CORRECTIONS = new Map([
  ['Bah�e?ehir University', 'Bahçeşehir University'],
  ['Bahçe?ehir University', 'Bahçeşehir University'],
  ['T�rkiye', 'Türkiye'],
  ['Universidad de la Rep�blica', 'Universidad de la República'],
]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/import-bnms-universities.mjs [--dry-run | --apply]');
      process.exit(0);
    } else fail(`Unknown argument "${arg}".`);
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) fail('--apply and --dry-run are mutually exclusive.');
  return { apply };
}

function supabaseClient() {
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; source/bare Supabase credentials are forbidden.');
  return createClient(url, key, { auth: { persistSession: false } });
}

function normName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-GB');
}

function correctKnownText(value) {
  const trimmed = String(value ?? '').trim();
  return SOURCE_CORRECTIONS.get(trimmed) ?? trimmed;
}

function assertLossless(value, rowNumber, header) {
  if (/[�]/u.test(value) || value.includes('?')) {
    fail(`Source row ${rowNumber}, "${header}" still contains unresolved lossy text: "${value}". Apply is blocked.`);
  }
}

function readSource() {
  const bytes = fs.readFileSync(SOURCE_FILE);
  // The supplied file is declared Latin-1. Decoding this way is deterministic;
  // known mojibake/lossy cells are corrected below before validation.
  const text = new TextDecoder('windows-1252').decode(bytes);
  const grid = parse(text, {
    bom: true,
    columns: false,
    relax_column_count: false,
    skip_empty_lines: true,
  });
  const headers = (grid[0] || []).map((value) => String(value ?? '').trim());
  if (headers.length !== EXPECTED_HEADERS.length || headers.some((value, i) => value !== EXPECTED_HEADERS[i])) {
    fail(`CSV header must be exactly: ${EXPECTED_HEADERS.join(' | ')}. Found: ${headers.join(' | ')}.`);
  }
  if (grid.length - 1 !== EXPECTED_ROWS) fail(`CSV must contain exactly ${EXPECTED_ROWS} data rows; found ${grid.length - 1}.`);

  const rows = grid.slice(1).map((raw, index) => {
    const sourceRow = index + 2;
    if (raw.length !== EXPECTED_HEADERS.length) fail(`Source row ${sourceRow} has ${raw.length} columns; expected ${EXPECTED_HEADERS.length}.`);
    const values = raw.map(correctKnownText);
    values.forEach((value, column) => assertLossless(value, sourceRow, EXPECTED_HEADERS[column]));
    if (!values[0]) fail(`Source row ${sourceRow} has a blank organisation name.`);
    if (values[5]) {
      let url;
      try { url = new URL(values[5]); } catch { fail(`Source row ${sourceRow} has an invalid website URL: "${values[5]}".`); }
      if (!['http:', 'https:'].includes(url.protocol)) fail(`Source row ${sourceRow} website must use http or https.`);
    }
    return {
      sourceRow,
      name: values[0],
      category: values[1],
      country: values[2],
      region: values[3],
      city: values[4],
      website: values[5],
    };
  });

  const sourceNames = new Map();
  for (const row of rows) {
    const key = normName(row.name);
    if (sourceNames.has(key)) fail(`Duplicate normalized source name at rows ${sourceNames.get(key).sourceRow} and ${row.sourceRow}: "${row.name}".`);
    sourceNames.set(key, row);
  }
  return rows;
}

function optionValues(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { fail('A destination dropdown contains invalid JSON options.'); }
  }
  if (raw == null) return [];
  if (!Array.isArray(raw)) fail('A destination dropdown options value is not an array.');
  return raw.map((option) => String(
    option && typeof option === 'object' ? (option.value ?? option.label ?? '') : option,
  ).trim()).filter(Boolean);
}

function optionObjects(values) {
  return values.map((value) => ({ label: value, value }));
}

async function fetchAllTenantOrganizations(supabase) {
  const rows = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('organization')
      .select('id, tenant_id, name, website_url')
      .eq('tenant_id', BNMS_TENANT_ID)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) fail(`Could not read BNMS organizations/core website column: ${error.message}`);
    rows.push(...(data || []));
    if ((data || []).length < pageSize) return rows;
  }
}

async function auditTenant(supabase) {
  const { data, error } = await supabase
    .from('tenant')
    .select('id, name')
    .eq('id', BNMS_TENANT_ID)
    .single();
  if (error || !data?.id) fail(`Could not resolve the BNMS tenant: ${error?.message || 'not found'}.`);
  if (!/British Nuclear Medicine Society|BNMS/i.test(data.name || '')) {
    fail(`Tenant ${BNMS_TENANT_ID} is "${data.name}", not the expected BNMS tenant.`);
  }
  return data;
}

async function auditFields(supabase, rows) {
  const { data, error } = await supabase
    .from('preference_field')
    .select('id, tenant_id, name, label, field_type, options, is_active, entity_scope')
    .eq('tenant_id', BNMS_TENANT_ID)
    .eq('entity_scope', 'organization')
    .in('name', FIELD_SPECS.map((spec) => spec.name))
    .order('id', { ascending: true });
  if (error) fail(`Could not read organization fields: ${error.message}`);

  return FIELD_SPECS.map((spec) => {
    const matches = (data || []).filter((field) => field.name === spec.name);
    if (matches.length !== 1) fail(`Expected exactly one organization field named "${spec.name}"; found ${matches.length}.`);
    const field = matches[0];
    if (!field.is_active || field.field_type !== spec.type) {
      fail(`Field "${spec.name}" must be active and type "${spec.type}"; found active=${field.is_active}, type="${field.field_type}".`);
    }
    const currentOptions = spec.type === 'dropdown' ? optionValues(field.options) : [];
    const desiredOptions = spec.type === 'dropdown'
      ? [...new Set(rows.map((row) => row[spec.key]).filter(Boolean))].sort()
      : [];
    const currentNorms = new Set(currentOptions.map(normName));
    const missingOptions = spec.type === 'dropdown'
      ? desiredOptions.filter((value) => !currentNorms.has(normName(value)))
      : [];
    return { ...spec, ...field, currentOptions, desiredOptions, missingOptions };
  });
}

function buildOrganizationMap(organizations, sourceRows) {
  const all = new Map();
  for (const organization of organizations) {
    const key = normName(organization.name);
    if (!all.has(key)) all.set(key, []);
    all.get(key).push(organization);
  }
  const ambiguous = [];
  for (const source of sourceRows) {
    const matches = all.get(normName(source.name)) || [];
    if (matches.length > 1) ambiguous.push({ source, matches });
  }
  if (ambiguous.length) {
    fail(`Ambiguous existing BNMS matches:\n${ambiguous.map(({ source, matches }) =>
      `  "${source.name}" -> ${matches.map((item) => `${item.name} (${item.id})`).join(', ')}`).join('\n')}`);
  }
  return new Map([...all].map(([key, matches]) => [key, matches[0]]));
}

function prefKey(organizationId, fieldId) {
  return `${organizationId}::${fieldId}`;
}

async function loadValues(supabase, organizationIds, fieldIds) {
  const result = new Map();
  for (let start = 0; start < organizationIds.length; start += 200) {
    const ids = organizationIds.slice(start, start + 200);
    for (let from = 0; ; from += 500) {
      const { data, error } = await supabase
        .from('organization_preference_value')
        .select('id, organization_id, field_id, value')
        .in('organization_id', ids)
        .in('field_id', fieldIds)
        .order('id', { ascending: true })
        .range(from, from + 499);
      if (error) fail(`Could not read organization custom values: ${error.message}`);
      for (const value of data || []) {
        const key = prefKey(value.organization_id, value.field_id);
        if (result.has(key)) fail(`Duplicate stored organization custom value for ${key}.`);
        result.set(key, value);
      }
      if ((data || []).length < 500) break;
    }
  }
  return result;
}

function planImport(rows, organizations, fields, values) {
  const organizationMap = buildOrganizationMap(organizations, rows);
  const plans = rows.map((row) => {
    const organization = organizationMap.get(normName(row.name)) || null;
    const websiteAction = !row.website ? 'blank'
      : !organization ? 'create'
      : organization.website_url === row.website ? 'unchanged' : 'update';
    const custom = fields.map((field) => {
      const existing = organization ? values.get(prefKey(organization.id, field.id)) : null;
      const desired = row[field.key];
      return {
        field,
        desired,
        existing,
        action: !desired ? 'blank' : existing?.value === desired ? 'unchanged' : existing ? 'update' : 'create',
      };
    });
    return { row, organization, action: organization ? 'existing' : 'create', websiteAction, custom };
  });
  return { organizationMap, plans };
}

function printPlan(rows, tenant, fields, plans) {
  console.log(`\nTenant: ${tenant.name} (${tenant.id})`);
  console.log('\n--- Source-to-destination mappings ---');
  console.log('  Organisation -> organization.name');
  console.log('  Website -> organization.website_url (blank never deletes)');
  fields.forEach((field) => console.log(`  ${field.header} -> ${field.name} (${field.field_type}, ${field.id})`));
  console.log('\n--- Dropdown option additions ---');
  const changes = fields.filter((field) => field.missingOptions.length);
  if (!changes.length) console.log('  None.');
  changes.forEach((field) => console.log(`  ${field.name}: ${field.missingOptions.join(', ')}`));
  console.log('\n--- Organisation plan ---');
  plans.forEach((plan) => {
    const customChanges = plan.custom.filter((item) => ['create', 'update'].includes(item.action)).length;
    console.log(`  ${plan.action === 'create' ? '+' : '~'} ${plan.row.name}: org=${plan.action}, website=${plan.websiteAction}, custom changes=${customChanges}`);
  });
  const customActions = plans.flatMap((plan) => plan.custom);
  console.log('\n--- Plan summary ---');
  console.log(`  Source rows:                 ${rows.length}`);
  console.log(`  Organisations to create:     ${plans.filter((plan) => plan.action === 'create').length}`);
  console.log(`  Existing organisations:      ${plans.filter((plan) => plan.action === 'existing').length}`);
  console.log(`  Websites to update/create:   ${plans.filter((plan) => ['update', 'create'].includes(plan.websiteAction)).length}`);
  console.log(`  Websites unchanged:          ${plans.filter((plan) => plan.websiteAction === 'unchanged').length}`);
  console.log(`  Blank websites skipped:      ${plans.filter((plan) => plan.websiteAction === 'blank').length}`);
  console.log(`  Custom values to write:      ${customActions.filter((item) => ['create', 'update'].includes(item.action)).length}`);
  console.log(`  Custom values unchanged:     ${customActions.filter((item) => item.action === 'unchanged').length}`);
  console.log(`  Dropdown options to add:     ${fields.reduce((sum, field) => sum + field.missingOptions.length, 0)}`);
  console.log('  Duplicate/ambiguous matches: 0');
}

async function applyOptions(supabase, fields) {
  for (const field of fields) {
    if (!field.missingOptions.length) continue;
    const next = [...field.currentOptions, ...field.missingOptions];
    const { data, error } = await supabase
      .from('preference_field')
      .update({ options: optionObjects(next) })
      .eq('id', field.id)
      .eq('tenant_id', BNMS_TENANT_ID)
      .select('id, options')
      .single();
    if (error || data?.id !== field.id) fail(`Could not update options for "${field.name}": ${error?.message || 'unexpected response'}.`);
    const persisted = new Set(optionValues(data.options).map(normName));
    if (field.desiredOptions.some((value) => !persisted.has(normName(value)))) fail(`Options did not persist for "${field.name}".`);
  }
}

async function applyOrganizations(supabase, plans, organizationMap, result) {
  for (const plan of plans) {
    let organization = plan.organization;
    if (!organization) {
      const payload = { tenant_id: BNMS_TENANT_ID, name: plan.row.name };
      if (plan.row.website) payload.website_url = plan.row.website;
      const { data, error } = await supabase.from('organization').insert(payload)
        .select('id, tenant_id, name, website_url').single();
      if (error || !data?.id || data.tenant_id !== BNMS_TENANT_ID || data.name !== plan.row.name) {
        fail(`Could not create "${plan.row.name}": ${error?.message || 'unexpected response'}.`);
      }
      organization = data;
      organizationMap.set(normName(data.name), data);
      result.organizationsCreated += 1;
      if (plan.row.website) result.websitesWritten += 1;
    } else if (plan.websiteAction === 'update') {
      const { data, error } = await supabase.from('organization')
        .update({ website_url: plan.row.website })
        .eq('id', organization.id).eq('tenant_id', BNMS_TENANT_ID)
        .select('id, tenant_id, website_url').single();
      if (error || data?.website_url !== plan.row.website || data?.tenant_id !== BNMS_TENANT_ID) {
        fail(`Could not update website for "${plan.row.name}": ${error?.message || 'unexpected response'}.`);
      }
      result.websitesWritten += 1;
    } else if (plan.websiteAction === 'unchanged') result.websitesUnchanged += 1;
    else if (plan.websiteAction === 'blank') result.blankWebsites += 1;
    plan.organization = organization;
  }
}

async function applyCustomValues(supabase, plans, result) {
  for (const plan of plans) {
    for (const item of plan.custom) {
      if (!item.desired) continue;
      const organizationId = plan.organization.id;
      if (item.action === 'unchanged') {
        result.customUnchanged += 1;
        continue;
      }
      let query;
      if (item.existing) {
        query = supabase.from('organization_preference_value')
          .update({ value: item.desired, updated_at: new Date().toISOString() })
          .eq('id', item.existing.id)
          .eq('organization_id', organizationId)
          .eq('field_id', item.field.id);
      } else {
        query = supabase.from('organization_preference_value').insert({
          organization_id: organizationId,
          field_id: item.field.id,
          value: item.desired,
        });
      }
      const { data, error } = await query.select('id, organization_id, field_id, value').single();
      if (error || data?.organization_id !== organizationId || data?.field_id !== item.field.id
        || data?.value !== item.desired) {
        fail(`Could not write ${item.field.name} for "${plan.row.name}": ${error?.message || 'unexpected response'}.`);
      }
      result.customWritten += 1;
    }
  }
}

async function verify(supabase, sourceRows) {
  const tenant = await auditTenant(supabase);
  const fields = await auditFields(supabase, sourceRows);
  const organizations = await fetchAllTenantOrganizations(supabase);
  const organizationMap = buildOrganizationMap(organizations, sourceRows);
  const matched = sourceRows.map((row) => organizationMap.get(normName(row.name)));
  const missing = sourceRows.filter((_, index) => !matched[index]);
  if (missing.length) fail(`Verification missing organizations: ${missing.map((row) => row.name).join(', ')}.`);
  const values = await loadValues(supabase, matched.map((org) => org.id), fields.map((field) => field.id));
  const errors = [];
  sourceRows.forEach((row, index) => {
    const organization = matched[index];
    if (organization.tenant_id !== BNMS_TENANT_ID) errors.push(`${row.name}: organization outside BNMS`);
    if (row.website && organization.website_url !== row.website) errors.push(`${row.name}: incorrect website`);
    fields.forEach((field) => {
      const desired = row[field.key];
      if (desired && values.get(prefKey(organization.id, field.id))?.value !== desired) {
        errors.push(`${row.name}: incorrect ${field.name}`);
      }
    });
  });
  for (const field of fields.filter((item) => item.type === 'dropdown')) {
    const supported = new Set(optionValues(field.options).map(normName));
    field.desiredOptions.forEach((value) => {
      if (!supported.has(normName(value))) errors.push(`${field.name}: unsupported option "${value}"`);
    });
  }
  if (errors.length) fail(`Verification failed:\n  ${errors.join('\n  ')}`);
  console.log(`\n=== Verification passed ===`);
  console.log(`  Tenant:                    ${tenant.name}`);
  console.log(`  Source rows matched once:  ${matched.length}/${sourceRows.length}`);
  console.log('  Duplicate normalized names: 0');
  console.log('  Incorrect mapped values:     0');
  console.log('  Unresolved field mappings:   0');
  console.log('  Unsupported dropdown values: 0');
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const sourceRows = readSource();
  const supabase = supabaseClient();
  console.log('\n=== Import BNMS student organisations ===');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Source: ${SOURCE_FILE}`);
  console.log(`Validated ${sourceRows.length} rows with known text corrections applied.`);

  const tenant = await auditTenant(supabase);
  const fields = await auditFields(supabase, sourceRows);
  const organizations = await fetchAllTenantOrganizations(supabase);
  const organizationMap = buildOrganizationMap(organizations, sourceRows);
  const existingIds = sourceRows.map((row) => organizationMap.get(normName(row.name))?.id).filter(Boolean);
  const values = await loadValues(supabase, existingIds, fields.map((field) => field.id));
  const { plans } = planImport(sourceRows, organizations, fields, values);
  printPlan(sourceRows, tenant, fields, plans);

  if (!apply) {
    console.log('\nNo writes performed. Re-run with --apply after reviewing this plan.\n');
    return;
  }

  const result = {
    organizationsCreated: 0,
    websitesWritten: 0,
    websitesUnchanged: 0,
    blankWebsites: 0,
    customWritten: 0,
    customUnchanged: 0,
  };
  // Options are committed before organization writes so no imported dropdown
  // value is ever unsupported.
  await applyOptions(supabase, fields);
  await applyOrganizations(supabase, plans, organizationMap, result);
  await applyCustomValues(supabase, plans, result);
  console.log('\n=== Apply summary ===');
  Object.entries(result).forEach(([key, value]) => console.log(`  ${key}: ${value}`));
  await verify(supabase, sourceRows);
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});