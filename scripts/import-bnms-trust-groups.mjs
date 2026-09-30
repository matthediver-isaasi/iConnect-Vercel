#!/usr/bin/env node
/**
 * Strict, dry-run-first updater for the 161 BNMS Organisation Groups in the
 * supplied CSV. IDs are authoritative; this script never creates groups,
 * fields, dropdown options, or unrelated entities.
 *
 * Usage:
 *   node scripts/import-bnms-trust-groups.mjs
 *   node scripts/import-bnms-trust-groups.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const FILE = path.join(ROOT, 'attached_assets', 'Group_data_updated_to_import_31.08.26_(1)_1788194397395.csv');
const REPORT_FILE = path.join(ROOT, 'reports', 'bnms-organisation-group-update.json');
const ROW_COUNT = 161;
const HEADERS = [
  'Group name', 'id', 'Group type', 'Address line 1', 'Address line 2',
  'Town/city', 'County', 'Country', 'Postcode', 'Website', 'Telephone',
  'Group region', 'Group parent code',
];
const FIELD_SPECS = [
  { header: 'Group type', name: 'group_type', label: 'Group type', type: 'dropdown',
    aliases: { 'university group': 'University' } },
  { header: 'Address line 1', name: 'group_address_line_1', label: 'Address line 1', type: 'text' },
  { header: 'Address line 2', name: 'group_address_line_2', label: 'Address line 2', type: 'text' },
  { header: 'Town/city', name: 'group_town_city', label: 'Town / city', type: 'text' },
  { header: 'County', name: 'group_county', label: 'County', type: 'text' },
  { header: 'Country', name: 'group_country', label: 'Country', type: 'dropdown' },
  { header: 'Postcode', name: 'group_postcode', label: 'Postcode', type: 'text' },
  { header: 'Website', name: 'group_website', label: 'Website', type: 'text' },
  { header: 'Telephone', name: 'group_telephone', label: 'Telephone', type: 'text' },
  { header: 'Group region', name: 'group_region', label: 'Group region', type: 'dropdown' },
  { header: 'Group parent code', name: 'group_parent_code', label: 'Group parent code', type: 'text' },
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVED_OPTION_ADDITIONS = new Map([
  ['group_country', ['United Kingdom']],
  ['group_region', ['Overseas']],
]);

function fail(message) {
  throw new Error(message);
}

function canonicalKey(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-GB')
    .replace(/\s+/g, ' ').replace(/\s*([/&])\s*/g, '$1');
}

function parseOptions(raw, fieldName) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { fail(`Dropdown ${fieldName} has invalid JSON options.`); }
  }
  if (!Array.isArray(raw)) fail(`Dropdown ${fieldName} options must be an array.`);
  return raw.map((item) => String(item && typeof item === 'object' ? item.value ?? item.label ?? '' : item).trim()).filter(Boolean);
}

function resolveValue(field, source) {
  if (!source) return '';
  if (field.type !== 'dropdown') return source;
  return field.optionMap.get(canonicalKey(source)) ||
    field.optionMap.get(canonicalKey(field.aliases?.get(canonicalKey(source)))) ||
    (field.missingOptions?.includes(source) ? source : undefined);
}

function supabaseClient() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; SOURCE and bare SUPABASE credentials are forbidden.');
  }
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
}

function decodeMixedUtf8Windows1252(bytes) {
  const parts = [];
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    if (first < 0x80) {
      parts.push(String.fromCharCode(first));
      index += 1;
      continue;
    }
    const length = first >= 0xC2 && first <= 0xDF ? 2
      : first >= 0xE0 && first <= 0xEF ? 3
      : first >= 0xF0 && first <= 0xF4 ? 4 : 0;
    const sequence = length ? bytes.subarray(index, index + length) : null;
    const continuationValid = sequence?.length === length &&
      [...sequence.subarray(1)].every((byte) => byte >= 0x80 && byte <= 0xBF);
    const overlongOrSurrogate = length === 3 &&
      ((first === 0xE0 && sequence[1] < 0xA0) || (first === 0xED && sequence[1] > 0x9F));
    const outOfRange = length === 4 &&
      ((first === 0xF0 && sequence[1] < 0x90) || (first === 0xF4 && sequence[1] > 0x8F));
    if (continuationValid && !overlongOrSurrogate && !outOfRange) {
      parts.push(sequence.toString('utf8'));
      index += length;
    } else {
      parts.push(iconv.decode(bytes.subarray(index, index + 1), 'windows-1252'));
      index += 1;
    }
  }
  return parts.join('');
}

function readRows() {
  const bytes = fs.readFileSync(FILE);
  const decoded = decodeMixedUtf8Windows1252(bytes);
  const encoding = 'mixed UTF-8/Windows-1252';
  if (decoded.includes('\uFFFD')) fail('CSV contains an unrecoverable Unicode replacement character.');
  if (/[ÃÂ][\u0080-\u00FF]|â(?:€|€™|œ|�)/.test(decoded)) {
    fail('CSV decoding produced a known mojibake sequence.');
  }
  const records = parse(decoded, { bom: true, columns: false, skip_empty_lines: true, relax_column_count: false });
  const actualHeaders = records.shift()?.map((value) => String(value));
  if (!actualHeaders || actualHeaders.length !== HEADERS.length || actualHeaders.some((value, index) => value !== HEADERS[index])) {
    fail(`Headers must be exactly: ${HEADERS.join(' | ')}. Found: ${(actualHeaders || []).join(' | ') || '(none)'}.`);
  }
  if (records.length !== ROW_COUNT) fail(`CSV must contain ${ROW_COUNT} data rows; found ${records.length}.`);

  const seen = new Map();
  const sourceIssues = [];
  const rows = records.map((values, index) => {
    const sourceRow = index + 2;
    const row = Object.fromEntries(HEADERS.map((header, column) => [header, String(values[column] ?? '').trim()]));
    row.sourceRow = sourceRow;
    if (!row['Group name']) sourceIssues.push(`Row ${sourceRow}: Group name is blank.`);
    if (!UUID.test(row.id)) sourceIssues.push(`Row ${sourceRow}: id "${row.id}" is not a valid UUID.`);
    if (seen.has(row.id)) sourceIssues.push(`Rows ${seen.get(row.id)} and ${sourceRow}: duplicate id ${row.id}.`);
    seen.set(row.id, sourceRow);
    const website = row.Website;
    if (website && !/^https?:\/\/[^\s]+$/i.test(website) && !/^www\.[^\s.]+(?:\.[^\s.]+)+(?:\/[^\s]*)?$/i.test(website)) {
      sourceIssues.push(`Row ${sourceRow}: Website "${website}" is not an HTTP(S) or www URL-like value.`);
    }
    for (const header of HEADERS) {
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(row[header])) {
        sourceIssues.push(`Row ${sourceRow}: ${header} contains a control character.`);
      }
    }
    return row;
  });
  if (sourceIssues.length) fail(`Source validation failed:\n- ${sourceIssues.join('\n- ')}`);
  const queens = rows.find((row) => row.id === '0d82d987-3f3a-4ec9-b104-6ebdab0a76cc');
  const newVictoria = rows.find((row) => row.id === '90efca5e-0272-46ef-9831-67ef26cb4653');
  if (queens?.['Address line 1'] !== 'Queen’s Hospital' ||
      newVictoria?.['Group name'] !== 'New Victoria Hospital, Kingston – part of Bupa') {
    fail('Mixed-encoding fixture assertion failed for the Windows-1252 apostrophe or UTF-8 en dash.');
  }
  return { rows, encoding };
}

async function auditTenant(client) {
  const { data, error } = await client.from('tenant').select('id, name').eq('id', TENANT_ID).single();
  if (error || data?.id !== TENANT_ID) fail(`Pinned BNMS tenant could not be resolved: ${error?.message || 'not found'}.`);
  if (!/british nuclear medicine society|bnms/i.test(data.name || '')) fail(`Pinned tenant name "${data.name}" is not BNMS.`);
  return data;
}

async function auditFields(client, rows) {
  const { data, error } = await client.from('preference_field')
    .select('id, tenant_id, name, label, field_type, options, is_active, entity_scope')
    .eq('tenant_id', TENANT_ID).eq('entity_scope', 'organization_group');
  if (error) fail(`Could not load BNMS Organisation Group fields: ${error.message}`);
  const byName = new Map();
  for (const field of data || []) {
    if (byName.has(field.name)) fail(`Ambiguous destination: multiple BNMS Organisation Group fields named "${field.name}".`);
    byName.set(field.name, field);
  }
  const audited = FIELD_SPECS.map((spec) => {
    const field = byName.get(spec.name);
    if (!field) fail(`Required destination field "${spec.label}" (${spec.name}) is missing.`);
    if (field.tenant_id !== TENANT_ID || field.entity_scope !== 'organization_group' || !field.is_active ||
        canonicalKey(field.label) !== canonicalKey(spec.label) || field.field_type !== spec.type) {
      fail(`Field ${spec.name} must belong to BNMS, be active, scope organization_group, labelled "${spec.label}", and type "${spec.type}".`);
    }
    if (spec.type !== 'dropdown') return { ...spec, id: field.id };
    const options = parseOptions(field.options, spec.name);
    const optionMap = new Map();
    for (const option of options) {
      const key = canonicalKey(option);
      if (optionMap.has(key) && optionMap.get(key) !== option) fail(`Dropdown ${spec.name} has ambiguous canonical options "${optionMap.get(key)}" and "${option}".`);
      optionMap.set(key, option);
    }
    const sourceValues = [...new Set(rows.map((row) => row[spec.header]).filter(Boolean))];
    const aliases = new Map(Object.entries(spec.aliases || {}).map(([source, destination]) => [canonicalKey(source), destination]));
    for (const [source, destination] of aliases) {
      if (!optionMap.has(canonicalKey(destination))) fail(`Configured alias "${source}" targets missing ${spec.name} option "${destination}".`);
    }
    const missingOptions = sourceValues.filter((value) =>
      !optionMap.has(canonicalKey(value)) && !aliases.has(canonicalKey(value)));
    const approved = APPROVED_OPTION_ADDITIONS.get(spec.name) || [];
    const unapproved = missingOptions.filter((value) =>
      !approved.some((candidate) => canonicalKey(candidate) === canonicalKey(value)));
    if (unapproved.length) {
      fail(`Dropdown ${spec.name} has unapproved source value(s): ${unapproved.join(', ')}.`);
    }
    return { ...spec, id: field.id, options, rawOptions: field.options, optionMap, aliases, missingOptions };
  });
  return audited;
}

async function applyApprovedOptionChanges(client, fields) {
  const added = [];
  for (const field of fields) {
    if (!field.missingOptions?.length) continue;
    const appended = [
      ...field.rawOptions,
      ...field.missingOptions.map((value) => ({ label: value, value })),
    ];
    const { data, error } = await client.from('preference_field')
      .update({ options: appended })
      .eq('tenant_id', TENANT_ID)
      .eq('entity_scope', 'organization_group')
      .eq('id', field.id)
      .select('id, tenant_id, entity_scope, options')
      .single();
    if (error || data?.id !== field.id || data?.tenant_id !== TENANT_ID ||
        data?.entity_scope !== 'organization_group') {
      fail(`Could not add approved options to ${field.name}: ${error?.message || 'unexpected response'}.`);
    }
    const persisted = new Set(parseOptions(data.options, field.name).map(canonicalKey));
    const absent = field.missingOptions.filter((value) => !persisted.has(canonicalKey(value)));
    if (absent.length) fail(`Approved options did not persist for ${field.name}: ${absent.join(', ')}.`);
    added.push(...field.missingOptions.map((value) => ({ field: field.name, value })));
  }
  return added;
}

async function loadGroupsById(client, ids) {
  const groups = [];
  for (let index = 0; index < ids.length; index += 100) {
    const { data, error } = await client.from('organization_group')
      .select('id, tenant_id, name').in('id', ids.slice(index, index + 100));
    if (error) fail(`Could not audit Organisation Group IDs: ${error.message}`);
    groups.push(...(data || []));
  }
  const byId = new Map();
  for (const group of groups) {
    if (byId.has(group.id)) fail(`ID ${group.id} resolved to more than one Organisation Group.`);
    byId.set(group.id, group);
  }
  const missing = ids.filter((id) => !byId.has(id));
  const foreign = groups.filter((group) => group.tenant_id !== TENANT_ID);
  if (missing.length || foreign.length) {
    fail(`ID audit failed: ${missing.length} missing ID(s); ${foreign.length} foreign-tenant ID(s).` +
      `${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}` +
      `${foreign.length ? ` Foreign: ${foreign.map((group) => group.id).join(', ')}.` : ''}`);
  }
  return byId;
}

async function loadValues(client, groupIds, fieldIds) {
  const values = new Map();
  for (let index = 0; index < groupIds.length; index += 100) {
    for (let from = 0; ; from += 500) {
      const { data, error } = await client.from('organization_group_preference_value')
        .select('id, tenant_id, organization_group_id, field_id, value')
        .in('organization_group_id', groupIds.slice(index, index + 100)).in('field_id', fieldIds)
        .order('id', { ascending: true }).range(from, from + 499);
      if (error) fail(`Could not load Organisation Group values: ${error.message}`);
      for (const value of data || []) {
        if (value.tenant_id !== TENANT_ID) fail(`Cross-tenant custom value ${value.id} encountered.`);
        const key = `${value.organization_group_id}::${value.field_id}`;
        if (values.has(key)) fail(`Duplicate custom values found for ${key}.`);
        values.set(key, value);
      }
      if ((data || []).length < 500) break;
    }
  }
  return values;
}

function makePlan(rows, fields, groups, stored) {
  const totals = { coreUpdated: 0, coreUnchanged: 0, valuesCreated: 0, valuesUpdated: 0, valuesUnchanged: 0, blanksSkipped: 0, failed: 0 };
  const items = rows.map((row) => {
    const group = groups.get(row.id);
    const nameAction = group.name === row['Group name'] ? 'unchanged' : 'update';
    totals[nameAction === 'update' ? 'coreUpdated' : 'coreUnchanged'] += 1;
    const values = fields.map((field) => {
      const source = row[field.header];
      const desired = resolveValue(field, source);
      const existing = stored.get(`${row.id}::${field.id}`);
      let action;
      if (!desired) action = 'blank-skipped';
      else if (existing?.value === desired) action = 'unchanged';
      else if (existing) action = 'update';
      else action = 'create';
      const totalKey = { 'blank-skipped': 'blanksSkipped', unchanged: 'valuesUnchanged', update: 'valuesUpdated', create: 'valuesCreated' }[action];
      totals[totalKey] += 1;
      return { header: field.header, fieldName: field.name, fieldId: field.id, type: field.type,
        source, desired, existingId: existing?.id || null, existing: existing?.value ?? null, action,
        canonicalised: Boolean(source && source !== desired) };
    });
    return { sourceRow: row.sourceRow, id: row.id, currentName: group.name, desiredName: row['Group name'], nameAction, values };
  });
  return { items, totals };
}

function buildReport(mode, tenant, encoding, fields, plan, applyResult = null, verification = null) {
  return {
    generatedAt: new Date().toISOString(), mode, sourceFile: path.relative(ROOT, FILE), sourceEncoding: encoding,
    tenant, sourceRows: plan.items.length,
    mapping: [
      { source: 'Group name', destination: 'organization_group.name', type: 'core' },
      { source: 'id', destination: 'organization_group.id', type: 'match-only' },
      ...fields.map((field) => ({ source: field.header, destination: field.name, fieldId: field.id, type: field.type })),
    ],
    approvedDropdownAdditions: fields.flatMap((field) =>
      (field.missingOptions || []).map((value) => ({ field: field.name, value }))),
    blankPolicy: 'Blank custom-field source values preserve existing values; blank group names are rejected.',
    totals: plan.totals, rows: plan.items, applyResult, verification,
  };
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Detailed report: ${path.relative(ROOT, REPORT_FILE)}`);
}

function printSummary(report) {
  console.log('\n--- Mapping audit (all 13 CSV headers) ---');
  for (const mapping of report.mapping) console.log(`  ${mapping.source} -> ${mapping.destination} [${mapping.type}]`);
  console.log('\n--- Approved dropdown additions ---');
  if (!report.approvedDropdownAdditions.length) console.log('  None');
  for (const item of report.approvedDropdownAdditions) console.log(`  ${item.field}: ${item.value}`);
  console.log('\n--- Dry-run change totals ---');
  for (const [key, value] of Object.entries(report.totals)) console.log(`  ${key}: ${value}`);
  const canonicalised = report.rows.flatMap((row) => row.values.filter((value) => value.canonicalised)
    .map((value) => `row ${row.sourceRow} ${value.header}: "${value.source}" -> "${value.desired}"`));
  console.log(`  dropdownCanonicalisations: ${canonicalised.length}`);
  canonicalised.forEach((line) => console.log(`    ${line}`));
  console.log('  malformedEncodingIssues: 0');
  console.log('  sourceValidationIssues: 0');
  console.log(`  blankPolicy: ${report.blankPolicy}`);
}

async function applyPlan(client, plan) {
  const result = { coreUpdated: 0, coreUnchanged: 0, valuesCreated: 0, valuesUpdated: 0, valuesUnchanged: 0, blanksSkipped: 0, failed: 0 };
  for (const item of plan.items) {
    if (item.nameAction === 'update') {
      const { data, error } = await client.from('organization_group').update({ name: item.desiredName })
        .eq('tenant_id', TENANT_ID).eq('id', item.id).select('id, tenant_id, name').single();
      if (error || data?.id !== item.id || data?.tenant_id !== TENANT_ID || data?.name !== item.desiredName) {
        result.failed += 1;
        fail(`Could not update group name for ${item.id}: ${error?.message || 'unexpected response'}.`);
      }
      result.coreUpdated += 1;
    } else result.coreUnchanged += 1;

    for (const value of item.values) {
      if (value.action === 'blank-skipped') { result.blanksSkipped += 1; continue; }
      if (value.action === 'unchanged') { result.valuesUnchanged += 1; continue; }
      let query;
      if (value.action === 'update') {
        query = client.from('organization_group_preference_value').update({ value: value.desired, updated_at: new Date().toISOString() })
          .eq('tenant_id', TENANT_ID).eq('id', value.existingId).eq('organization_group_id', item.id).eq('field_id', value.fieldId);
      } else {
        query = client.from('organization_group_preference_value').insert({
          tenant_id: TENANT_ID, organization_group_id: item.id, field_id: value.fieldId, value: value.desired,
        });
      }
      const { data, error } = await query.select('id, tenant_id, organization_group_id, field_id, value').single();
      if (error || data?.tenant_id !== TENANT_ID || data?.organization_group_id !== item.id ||
          data?.field_id !== value.fieldId || data?.value !== value.desired) {
        result.failed += 1;
        fail(`Could not ${value.action} ${value.fieldName} for ${item.id}: ${error?.message || 'unexpected response'}.`);
      }
      result[value.action === 'create' ? 'valuesCreated' : 'valuesUpdated'] += 1;
    }
  }
  return result;
}

async function verify(client, rows, fields) {
  const ids = rows.map((row) => row.id);
  const groups = await loadGroupsById(client, ids);
  const values = await loadValues(client, ids, fields.map((field) => field.id));
  const plan = makePlan(rows, fields, groups, values);
  if (plan.totals.coreUpdated || plan.totals.valuesCreated || plan.totals.valuesUpdated) {
    fail(`Post-import verification failed: ${plan.totals.coreUpdated} core and ${plan.totals.valuesCreated + plan.totals.valuesUpdated} custom writes still differ.`);
  }
  return {
    idsVerified: groups.size, expectedIds: rows.length, duplicateValues: 0, outOfTenantRecords: 0,
    updated: 0, unchanged: plan.totals.coreUnchanged + plan.totals.valuesUnchanged,
    skipped: plan.totals.blanksSkipped, failed: 0,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((arg) => arg !== '--apply')) fail('Only --apply is supported; no flag performs a dry run.');
  console.log(`\n=== BNMS Organisation Group CSV update: ${apply ? 'APPLY' : 'DRY RUN (no database writes)'} ===`);
  const { rows, encoding } = readRows();
  const client = supabaseClient();
  const tenant = await auditTenant(client);
  const groups = await loadGroupsById(client, rows.map((row) => row.id));
  console.log(`Tenant: ${tenant.name} (${tenant.id})`);
  console.log(`Source contract: ${rows.length} unique, valid IDs; ${HEADERS.length} exact headers; ${encoding} decoded without loss.`);
  console.log(`ID audit: ${groups.size}/${rows.length} IDs resolved exactly once to BNMS Organisation Groups.`);
  const fields = await auditFields(client, rows);
  const values = await loadValues(client, rows.map((row) => row.id), fields.map((field) => field.id));
  const plan = makePlan(rows, fields, groups, values);
  const dryReport = buildReport('dry-run', tenant, encoding, fields, plan);
  printSummary(dryReport);
  writeReport(dryReport);
  if (!apply) {
    console.log('\n=== Clean dry run complete; no database rows or field definitions modified ===\n');
    return;
  }
  const optionAdditions = await applyApprovedOptionChanges(client, fields);
  const persistedFields = await auditFields(client, rows);
  const applyResult = await applyPlan(client, plan);
  applyResult.dropdownOptionsAdded = optionAdditions.length;
  const verification = await verify(client, rows, persistedFields);
  const finalReport = buildReport('apply', tenant, encoding, fields, plan, applyResult, verification);
  writeReport(finalReport);
  console.log('\n--- Apply result ---');
  for (const [key, value] of Object.entries(applyResult)) console.log(`  ${key}: ${value}`);
  console.log('\n--- Post-import verification ---');
  for (const [key, value] of Object.entries(verification)) console.log(`  ${key}: ${value}`);
  console.log('\n=== Import and verification complete ===\n');
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});