#!/usr/bin/env node
/**
 * Strict, destination-only import of the 45 BNMS Organisations CSV.
 *
 * Usage:
 *   node scripts/import-bnms-organisations-csv.mjs
 *   node scripts/import-bnms-organisations-csv.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTRIES, resolveCountryToIso2 } from '../shared/countries.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = path.join(ROOT, 'attached_assets', 'Organisations_to_import_02.09.26_v3_to_import_1788448225012.csv');
const DRY_RUN_REPORT_FILE = path.join(ROOT, 'reports', 'bnms-organisations-csv-import-dry-run.json');
const APPLY_REPORT_FILE = path.join(ROOT, 'reports', 'bnms-organisations-csv-import.json');
const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const EXPECTED_ROWS = 45;
const HEADERS = ['Organisation name', 'Type', 'Country', 'Town / City', 'BNMS Region'];
const EXPECTED_DISTINCT = { type: 4, country: 22, region: 7 };
const FIELD_SPECS = [
  { header: 'Type', key: 'type', names: ['organisation_type'], canonicalName: 'organisation_type',
    label: 'Type', fieldType: 'dropdown' },
  { header: 'Country', key: 'country', names: ['country', 'org_country'], canonicalName: 'country',
    label: 'Country', fieldType: 'country' },
  { header: 'Town / City', key: 'townCity', names: ['town_city', 'org_town_city'], canonicalName: 'town_city',
    labels: ['Town/city', 'Town / city', 'Town / City'], fieldType: 'text' },
  { header: 'BNMS Region', key: 'region', names: ['region'], canonicalName: 'region',
    label: 'Region', fieldType: 'dropdown' },
];
const VALUE_ALIASES = {
  organisation_type: {},
  country: {
    'South Korea': 'Korea, Republic of',
    'United States': 'United States of America',
  },
  region: {
    'Yorkshire & the Humber': 'Yorkshire and the Humber',
  },
};

function fail(message) { throw new Error(message); }
function canonicalKey(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');
}
function parseArgs(args) {
  const unknown = args.filter((arg) => !['--apply', '--dry-run', '--help', '-h'].includes(arg));
  if (unknown.length) fail(`Unknown argument "${unknown[0]}".`);
  if (args.includes('--apply') && args.includes('--dry-run')) fail('--apply and --dry-run are mutually exclusive.');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/import-bnms-organisations-csv.mjs [--dry-run | --apply]');
    process.exit(0);
  }
  return { apply: args.includes('--apply') };
}
function client() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; source and bare Supabase credentials are forbidden.');
  }
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
}
function readSource() {
  const text = fs.readFileSync(SOURCE_FILE, 'utf8');
  if (text.includes('\uFFFD')) fail('Source decoding produced an unrecoverable Unicode replacement character.');
  const grid = parse(text, { bom: true, columns: false, skip_empty_lines: true, relax_column_count: false });
  const headers = (grid.shift() || []).map(String);
  if (headers.length !== HEADERS.length || headers.some((header, index) => header !== HEADERS[index])) {
    fail(`Headers must be exactly: ${HEADERS.join(' | ')}. Found: ${headers.join(' | ') || '(none)'}.`);
  }
  if (grid.length !== EXPECTED_ROWS) fail(`CSV must contain exactly ${EXPECTED_ROWS} populated rows; found ${grid.length}.`);
  const seen = new Map();
  const rows = grid.map((raw, index) => {
    const sourceRow = index + 2;
    if (raw.length !== HEADERS.length) fail(`Source row ${sourceRow} has ${raw.length} columns; expected ${HEADERS.length}.`);
    const values = raw.map((value) => String(value ?? '').trim());
    if (values.every((value) => !value)) fail(`Source row ${sourceRow} is blank.`);
    if (values.some((value) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value))) {
      fail(`Source row ${sourceRow} contains a control character.`);
    }
    const [name, type, country, townCity, region] = values;
    if (!name) fail(`Source row ${sourceRow} has a blank Organisation name.`);
    const normalized = canonicalKey(name);
    if (seen.has(normalized)) fail(`Duplicate normalized source name "${name}" at rows ${seen.get(normalized)} and ${sourceRow}.`);
    seen.set(normalized, sourceRow);
    return { sourceRow, name, type, country, townCity, region };
  });
  for (const [key, expected] of Object.entries(EXPECTED_DISTINCT)) {
    const actual = new Set(rows.map((row) => row[key]).filter(Boolean)).size;
    if (actual !== expected) fail(`Expected ${expected} distinct ${key} values; found ${actual}.`);
  }
  return rows;
}
async function auditTenant(db) {
  const { data, error } = await db.from('tenant').select('id, name').eq('id', TENANT_ID).single();
  if (error || data?.id !== TENANT_ID) fail(`Pinned BNMS tenant could not be resolved: ${error?.message || 'not found'}.`);
  if (!/british nuclear medicine society|bnms/i.test(data.name || '')) fail(`Pinned tenant "${data.name}" is not BNMS.`);
  return data;
}
function optionValues(raw, name) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { fail(`Field ${name} has invalid JSON options.`); }
  }
  if (!Array.isArray(raw)) fail(`Field ${name} options must be an array.`);
  return raw.map((option) => String(option && typeof option === 'object'
    ? option.value ?? option.label ?? '' : option).trim()).filter(Boolean);
}
async function auditFields(db, rows) {
  const allNames = FIELD_SPECS.flatMap((spec) => spec.names);
  const { data, error } = await db.from('preference_field')
    .select('id, tenant_id, name, label, field_type, options, is_active, entity_scope')
    .eq('tenant_id', TENANT_ID).eq('entity_scope', 'organization')
    .in('name', allNames).order('id', { ascending: true });
  if (error) fail(`Could not load BNMS Organisation fields: ${error.message}`);
  return FIELD_SPECS.map((spec) => {
    const matches = (data || []).filter((field) => spec.names.includes(field.name));
    if (matches.length !== 1) fail(`Expected exactly one established BNMS Organisation field for "${spec.canonicalName}"; found ${matches.length}.`);
    const field = matches[0];
    const labels = spec.labels || [spec.label];
    if (field.tenant_id !== TENANT_ID || field.entity_scope !== 'organization' || !field.is_active ||
        !labels.includes(field.label) || field.field_type !== spec.fieldType) {
      fail(`Field ${field.name} must be active, BNMS organization-scoped, labelled "${labels.join('" or "')}", and type "${spec.fieldType}".`);
    }
    if (spec.fieldType === 'country') {
      const countryMap = new Map(COUNTRIES.map((country) => [country.code, country.name]));
      const aliases = new Map(Object.entries(VALUE_ALIASES.country).map(([source, destination]) => [canonicalKey(source), destination]));
      const unsupported = [...new Set(rows.map((row) => row.country).filter(Boolean))]
        .filter((value) => !resolveCountryToIso2(value) || !countryMap.has(resolveCountryToIso2(value)));
      if (unsupported.length) fail(`Unsupported country value(s): ${unsupported.join(', ')}.`);
      return { ...spec, ...field, countryMap, aliases };
    }
    if (spec.fieldType !== 'dropdown') return { ...spec, ...field };
    const options = optionValues(field.options, field.name);
    const optionMap = new Map();
    for (const option of options) {
      const key = canonicalKey(option);
      if (optionMap.has(key) && optionMap.get(key) !== option) fail(`Field ${field.name} has ambiguous options "${optionMap.get(key)}" and "${option}".`);
      optionMap.set(key, option);
    }
    const aliases = new Map(Object.entries(VALUE_ALIASES[spec.canonicalName] || {})
      .map(([source, destination]) => [canonicalKey(source), destination]));
    for (const destination of aliases.values()) {
      if (!optionMap.has(canonicalKey(destination))) fail(`Alias for ${field.name} targets missing option "${destination}".`);
    }
    const unsupported = [...new Set(rows.map((row) => row[spec.key]).filter(Boolean))]
      .filter((value) => !optionMap.has(canonicalKey(value)) && !aliases.has(canonicalKey(value)));
    if (unsupported.length) fail(`Unsupported ${field.name} value(s): ${unsupported.join(', ')}.`);
    return { ...spec, ...field, optionMap, aliases };
  });
}
function desiredValue(row, field) {
  const raw = row[field.key];
  if (!raw) return '';
  if (field.countryMap) return field.countryMap.get(resolveCountryToIso2(raw));
  if (!field.optionMap) return raw;
  const alias = field.aliases.get(canonicalKey(raw));
  return field.optionMap.get(canonicalKey(alias || raw));
}
async function loadOrganizations(db) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await db.from('organization').select('id, tenant_id, name')
      .eq('tenant_id', TENANT_ID).order('id', { ascending: true }).range(from, from + 499);
    if (error) fail(`Could not page BNMS Organisations: ${error.message}`);
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}
function matchOrganizations(sourceRows, organizations) {
  const byName = new Map();
  for (const organization of organizations) {
    if (organization.tenant_id !== TENANT_ID) fail(`Cross-tenant Organisation ${organization.id} returned by BNMS query.`);
    const key = canonicalKey(organization.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(organization);
  }
  return sourceRows.map((row) => {
    const matches = byName.get(canonicalKey(row.name)) || [];
    if (matches.length > 1) fail(`Source row ${row.sourceRow} ambiguously matches ${matches.length} BNMS Organisations named "${row.name}".`);
    return { row, organization: matches[0] || null };
  });
}
function prefKey(organizationId, fieldId) { return `${organizationId}::${fieldId}`; }
async function loadValues(db, ids, fieldIds) {
  const values = new Map();
  if (!ids.length) return values;
  for (let index = 0; index < ids.length; index += 100) {
    for (let from = 0; ; from += 500) {
      const { data, error } = await db.from('organization_preference_value')
        .select('id, organization_id, field_id, value').in('organization_id', ids.slice(index, index + 100))
        .in('field_id', fieldIds).order('id', { ascending: true }).range(from, from + 499);
      if (error) fail(`Could not load Organisation values: ${error.message}`);
      for (const value of data || []) {
        const key = prefKey(value.organization_id, value.field_id);
        if (values.has(key)) fail(`Duplicate stored custom values for ${key}.`);
        values.set(key, value);
      }
      if ((data || []).length < 500) break;
    }
  }
  return values;
}
function makePlan(matches, fields, values) {
  const totals = { organizationsCreated: 0, organizationsUpdated: 0, organizationsUnchanged: 0,
    customCreated: 0, customUpdated: 0, customUnchanged: 0, blankValuesSkipped: 0 };
  const items = matches.map(({ row, organization }) => {
    const custom = fields.map((field) => {
      const existing = organization ? values.get(prefKey(organization.id, field.id)) || null : null;
      const desired = desiredValue(row, field);
      const action = !desired ? 'blank' : existing?.value === desired ? 'unchanged' : existing ? 'update' : 'create';
      totals[{ blank: 'blankValuesSkipped', unchanged: 'customUnchanged', update: 'customUpdated', create: 'customCreated' }[action]] += 1;
      return { field, existing, current: String(existing?.value ?? ''), desired, action };
    });
    const action = !organization ? 'create'
      : custom.some((value) => ['create', 'update'].includes(value.action)) ? 'update' : 'unchanged';
    totals[{ create: 'organizationsCreated', update: 'organizationsUpdated', unchanged: 'organizationsUnchanged' }[action]] += 1;
    return { row, organization, action, custom };
  });
  return { items, totals };
}
async function loadAndPlan(db, rows) {
  const tenant = await auditTenant(db);
  const fields = await auditFields(db, rows);
  const organizations = await loadOrganizations(db);
  const matches = matchOrganizations(rows, organizations);
  const ids = matches.flatMap((item) => item.organization?.id ? [item.organization.id] : []);
  const values = await loadValues(db, ids, fields.map((field) => field.id));
  return { tenant, fields, plan: makePlan(matches, fields, values) };
}
async function applyPlan(db, plan, fields) {
  const result = { organizationsCreated: 0, organizationsUpdated: 0, organizationsUnchanged: 0,
    customCreated: 0, customUpdated: 0 };
  for (const item of plan.items) {
    let organization = item.organization;
    if (!organization) {
      const { data, error } = await db.from('organization').insert({ tenant_id: TENANT_ID, name: item.row.name })
        .select('id, tenant_id, name').single();
      if (error || !data?.id || data.tenant_id !== TENANT_ID || data.name !== item.row.name) {
        fail(`Could not create Organisation from row ${item.row.sourceRow}: ${error?.message || 'unexpected response'}.`);
      }
      organization = data;
      item.custom = fields.map((field) => ({ field, existing: null, desired: desiredValue(item.row, field),
        action: desiredValue(item.row, field) ? 'create' : 'blank' }));
      result.organizationsCreated += 1;
    } else {
      result[item.action === 'update' ? 'organizationsUpdated' : 'organizationsUnchanged'] += 1;
    }
    for (const value of item.custom.filter((entry) => ['create', 'update'].includes(entry.action))) {
      const query = value.action === 'update'
        ? db.from('organization_preference_value').update({ value: value.desired, updated_at: new Date().toISOString() })
          .eq('id', value.existing.id).eq('organization_id', organization.id).eq('field_id', value.field.id)
        : db.from('organization_preference_value').insert({
          organization_id: organization.id, field_id: value.field.id, value: value.desired,
        });
      const { data, error } = await query.select('id, organization_id, field_id, value').single();
      if (error || data?.organization_id !== organization.id || data?.field_id !== value.field.id || data?.value !== value.desired) {
        fail(`Could not ${value.action} ${value.field.canonicalName} for "${item.row.name}": ${error?.message || 'unexpected response'}.`);
      }
      result[value.action === 'create' ? 'customCreated' : 'customUpdated'] += 1;
    }
  }
  return result;
}
function writeReport(mode, tenant, fields, plan, applyResult = null) {
  const reportFile = mode === 'apply' ? APPLY_REPORT_FILE : DRY_RUN_REPORT_FILE;
  const payload = {
    generatedAt: new Date().toISOString(), mode, tenant, sourceFile: path.relative(ROOT, SOURCE_FILE),
    sourceEncoding: 'UTF-8', exactHeaders: HEADERS, sourceRows: plan.items.length,
    distinctSourceValues: EXPECTED_DISTINCT,
    mapping: [{ source: 'Organisation name', destination: 'organization.name', type: 'core' },
      ...fields.map((field) => ({ source: field.header, destination: field.canonicalName,
        liveFieldName: field.name, fieldId: field.id, type: field.fieldType }))],
    aliases: fields.flatMap((field) => [...(field.aliases || new Map())]
      .map(([source, destination]) => ({ field: field.canonicalName, source, destination }))),
    blankPolicy: 'Blank source values do not delete or overwrite existing destination values.',
    totals: plan.totals,
    rows: plan.items.map((item) => ({ sourceRow: item.row.sourceRow, name: item.row.name,
      organizationId: item.organization?.id || null, action: item.action,
      custom: item.custom.map((value) => ({ field: value.field.canonicalName, liveFieldName: value.field.name,
        current: value.current, desired: value.desired, action: value.action })) })),
    applyResult, verification: mode === 'apply'
      ? { matchedExactlyOnce: plan.items.length, missing: 0, ambiguous: 0, remainingWrites: 0, crossTenantWrites: 0 } : null,
  };
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(payload, null, 2)}\n`);
  return { ...payload, reportFile };
}
function printSummary(payload) {
  console.log(`Tenant: ${payload.tenant.name} (${payload.tenant.id})`);
  console.log(`Source contract: ${payload.sourceRows}/${EXPECTED_ROWS} rows; ${payload.exactHeaders.length}/${HEADERS.length} exact headers.`);
  console.log(`Distinct values: ${payload.distinctSourceValues.type} Types; ${payload.distinctSourceValues.country} Countries; ${payload.distinctSourceValues.region} Regions.`);
  console.log('\n--- Exact mapping ---');
  payload.mapping.forEach((item) => console.log(`  ${item.source} -> ${item.destination}${item.liveFieldName && item.liveFieldName !== item.destination ? ` (live: ${item.liveFieldName})` : ''} [${item.type}]`));
  payload.aliases.forEach((alias) => console.log(`  ${alias.field} alias: ${alias.source} -> ${alias.destination}`));
  console.log('\n--- Change totals ---');
  Object.entries(payload.totals).forEach(([key, value]) => console.log(`  ${key}: ${value}`));
  console.log(`  report: ${path.relative(ROOT, payload.reportFile)}`);
}
async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  console.log(`\n=== BNMS Organisations CSV: ${apply ? 'APPLY' : 'DRY RUN'} ===`);
  const rows = readSource();
  const db = client();
  const initial = await loadAndPlan(db, rows);
  const dryReport = writeReport('dry-run', initial.tenant, initial.fields, initial.plan);
  printSummary(dryReport);
  if (!apply) {
    console.log('\nNo writes performed. Re-run with --apply after reviewing this report.\n');
    return;
  }
  const applyResult = await applyPlan(db, initial.plan, initial.fields);
  const verified = await loadAndPlan(db, rows);
  const remaining = verified.plan.totals.organizationsCreated + verified.plan.totals.organizationsUpdated +
    verified.plan.totals.customCreated + verified.plan.totals.customUpdated;
  if (remaining) fail(`Post-import idempotency verification failed with ${remaining} remaining write(s).`);
  const finalReport = writeReport('apply', verified.tenant, verified.fields, verified.plan, applyResult);
  console.log('\n--- Apply result ---');
  Object.entries(applyResult).forEach(([key, value]) => console.log(`  ${key}: ${value}`));
  console.log(`Verified ${verified.plan.items.length}/${EXPECTED_ROWS} source Organisations exactly once in BNMS; 0 remaining changes; 0 cross-tenant writes.`);
  console.log(`Detailed report: ${path.relative(ROOT, APPLY_REPORT_FILE)}\n`);
  return finalReport;
}
main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});