#!/usr/bin/env node
/**
 * Strict, dry-run-first import of the 101 additional BNMS Organisations.
 *
 * Usage:
 *   node scripts/import-additional-bnms-organisations.mjs
 *   node scripts/import-additional-bnms-organisations.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTRIES, resolveCountryToIso2 } from '../shared/countries.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = path.join(ROOT, 'attached_assets', 'Additional_groups_and_organisations_to_import_01.09.26v2_1788239815508.csv');
const REPORT_FILE = path.join(ROOT, 'reports', 'bnms-additional-organisations-import.json');
const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const EXPECTED_ROWS = 101;
const HEADERS = [
  'Record level', 'Proposed CRM name', 'Type', 'Invoicing Address', 'Phone',
  'Site code', 'Parent code', 'Region', 'Town/city', 'Postcode', 'Country', 'Website',
];
const CORE_SPECS = [
  { header: 'Proposed CRM name', key: 'name', column: 'name' },
  { header: 'Invoicing Address', key: 'invoicingAddress', column: 'invoicing_address' },
  { header: 'Phone', key: 'phone', column: 'phone' },
  { header: 'Website', key: 'website', column: 'website_url' },
];
const CUSTOM_SPECS = [
  { header: 'Type', key: 'type', name: 'organisation_type', label: 'Type', fieldType: 'dropdown',
    aliases: {
      'Public healthcare organisation': 'Public hospital or clinical site',
      'University / education': 'Education or training provider',
      'Private hospital or clinical site': 'Private hospital or imaging centre',
      'Private healthcare/imaging group': 'Private hospital or imaging centre',
      'Professional or membership organisation': 'Research or charitable organisation',
    } },
  { header: 'Site code', key: 'siteCode', name: 'site_code', label: 'Site code', fieldType: 'text' },
  { header: 'Parent code', key: 'parentCode', name: 'parent_code', label: 'Parent code', fieldType: 'text' },
  { header: 'Region', key: 'region', name: 'region', label: 'Region', fieldType: 'dropdown',
    aliases: {
      'Yorkshire & the Humber': 'Yorkshire and the Humber',
      'East of England (East Anglia)': 'East of England',
      'London North Thames': 'North Thames',
      'London South Thames': 'South Thames',
      'Wales North': 'North Wales',
    } },
  { header: 'Town/city', key: 'townCity', name: 'town_city', label: 'Town/city', fieldType: 'text' },
  { header: 'Postcode', key: 'postcode', name: 'postcode', label: 'Postcode', fieldType: 'text' },
  { header: 'Country', key: 'country', name: 'country', label: 'Country', fieldType: 'country' },
];

function fail(message) { throw new Error(message); }
function canonicalKey(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');
}
function parseArgs(args) {
  const unknown = args.filter((arg) => !['--apply', '--dry-run', '--help', '-h'].includes(arg));
  if (unknown.length) fail(`Unknown argument "${unknown[0]}".`);
  if (args.includes('--apply') && args.includes('--dry-run')) fail('--apply and --dry-run are mutually exclusive.');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/import-additional-bnms-organisations.mjs [--dry-run | --apply]');
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
function decodeMixed(bytes) {
  const parts = [];
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    if (first < 0x80) { parts.push(String.fromCharCode(first)); index += 1; continue; }
    const length = first >= 0xC2 && first <= 0xDF ? 2
      : first >= 0xE0 && first <= 0xEF ? 3 : first >= 0xF0 && first <= 0xF4 ? 4 : 0;
    const sequence = length ? bytes.subarray(index, index + length) : null;
    const continuationValid = sequence?.length === length &&
      [...sequence.subarray(1)].every((byte) => byte >= 0x80 && byte <= 0xBF);
    const invalidThree = length === 3 &&
      ((first === 0xE0 && sequence[1] < 0xA0) || (first === 0xED && sequence[1] > 0x9F));
    const invalidFour = length === 4 &&
      ((first === 0xF0 && sequence[1] < 0x90) || (first === 0xF4 && sequence[1] > 0x8F));
    if (continuationValid && !invalidThree && !invalidFour) {
      parts.push(sequence.toString('utf8')); index += length;
    } else {
      parts.push(iconv.decode(bytes.subarray(index, index + 1), 'windows-1252')); index += 1;
    }
  }
  return parts.join('');
}
function validateWebsite(value, sourceRow) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) fail('invalid');
  } catch {
    fail(`Source row ${sourceRow} has an invalid Website URL: "${value}".`);
  }
}
function readSource() {
  const decoded = decodeMixed(fs.readFileSync(SOURCE_FILE));
  if (decoded.includes('\uFFFD')) fail('Source decoding produced an unrecoverable Unicode replacement character.');
  if (/[ÃÂ][\u0080-\u00FF]|â(?:€|€™|œ|�)/.test(decoded)) fail('Source decoding produced a known mojibake sequence.');
  const grid = parse(decoded, { bom: true, columns: false, skip_empty_lines: true, relax_column_count: false });
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
    const [recordLevel, name, type, invoicingAddress, phone, siteCode, parentCode, region, townCity, postcode, country, website] = values;
    if (recordLevel !== 'Organisation') fail(`Source row ${sourceRow} Record level must be "Organisation"; found "${recordLevel}".`);
    if (!name) fail(`Source row ${sourceRow} has a blank Proposed CRM name.`);
    const normalized = canonicalKey(name);
    if (seen.has(normalized)) fail(`Duplicate normalized source name "${name}" at rows ${seen.get(normalized)} and ${sourceRow}.`);
    seen.set(normalized, sourceRow);
    validateWebsite(website, sourceRow);
    if (values.some((value) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value))) {
      fail(`Source row ${sourceRow} contains a control character.`);
    }
    return { sourceRow, recordLevel, name, type, invoicingAddress, phone, siteCode, parentCode,
      region, townCity, postcode, country, website };
  });
  const turkiye = rows.filter((row) => row.country === 'Türkiye');
  if (turkiye.length !== 2) fail(`Mixed-encoding assertion failed: expected 2 Türkiye rows; found ${turkiye.length}.`);
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
  return raw.map((option) => String(option && typeof option === 'object' ? option.value ?? option.label ?? '' : option).trim()).filter(Boolean);
}
async function auditFields(db, rows) {
  const { data, error } = await db.from('preference_field')
    .select('id, tenant_id, name, label, field_type, options, is_active, entity_scope')
    .eq('tenant_id', TENANT_ID).eq('entity_scope', 'organization')
    .in('name', CUSTOM_SPECS.map((spec) => spec.name)).order('id', { ascending: true });
  if (error) fail(`Could not load BNMS Organisation fields: ${error.message}`);
  return CUSTOM_SPECS.map((spec) => {
    const matches = (data || []).filter((field) => field.name === spec.name);
    if (matches.length !== 1) fail(`Expected exactly one BNMS Organisation field "${spec.name}"; found ${matches.length}.`);
    const field = matches[0];
    if (field.tenant_id !== TENANT_ID || field.entity_scope !== 'organization' || !field.is_active ||
        field.label !== spec.label || field.field_type !== spec.fieldType) {
      fail(`Field ${spec.name} must be active, BNMS organization-scoped, labelled "${spec.label}", and type "${spec.fieldType}".`);
    }
    if (!['dropdown', 'country'].includes(spec.fieldType)) return { ...spec, id: field.id };
    if (spec.fieldType === 'country') {
      const countryMap = new Map(COUNTRIES.map((country) => [country.code, country.name]));
      const unsupported = [...new Set(rows.map((row) => row[spec.key]).filter(Boolean))]
        .filter((value) => !resolveCountryToIso2(value) || !countryMap.has(resolveCountryToIso2(value)));
      if (unsupported.length) fail(`Unsupported ${spec.name} value(s): ${unsupported.join(', ')}.`);
      return { ...spec, id: field.id, countryMap };
    }
    const options = optionValues(field.options, spec.name);
    const optionMap = new Map();
    for (const option of options) {
      const key = canonicalKey(option);
      if (optionMap.has(key) && optionMap.get(key) !== option) fail(`Field ${spec.name} has ambiguous options "${optionMap.get(key)}" and "${option}".`);
      optionMap.set(key, option);
    }
    const aliasEntries = Object.entries(spec.aliases || {});
    const aliases = new Map(aliasEntries.map(([source, destination]) => [canonicalKey(source), destination]));
    for (const destination of aliases.values()) {
      if (!optionMap.has(canonicalKey(destination))) fail(`Alias for ${spec.name} targets missing option "${destination}".`);
    }
    const unsupported = [...new Set(rows.map((row) => row[spec.key]).filter(Boolean))]
      .filter((value) => !optionMap.has(canonicalKey(value)) && !aliases.has(canonicalKey(value)));
    if (unsupported.length) fail(`Unsupported ${spec.name} value(s): ${unsupported.join(', ')}.`);
    return { ...spec, id: field.id, optionMap, aliases, aliasEntries };
  });
}
function desiredValue(row, field) {
  const raw = row[field.key];
  if (!raw) return raw;
  if (field.countryMap) return field.countryMap.get(resolveCountryToIso2(raw));
  if (!field.optionMap) return raw;
  const alias = field.aliases?.get(canonicalKey(raw));
  return field.optionMap.get(canonicalKey(alias || raw));
}
async function loadOrganizations(db) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await db.from('organization')
      .select('id, tenant_id, name, invoicing_address, phone, website_url')
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
    coreChanges: 0, customCreated: 0, customUpdated: 0, customCleared: 0, customUnchanged: 0 };
  const items = matches.map(({ row, organization }) => {
    if (!organization) {
      totals.organizationsCreated += 1;
      return { row, organization: null, action: 'create', core: [], custom: [] };
    }
    const core = CORE_SPECS.map((spec) => {
      const current = String(organization[spec.column] ?? '');
      const desired = row[spec.key];
      const action = current === desired ? 'unchanged' : 'update';
      if (action === 'update') totals.coreChanges += 1;
      return { spec, current, desired, action };
    });
    const custom = fields.map((field) => {
      const existing = values.get(prefKey(organization.id, field.id)) || null;
      const current = String(existing?.value ?? '');
      const desired = desiredValue(row, field);
      const action = current === desired ? 'unchanged' : desired ? (existing ? 'update' : 'create') : 'clear';
      const totalKey = { unchanged: 'customUnchanged', create: 'customCreated', update: 'customUpdated', clear: 'customCleared' }[action];
      totals[totalKey] += 1;
      return { field, existing, current, desired, action };
    });
    const changed = core.some((item) => item.action !== 'unchanged') || custom.some((item) => item.action !== 'unchanged');
    totals[changed ? 'organizationsUpdated' : 'organizationsUnchanged'] += 1;
    return { row, organization, action: changed ? 'update' : 'unchanged', core, custom };
  });
  return { items, totals };
}
async function applyPlan(db, plan, fields) {
  const result = { organizationsCreated: 0, organizationsUpdated: 0, organizationsUnchanged: 0,
    coreChanges: 0, customCreated: 0, customUpdated: 0, customCleared: 0 };
  for (const item of plan.items) {
    let organization = item.organization;
    if (!organization) {
      const payload = { tenant_id: TENANT_ID, name: item.row.name, invoicing_address: item.row.invoicingAddress || null,
        phone: item.row.phone || null, website_url: item.row.website || null };
      const { data, error } = await db.from('organization').insert(payload)
        .select('id, tenant_id, name, invoicing_address, phone, website_url').single();
      if (error || !data?.id || data.tenant_id !== TENANT_ID || data.name !== item.row.name) {
        fail(`Could not create Organisation from row ${item.row.sourceRow}: ${error?.message || 'unexpected response'}.`);
      }
      organization = data;
      result.organizationsCreated += 1;
      item.custom = fields.map((field) => ({ field, existing: null, desired: desiredValue(item.row, field),
        action: desiredValue(item.row, field) ? 'create' : 'unchanged' }));
    } else {
      const changedCore = item.core.filter((core) => core.action !== 'unchanged');
      if (changedCore.length) {
        const payload = Object.fromEntries(changedCore.map((core) => [core.spec.column, core.desired || null]));
        const { data, error } = await db.from('organization').update(payload)
          .eq('tenant_id', TENANT_ID).eq('id', organization.id).select('id, tenant_id').single();
        if (error || data?.id !== organization.id || data?.tenant_id !== TENANT_ID) {
          fail(`Could not update Organisation ${organization.id}: ${error?.message || 'unexpected response'}.`);
        }
        result.coreChanges += changedCore.length;
      }
      result[item.action === 'update' ? 'organizationsUpdated' : 'organizationsUnchanged'] += 1;
    }
    for (const value of item.custom.filter((entry) => entry.action !== 'unchanged')) {
      let query;
      if (value.action === 'clear') {
        query = db.from('organization_preference_value').delete({ count: 'exact' })
          .eq('id', value.existing.id).eq('organization_id', organization.id).eq('field_id', value.field.id);
        const { error, count } = await query;
        if (error || count !== 1) fail(`Could not clear ${value.field.name} for ${organization.id}: ${error?.message || `deleted ${count}`}.`);
      } else if (value.action === 'update') {
        query = db.from('organization_preference_value').update({ value: value.desired, updated_at: new Date().toISOString() })
          .eq('id', value.existing.id).eq('organization_id', organization.id).eq('field_id', value.field.id);
        const { data, error } = await query.select('id, value').single();
        if (error || data?.value !== value.desired) fail(`Could not update ${value.field.name} for ${organization.id}: ${error?.message || 'unexpected response'}.`);
      } else {
        query = db.from('organization_preference_value').insert({
          organization_id: organization.id, field_id: value.field.id, value: value.desired,
        });
        const { data, error } = await query.select('id, organization_id, field_id, value').single();
        if (error || data?.organization_id !== organization.id || data?.field_id !== value.field.id || data?.value !== value.desired) {
          fail(`Could not create ${value.field.name} for ${organization.id}: ${error?.message || 'unexpected response'}.`);
        }
      }
      const resultKey = { create: 'customCreated', update: 'customUpdated', clear: 'customCleared' }[value.action];
      result[resultKey] += 1;
    }
  }
  return result;
}
async function loadAndPlan(db, rows) {
  const tenant = await auditTenant(db);
  const fields = await auditFields(db, rows);
  const organizations = await loadOrganizations(db);
  const matches = matchOrganizations(rows, organizations);
  const ids = matches.flatMap((item) => item.organization?.id ? [item.organization.id] : []);
  const values = await loadValues(db, ids, fields.map((field) => field.id));
  return { tenant, fields, plan: makePlan(matches, fields, values), organizationCount: organizations.length };
}
function report(mode, tenant, fields, plan, applyResult = null) {
  const payload = {
    generatedAt: new Date().toISOString(), mode, tenant, sourceFile: path.relative(ROOT, SOURCE_FILE),
    sourceEncoding: 'mixed UTF-8/Windows-1252', exactHeaders: HEADERS, sourceRows: plan.items.length,
    recordLevels: { Organisation: plan.items.length },
    mapping: [
      { source: 'Record level', destination: null, type: 'validated-and-ignored' },
      ...CORE_SPECS.map((spec) => ({ source: spec.header, destination: `organization.${spec.column}`, type: 'core' })),
      ...fields.map((field) => ({ source: field.header, destination: field.name, fieldId: field.id, type: field.fieldType })),
    ],
    aliases: fields.flatMap((field) => (field.aliasEntries || [])
      .map(([source, destination]) => ({ field: field.name, source, destination }))),
    blankPolicy: 'Blank source values persist as blank/null; existing source-controlled values are cleared.',
    totals: plan.totals,
    rows: plan.items.map((item) => ({ sourceRow: item.row.sourceRow, name: item.row.name,
      organizationId: item.organization?.id || null, action: item.action,
      core: item.core.map((value) => ({ field: value.spec.column, current: value.current, desired: value.desired, action: value.action })),
      custom: item.custom.map((value) => ({ field: value.field.name, current: value.current, desired: value.desired, action: value.action })) })),
    applyResult,
  };
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}
function printSummary(payload) {
  console.log(`Tenant: ${payload.tenant.name} (${payload.tenant.id})`);
  console.log(`Source contract: ${payload.sourceRows}/${EXPECTED_ROWS} rows; ${payload.exactHeaders.length}/${HEADERS.length} exact headers; all Organisation.`);
  console.log('Encoding: mixed UTF-8/Windows-1252 decoded without loss; Türkiye fixture passed.');
  console.log('\n--- Exact mapping ---');
  payload.mapping.forEach((item) => console.log(`  ${item.source} -> ${item.destination || '(ignored)'} [${item.type}]`));
  payload.aliases.forEach((alias) => console.log(`  ${alias.field} alias: ${alias.source} -> ${alias.destination}`));
  console.log('\n--- Change totals ---');
  Object.entries(payload.totals).forEach(([key, value]) => console.log(`  ${key}: ${value}`));
  console.log(`  report: ${path.relative(ROOT, REPORT_FILE)}`);
}
async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  console.log(`\n=== Additional BNMS Organisations: ${apply ? 'APPLY' : 'DRY RUN'} ===`);
  const rows = readSource();
  const db = client();
  const initial = await loadAndPlan(db, rows);
  const dryReport = report('dry-run', initial.tenant, initial.fields, initial.plan);
  printSummary(dryReport);
  if (!apply) {
    console.log('\nNo writes performed. Re-run with --apply after reviewing this report.\n');
    return;
  }
  const applyResult = await applyPlan(db, initial.plan, initial.fields);
  const verified = await loadAndPlan(db, rows);
  const remaining = verified.plan.totals.organizationsCreated + verified.plan.totals.organizationsUpdated +
    verified.plan.totals.coreChanges + verified.plan.totals.customCreated + verified.plan.totals.customUpdated +
    verified.plan.totals.customCleared;
  if (remaining) fail(`Post-import idempotency verification failed with ${remaining} remaining write(s).`);
  const finalReport = report('apply', verified.tenant, verified.fields, verified.plan, applyResult);
  console.log('\n--- Apply result ---');
  Object.entries(applyResult).forEach(([key, value]) => console.log(`  ${key}: ${value}`));
  console.log(`Verified ${verified.plan.items.length}/${EXPECTED_ROWS} source Organisations exactly once in BNMS; 0 remaining changes; 0 cross-tenant writes.`);
  console.log(`Detailed report: ${path.relative(ROOT, REPORT_FILE)}\n`);
}
main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});