#!/usr/bin/env node
/**
 * Dry-run-first importer for the approved BNMS Organisation Group workbook.
 *
 * Usage:
 *   node scripts/import-bnms-trust-groups.mjs
 *   node scripts/import-bnms-trust-groups.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const FILE = path.join(ROOT, 'attached_assets', 'Group_organisations_to_import_27.08.26_1787836786022.xlsx');
const HEADERS = [
  'Parent organisation', 'Parent category', 'Address line 1', 'Address line 2',
  'City', 'County', 'Country', 'Postcode', 'Telephone', 'Website', 'Parent code',
];
const ROW_COUNT = 161;
const ALLOWED_TYPES = ['NHS Trust / Health Board', 'Private Healthcare / Imaging Group', 'University'];
const ALLOWED_COUNTRIES = ['England', 'Wales', 'Northern Ireland', 'Scotland', 'Isle of Man'];
const FIELDS = [
  { header: 'Parent category', name: 'group_type', label: 'Group type', type: 'dropdown', key: 'category', mustExist: true },
  { header: 'Address line 1', name: 'group_address_line_1', label: 'Address line 1', type: 'text', key: 'address1' },
  { header: 'Address line 2', name: 'group_address_line_2', label: 'Address line 2', type: 'text', key: 'address2' },
  { header: 'City', name: 'group_town_city', label: 'Town / city', type: 'text', key: 'city', mustExist: true },
  { header: 'County', name: 'group_county', label: 'County', type: 'text', key: 'county' },
  { header: 'Country', name: 'group_country', label: 'Country', type: 'dropdown', key: 'country', mustExist: true },
  { header: 'Postcode', name: 'group_postcode', label: 'Postcode', type: 'text', key: 'postcode', mustExist: true },
  { header: 'Telephone', name: 'group_telephone', label: 'Telephone', type: 'text', key: 'telephone' },
  { header: 'Website', name: 'group_website', label: 'Website', type: 'text', key: 'website' },
  { header: 'Parent code', name: 'group_parent_code', label: 'Group parent code', type: 'text', key: 'parentCode', mustExist: true },
];

function fail(message) { throw new Error(message); }
function normalise(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');
}
function optionValues(raw) {
  raw = rawOptions(raw);
  return raw.map((item) => String(item && typeof item === 'object' ? item.value ?? item.label ?? '' : item).trim()).filter(Boolean);
}
function rawOptions(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { fail('A destination dropdown has invalid JSON options.'); }
  }
  if (raw == null) return [];
  if (!Array.isArray(raw)) fail('A destination dropdown options value is not an array.');
  return raw;
}
function options(values) { return values.map((value) => ({ label: value, value })); }
function supabaseClient() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; SOURCE and bare SUPABASE credentials are forbidden.');
  }
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
}

function readRows() {
  const workbook = XLSX.readFile(FILE);
  if (workbook.SheetNames.length !== 1) fail(`Workbook must have exactly one sheet; found ${workbook.SheetNames.length}.`);
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null, raw: false });
  const actual = (grid[0] || []).map((value) => String(value ?? '').trim());
  if (actual.length !== HEADERS.length || actual.some((value, index) => value !== HEADERS[index])) {
    fail(`Headers must be exactly: ${HEADERS.join(' | ')}. Found: ${actual.join(' | ') || '(none)'}.`);
  }
  const rows = [];
  for (let i = 1; i < grid.length; i += 1) {
    const values = HEADERS.map((_, column) => String(grid[i]?.[column] ?? '').trim());
    if (values.every((value) => !value)) continue;
    const row = {
      sourceRow: i + 1, name: values[0], category: values[1], address1: values[2],
      address2: values[3], city: values[4], county: values[5], country: values[6],
      postcode: values[7], telephone: values[8], website: values[9], parentCode: values[10],
    };
    if (!row.name) fail(`Row ${row.sourceRow} has a blank Parent organisation.`);
    if (row.category && !ALLOWED_TYPES.includes(row.category)) fail(`Row ${row.sourceRow} has unsupported Parent category "${row.category}".`);
    if (row.country && !ALLOWED_COUNTRIES.includes(row.country)) fail(`Row ${row.sourceRow} has unsupported Country "${row.country}".`);
    if (row.website) {
      const absoluteUrl = /^https?:\/\/[^\s]+$/i.test(row.website);
      const hostnameUrl = /^www\.[^\s.]+(?:\.[^\s.]+)+(?:\/[^\s]*)?$/i.test(row.website);
      if (!absoluteUrl && !hostnameUrl) fail(`Row ${row.sourceRow} has invalid Website "${row.website}".`);
    }
    rows.push(row);
  }
  if (rows.length !== ROW_COUNT) fail(`Workbook must contain ${ROW_COUNT} data rows; found ${rows.length}.`);
  const seen = new Map();
  for (const row of rows) {
    const key = normalise(row.name);
    if (seen.has(key)) fail(`Duplicate normalised group name "${row.name}" at rows ${seen.get(key).sourceRow} and ${row.sourceRow}.`);
    seen.set(key, row);
  }
  return rows;
}

async function fetchTenantRows(client, table, columns) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await client.from(table).select(columns).eq('tenant_id', TENANT_ID)
      .order('id', { ascending: true }).range(from, from + 499);
    if (error) fail(`Could not read ${table}: ${error.message}`);
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}

async function auditTenant(client) {
  const { data, error } = await client.from('tenant').select('id, name').eq('id', TENANT_ID).single();
  if (error || data?.id !== TENANT_ID) fail(`Pinned BNMS tenant could not be resolved: ${error?.message || 'not found'}.`);
  if (!/british nuclear medicine society|bnms/i.test(data.name || '')) fail(`Pinned tenant name "${data.name}" is not BNMS.`);
  return data;
}

async function auditFields(client, rows) {
  const { data, error } = await client.from('preference_field')
    .select('id, tenant_id, name, label, field_type, options, display_order, is_active, entity_scope')
    .eq('tenant_id', TENANT_ID).eq('entity_scope', 'organization_group')
    .order('display_order', { ascending: true }).order('id', { ascending: true });
  if (error) fail(`Could not load BNMS Organisation Group fields: ${error.message}`);
  const byName = new Map();
  const byLabel = new Map();
  for (const field of data || []) {
    if (byName.has(field.name)) fail(`Ambiguous destination: multiple BNMS Organisation Group fields named "${field.name}".`);
    byName.set(field.name, field);
    const labelKey = normalise(field.label);
    byLabel.set(labelKey, [...(byLabel.get(labelKey) || []), field]);
  }
  return FIELDS.map((spec, index) => {
    const field = byName.get(spec.name);
    if (!field) {
      const labelMatches = byLabel.get(normalise(spec.label)) || [];
      if (labelMatches.length) {
        fail(`Field "${spec.label}" exists under incompatible name(s) ${labelMatches.map((item) => `"${item.name}"`).join(', ')}; resolve before importing.`);
      }
      if (spec.mustExist) fail(`Required destination field "${spec.label}" (${spec.name}) is missing.`);
      return { ...spec, id: null, pendingCreate: true, displayOrder: (data?.length || 0) + index, currentOptions: [], missingOptions: [] };
    }
    if (!field.is_active || field.label !== spec.label || field.field_type !== spec.type) {
      fail(`Field ${spec.name} must be active, labelled "${spec.label}", and type "${spec.type}".`);
    }
    const currentRawOptions = spec.type === 'dropdown' ? rawOptions(field.options) : [];
    const currentOptions = spec.type === 'dropdown' ? optionValues(currentRawOptions) : [];
    const desired = [...new Set(rows.map((row) => row[spec.key]).filter(Boolean))];
    return { ...spec, id: field.id, pendingCreate: false, displayOrder: field.display_order,
      currentOptions, currentRawOptions,
      missingOptions: spec.type === 'dropdown' ? desired.filter((value) => !currentOptions.includes(value)) : [] };
  });
}

function mapGroups(groups, sourceRows) {
  const map = new Map();
  const duplicates = new Map();
  for (const group of groups) {
    const key = normalise(group.name);
    if (!key) continue;
    if (map.has(key)) duplicates.set(key, [...(duplicates.get(key) || [map.get(key)]), group]);
    else map.set(key, group);
  }
  for (const [key, matches] of duplicates) {
    const source = sourceRows.find((row) => normalise(row.name) === key);
    if (source) fail(`Ambiguous BNMS match for row ${source.sourceRow}: ${matches.map((g) => `"${g.name}" (${g.id})`).join(', ')}.`);
  }
  return map;
}

async function loadValues(client, groupIds, fieldIds) {
  const map = new Map();
  if (!groupIds.length || !fieldIds.length) return map;
  for (let i = 0; i < groupIds.length; i += 150) {
    for (let from = 0; ; from += 500) {
      const { data, error } = await client.from('organization_group_preference_value')
        .select('id, tenant_id, organization_group_id, field_id, value')
        .in('organization_group_id', groupIds.slice(i, i + 150)).in('field_id', fieldIds)
        .order('id', { ascending: true }).range(from, from + 499);
      if (error) fail(`Could not read Organisation Group values: ${error.message}`);
      for (const value of data || []) {
        if (value.tenant_id !== TENANT_ID) fail(`Cross-tenant custom value encountered for group ${value.organization_group_id}.`);
        const key = `${value.organization_group_id}::${value.field_id}`;
        if (map.has(key)) fail(`Duplicate stored Organisation Group value for ${key}.`);
        map.set(key, value);
      }
      if ((data || []).length < 500) break;
    }
  }
  return map;
}

function makePlan(rows, groupMap, fields, stored) {
  const totals = { created: 0, updated: 0, unchanged: 0, skipped: 0, groupCreates: 0, groupExisting: 0 };
  const items = rows.map((row) => {
    const group = groupMap.get(normalise(row.name));
    totals[group ? 'groupExisting' : 'groupCreates'] += 1;
    const values = fields.map((field) => {
      const desired = row[field.key];
      const existing = group && field.id ? stored.get(`${group.id}::${field.id}`) : null;
      const action = !desired ? 'skipped' : (!group || field.pendingCreate || !existing) ? 'created' : existing.value === desired ? 'unchanged' : 'updated';
      totals[action] += 1;
      return { field, desired, existing, action };
    });
    return { row, group, values };
  });
  return { items, totals };
}

function report(rows, fields, plan) {
  console.log('\n--- Approved mapping ---');
  console.log('  Parent organisation -> Organisation Group.name');
  fields.forEach((field) => console.log(`  ${field.header} -> ${field.label} (${field.name})${field.pendingCreate ? ' [CREATE FIELD]' : ''}`));
  console.log('\n--- Field changes ---');
  const changes = fields.filter((field) => field.pendingCreate || field.missingOptions.length);
  if (!changes.length) console.log('  None');
  for (const field of changes) {
    if (field.pendingCreate) console.log(`  CREATE text field ${field.label} (${field.name})`);
    if (field.missingOptions.length) console.log(`  ADD ${field.label} option(s): ${field.missingOptions.join(', ')}`);
  }
  console.log('\n--- Totals ---');
  console.log(`  Source rows:              ${rows.length}`);
  console.log(`  Groups to create:         ${plan.totals.groupCreates}`);
  console.log(`  Existing groups reused:   ${plan.totals.groupExisting}`);
  console.log(`  Values to create:         ${plan.totals.created}`);
  console.log(`  Values to update:         ${plan.totals.updated}`);
  console.log(`  Values unchanged:         ${plan.totals.unchanged}`);
  console.log(`  Blank values skipped:     ${plan.totals.skipped}`);
  console.log('\n--- Every planned source-row action ---');
  for (const item of plan.items) {
    const groupAction = item.group ? `REUSE ${item.group.id}` : 'CREATE';
    const details = item.values.filter((value) => value.action !== 'unchanged')
      .map((value) => `${value.field.name}=${value.action}`).join(', ') || 'all values unchanged';
    console.log(`  Row ${item.row.sourceRow}: ${groupAction} "${item.row.name}" | ${details}`);
  }
}

async function applyFieldChanges(client, rows, fields) {
  for (const field of fields) {
    if (field.pendingCreate) {
      const payload = { tenant_id: TENANT_ID, entity_scope: 'organization_group', name: field.name,
        label: field.label, field_type: field.type, options: null, is_active: true, is_required: false, display_order: field.displayOrder };
      const { data, error } = await client.from('preference_field').insert(payload).select('id').single();
      if (error || !data?.id) fail(`Could not create field ${field.name}: ${error?.message || 'no id returned'}.`);
    } else if (field.missingOptions.length) {
      const { data, error } = await client.from('preference_field')
        .update({ options: [...field.currentRawOptions, ...options(field.missingOptions)] })
        .eq('tenant_id', TENANT_ID).eq('id', field.id).select('id, options').single();
      if (error || !data?.id) fail(`Could not update options for ${field.name}: ${error?.message || 'no field returned'}.`);
      const persisted = new Set(optionValues(data.options));
      if (field.missingOptions.some((value) => !persisted.has(value))) fail(`Options did not persist for ${field.name}.`);
    }
  }
  return auditFields(client, rows);
}

async function fetchSnapshotRows(client, table, columns, outsideTenant = false) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    let query = client.from(table).select(columns).order('id', { ascending: true }).range(from, from + 499);
    query = outsideTenant ? query.neq('tenant_id', TENANT_ID) : query.eq('tenant_id', TENANT_ID);
    const { data, error } = await query;
    if (error) fail(`Could not snapshot ${table}: ${error.message}`);
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}

function digest(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function captureScopeSnapshot(client) {
  const [outsideFields, outsideGroups, outsideValues, organizations, memberGroups] = await Promise.all([
    fetchSnapshotRows(client, 'preference_field', '*', true),
    fetchSnapshotRows(client, 'organization_group', '*', true),
    fetchSnapshotRows(client, 'organization_group_preference_value', '*', true),
    fetchSnapshotRows(client, 'organization', '*'),
    fetchSnapshotRows(client, 'member_group', '*'),
  ]);
  return {
    outsideFields: { count: outsideFields.length, digest: digest(outsideFields) },
    outsideGroups: { count: outsideGroups.length, digest: digest(outsideGroups) },
    outsideValues: { count: outsideValues.length, digest: digest(outsideValues) },
    organizations: { count: organizations.length, digest: digest(organizations) },
    memberGroups: { count: memberGroups.length, digest: digest(memberGroups) },
  };
}

function verifyScopeSnapshot(before, after) {
  const changed = Object.keys(before).filter((key) =>
    before[key].count !== after[key].count || before[key].digest !== after[key].digest);
  if (changed.length) fail(`Scope verification failed; prohibited data changed in: ${changed.join(', ')}.`);
  console.log('  BNMS Organisations unchanged:       yes');
  console.log('  BNMS Member Groups unchanged:       yes');
  console.log('  Non-BNMS fields/groups/values:      unchanged');
}

async function applyPlan(client, plan, fields) {
  const result = { created: 0, updated: 0, unchanged: 0, skipped: 0, groupCreates: 0, groupExisting: 0, failed: 0 };
  for (const item of plan.items) {
    let group = item.group;
    if (!group) {
      const { data, error } = await client.from('organization_group')
        .insert({ tenant_id: TENANT_ID, name: item.row.name }).select('id, tenant_id, name').single();
      if (error || !data?.id || data.tenant_id !== TENANT_ID) fail(`Could not create group "${item.row.name}": ${error?.message || 'invalid response'}.`);
      group = data;
      result.groupCreates += 1;
    } else result.groupExisting += 1;
    for (const valuePlan of item.values) {
      if (valuePlan.action === 'skipped' || valuePlan.action === 'unchanged') {
        result[valuePlan.action] += 1;
        continue;
      }
      const field = fields.find((candidate) => candidate.name === valuePlan.field.name);
      if (!field?.id) fail(`No resolved field id for ${valuePlan.field.name}.`);
      const { data, error } = await client.from('organization_group_preference_value').upsert({
        tenant_id: TENANT_ID, organization_group_id: group.id, field_id: field.id,
        value: valuePlan.desired, updated_at: new Date().toISOString(),
      }, { onConflict: 'organization_group_id,field_id' })
        .select('id, tenant_id, organization_group_id, field_id, value').single();
      if (error || !data?.id || data.tenant_id !== TENANT_ID || data.value !== valuePlan.desired) {
        fail(`Could not persist ${field.name} for "${item.row.name}": ${error?.message || 'invalid response'}.`);
      }
      result[valuePlan.action] += 1;
    }
  }
  return result;
}

async function verify(client, rows, fields) {
  const groups = await fetchTenantRows(client, 'organization_group', 'id, tenant_id, name');
  const groupMap = mapGroups(groups, rows);
  const missing = rows.filter((row) => !groupMap.has(normalise(row.name)));
  const sourceGroups = rows.map((row) => groupMap.get(normalise(row.name))).filter(Boolean);
  const values = await loadValues(client, sourceGroups.map((group) => group.id), fields.map((field) => field.id));
  const mismatches = [];
  for (const row of rows) for (const field of fields) {
    if (!row[field.key]) continue;
    const group = groupMap.get(normalise(row.name));
    const actual = group ? values.get(`${group.id}::${field.id}`)?.value : undefined;
    if (actual !== row[field.key]) mismatches.push({ row: row.sourceRow, group: row.name, field: field.name, expected: row[field.key], actual });
  }
  if (missing.length || mismatches.length) fail(`Verification failed: ${missing.length} missing groups, ${mismatches.length} mismatched values.`);
  const rerunPlan = makePlan(rows, groupMap, fields, values);
  if (rerunPlan.totals.groupCreates || rerunPlan.totals.created || rerunPlan.totals.updated) fail('Idempotency verification failed: a second run would still write data.');
  console.log('\n--- Post-import audit ---');
  console.log(`  Source names found exactly once: ${rows.length}/${rows.length}`);
  console.log(`  Nonblank values verified:        ${rerunPlan.totals.unchanged}`);
  console.log(`  Blank values skipped:            ${rerunPlan.totals.skipped}`);
  console.log('  Idempotent re-run:                0 creates, 0 updates');
  console.log(`  Tenant scope:                     ${TENANT_ID} only`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((arg) => arg !== '--apply')) fail('Only --apply is supported; no flag performs a dry run.');
  console.log('\n=== BNMS Organisation Group import ===');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
  const rows = readRows();
  const client = supabaseClient();
  const tenant = await auditTenant(client);
  console.log(`Tenant: ${tenant.name} (${tenant.id})`);
  let fields = await auditFields(client, rows);
  let groups = await fetchTenantRows(client, 'organization_group', 'id, tenant_id, name');
  let groupMap = mapGroups(groups, rows);
  let values = await loadValues(client,
    rows.map((row) => groupMap.get(normalise(row.name))?.id).filter(Boolean),
    fields.map((field) => field.id).filter(Boolean));
  let plan = makePlan(rows, groupMap, fields, values);
  report(rows, fields, plan);
  if (!apply) {
    console.log('\n=== DRY RUN complete: no database rows or field definitions modified ===\n');
    return;
  }
  const scopeBefore = await captureScopeSnapshot(client);
  fields = await applyFieldChanges(client, rows, fields);
  groups = await fetchTenantRows(client, 'organization_group', 'id, tenant_id, name');
  groupMap = mapGroups(groups, rows);
  values = await loadValues(client,
    rows.map((row) => groupMap.get(normalise(row.name))?.id).filter(Boolean),
    fields.map((field) => field.id));
  plan = makePlan(rows, groupMap, fields, values);
  const result = await applyPlan(client, plan, fields);
  console.log('\n--- Apply summary ---');
  Object.entries(result).forEach(([key, value]) => console.log(`  ${key}: ${value}`));
  await verify(client, rows, fields);
  const scopeAfter = await captureScopeSnapshot(client);
  verifyScopeSnapshot(scopeBefore, scopeAfter);
  console.log('\n=== Import complete ===\n');
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});