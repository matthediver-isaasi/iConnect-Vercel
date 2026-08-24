#!/usr/bin/env node
/**
 * Import BNMS NHS trusts and health boards as Organisation Groups.
 *
 * The importer is intentionally pinned to BNMS and the destination Supabase
 * project. It is idempotent: group names are matched case-insensitively and
 * custom values are upserted on (organization_group_id, field_id).
 *
 * Usage:
 *   node scripts/import-bnms-trust-groups.mjs          # dry run (default)
 *   node scripts/import-bnms-trust-groups.mjs --apply  # create/update + verify
 */

import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const XLSX_FILE = path.join(
  REPO_ROOT,
  'attached_assets',
  'Trusts_import_23.08.26_1787547703426.xlsx',
);
const EXPECTED_HEADERS = [
  'Parent organisation',
  'Dropdown category',
  'BNMS region',
  'Country',
  'Town / city',
  'Postcode',
  'Parent code',
];
const EXPECTED_ROW_COUNT = 218;
const YORKSHIRE_SOURCE_VALUE = 'Yorkshire & the Humber';
const YORKSHIRE_DESTINATION_VALUE = 'Yorkshire and the Humber';

const FIELD_SPECS = [
  {
    header: 'Dropdown category',
    fieldName: 'group_type',
    label: 'Group type',
    fieldType: 'dropdown',
    sourceKey: 'category',
    existingOnly: true,
  },
  {
    header: 'BNMS region',
    fieldName: 'group_region',
    label: 'Group region',
    fieldType: 'dropdown',
    sourceKey: 'region',
    existingOnly: true,
    canonicalise: (value) => value === YORKSHIRE_SOURCE_VALUE ? YORKSHIRE_DESTINATION_VALUE : value,
  },
  {
    header: 'Country',
    fieldName: 'group_country',
    label: 'Country',
    fieldType: 'dropdown',
    sourceKey: 'country',
    createIfMissing: true,
  },
  {
    header: 'Town / city',
    fieldName: 'group_town_city',
    label: 'Town / city',
    fieldType: 'text',
    sourceKey: 'townCity',
    createIfMissing: true,
  },
  {
    header: 'Postcode',
    fieldName: 'group_postcode',
    label: 'Postcode',
    fieldType: 'text',
    sourceKey: 'postcode',
    createIfMissing: true,
  },
  {
    header: 'Parent code',
    fieldName: 'group_parent_code',
    label: 'Group parent code',
    fieldType: 'text',
    sourceKey: 'parentCode',
    existingOnly: true,
  },
];

function fail(message) {
  throw new Error(message);
}

function getSupabase() {
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required. Do not use SOURCE or bare SUPABASE variables.');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function normName(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-GB');
}

function valuesFromOptions(raw) {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((option) => {
      if (option && typeof option === 'object') return String(option.value ?? option.label ?? '').trim();
      return String(option ?? '').trim();
    })
    .filter(Boolean);
}

function optionObjects(values) {
  return values.map((value) => ({ label: value, value }));
}

function rowValue(row, spec) {
  const value = String(row[spec.sourceKey] ?? '').trim();
  return spec.canonicalise ? spec.canonicalise(value) : value;
}

function readWorkbook() {
  const workbook = XLSX.readFile(XLSX_FILE);
  if (workbook.SheetNames.length !== 1) {
    fail(`Workbook must contain exactly one sheet; found ${workbook.SheetNames.length}.`);
  }

  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    defval: null,
    raw: false,
  });
  const headers = (grid[0] || []).map((value) => String(value ?? '').trim());
  if (headers.length !== EXPECTED_HEADERS.length || headers.some((header, index) => header !== EXPECTED_HEADERS[index])) {
    fail(`Workbook headers must be exactly: ${EXPECTED_HEADERS.join(' | ')}. Found: ${headers.join(' | ') || '(none)'}.`);
  }

  const rows = [];
  for (let index = 1; index < grid.length; index += 1) {
    const source = grid[index] || [];
    const values = EXPECTED_HEADERS.map((_, column) => String(source[column] ?? '').trim());
    if (values.every((value) => !value)) continue;
    const missing = EXPECTED_HEADERS.filter((_, column) => !values[column]);
    if (missing.length) {
      fail(`Spreadsheet row ${index + 1} is missing mandatory value(s): ${missing.join(', ')}.`);
    }
    rows.push({
      sourceRow: index + 1,
      name: values[0],
      category: values[1],
      region: values[2],
      country: values[3],
      townCity: values[4],
      postcode: values[5],
      parentCode: values[6],
    });
  }

  if (rows.length !== EXPECTED_ROW_COUNT) {
    fail(`Workbook must contain ${EXPECTED_ROW_COUNT} data rows; found ${rows.length}.`);
  }

  const names = new Map();
  for (const row of rows) {
    const key = normName(row.name);
    const prior = names.get(key);
    if (prior) {
      fail(`Duplicate normalized group name in workbook: "${row.name}" (rows ${prior.sourceRow} and ${row.sourceRow}).`);
    }
    names.set(key, row);
  }
  return rows;
}

async function fetchAll(supabase, table, columns, tenantId) {
  const records = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) fail(`Could not read ${table}: ${error.message}`);
    records.push(...(data || []));
    if ((data || []).length < pageSize) return records;
  }
}

async function loadFieldDefinitions(supabase) {
  const { data, error } = await supabase
    .from('preference_field')
    .select('id, tenant_id, name, label, field_type, options, display_order, is_active, entity_scope')
    .eq('tenant_id', TENANT_ID)
    .eq('entity_scope', 'organization_group')
    .order('display_order', { ascending: true });
  if (error) fail(`Could not load BNMS organisation-group field definitions: ${error.message}`);
  return data || [];
}

function auditFieldMapping(rows, fieldDefinitions) {
  const byName = new Map();
  for (const field of fieldDefinitions) {
    if (byName.has(field.name)) fail(`More than one BNMS group field is named "${field.name}". Resolve it before importing.`);
    byName.set(field.name, field);
  }

  const fields = [];
  for (const spec of FIELD_SPECS) {
    const field = byName.get(spec.fieldName);
    if (!field) {
      if (spec.createIfMissing) {
        fields.push({ ...spec, id: null, pendingCreate: true });
        continue;
      }
      fail(`Required mapping is missing: "${spec.header}" needs active BNMS group field "${spec.label}" (${spec.fieldName}).`);
    }
    if (field.label !== spec.label || field.field_type !== spec.fieldType || !field.is_active) {
      fail(`Invalid mapping for "${spec.header}": field "${spec.fieldName}" must be active, labelled "${spec.label}", and type "${spec.fieldType}".`);
    }

    const mappedValues = new Set(rows.map((row) => rowValue(row, spec)));
    if (spec.fieldType === 'dropdown') {
      const optionValues = new Set(valuesFromOptions(field.options));
      const unsupported = [...mappedValues].filter((value) => !optionValues.has(value));
      if (unsupported.length) {
        fail(`Field "${spec.label}" is missing supported option(s): ${unsupported.join(', ')}.`);
      }
    }
    fields.push({ ...spec, id: field.id, pendingCreate: false, displayOrder: field.display_order });
  }
  return fields;
}

function pendingFieldPayload(spec, rows) {
  const displayOrder = FIELD_SPECS.findIndex((candidate) => candidate.fieldName === spec.fieldName);
  return {
    tenant_id: TENANT_ID,
    entity_scope: 'organization_group',
    name: spec.fieldName,
    label: spec.label,
    field_type: spec.fieldType,
    options: spec.fieldType === 'dropdown'
      ? optionObjects([...new Set(rows.map((row) => rowValue(row, spec)))].sort())
      : null,
    is_active: true,
    is_required: false,
    display_order: displayOrder,
  };
}

function formatFieldMapping(field) {
  const destination = field.pendingCreate
    ? `${field.label} [NEW ${field.fieldType} field]`
    : `${field.label} (${field.fieldType}, ${field.id})`;
  return `  ${field.header} -> ${destination}`;
}

function buildGroupMap(groups, sourceRows) {
  const byNorm = new Map();
  for (const group of groups) {
    const key = normName(group.name);
    const prior = byNorm.get(key);
    if (prior) {
      const source = sourceRows.find((row) => normName(row.name) === key);
      if (source) {
        fail(`Existing BNMS groups "${prior.name}" and "${group.name}" both match spreadsheet row ${source.sourceRow}. Resolve duplicate groups before importing.`);
      }
      continue;
    }
    byNorm.set(key, group);
  }
  return byNorm;
}

async function loadPreferenceValues(supabase, groupIds, fieldIds) {
  const values = new Map();
  const groupIdChunks = [];
  for (let index = 0; index < groupIds.length; index += 200) groupIdChunks.push(groupIds.slice(index, index + 200));
  for (const groupChunk of groupIdChunks) {
    const pageSize = 500;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('organization_group_preference_value')
        .select('id, organization_group_id, field_id, value')
        .in('organization_group_id', groupChunk)
        .in('field_id', fieldIds)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) fail(`Could not read existing group custom values: ${error.message}`);
      for (const value of data || []) {
        const key = `${value.organization_group_id}::${value.field_id}`;
        if (values.has(key)) fail(`Duplicate stored group custom value for ${key}. Resolve it before importing.`);
        values.set(key, value);
      }
      if ((data || []).length < pageSize) break;
    }
  }
  return values;
}

function buildPlan(rows, groupsByNorm, fields, preferenceValues) {
  const plans = [];
  const totals = {
    groupCreates: 0,
    groupExisting: 0,
    valueCreates: 0,
    valueUpdates: 0,
    valueUnchanged: 0,
  };

  for (const row of rows) {
    const existing = groupsByNorm.get(normName(row.name));
    const plan = { row, existingGroup: existing || null, valuePlans: [] };
    if (existing) totals.groupExisting += 1;
    else totals.groupCreates += 1;

    for (const field of fields) {
      const desired = rowValue(row, field);
      const existingValue = existing && field.id
        ? preferenceValues.get(`${existing.id}::${field.id}`)
        : null;
      const action = !existing || field.pendingCreate || !existingValue
        ? 'create'
        : existingValue.value === desired ? 'unchanged' : 'update';
      if (action === 'create') totals.valueCreates += 1;
      else if (action === 'update') totals.valueUpdates += 1;
      else totals.valueUnchanged += 1;
      plan.valuePlans.push({ field, desired, existingValue, action });
    }
    plans.push(plan);
  }
  return { plans, totals };
}

function reportAudit(rows, fields, plan) {
  console.log('\n--- Approved source-to-destination mapping ---');
  console.log('  Parent organisation -> Organisation Group.name (core group field)');
  fields.forEach((field) => console.log(formatFieldMapping(field)));
  console.log(`  Yorkshire canonicalisation -> "${YORKSHIRE_SOURCE_VALUE}" becomes "${YORKSHIRE_DESTINATION_VALUE}"`);

  const pending = fields.filter((field) => field.pendingCreate);
  console.log('\n--- Field-definition changes ---');
  if (!pending.length) {
    console.log('  None. All required group fields already exist.');
  } else {
    for (const field of pending) {
      const extras = field.fieldType === 'dropdown'
        ? ` with options: ${[...new Set(rows.map((row) => rowValue(row, field)))].sort().join(', ')}`
        : '';
      console.log(`  CREATE ${field.label} (${field.fieldType})${extras}`);
    }
  }

  console.log('\n--- Import plan ---');
  console.log(`  Groups to create:       ${plan.totals.groupCreates}`);
  console.log(`  Existing groups:        ${plan.totals.groupExisting}`);
  console.log(`  Custom values to create:${String(plan.totals.valueCreates).padStart(5)}`);
  console.log(`  Custom values to update:${String(plan.totals.valueUpdates).padStart(5)}`);
  console.log(`  Custom values unchanged:${String(plan.totals.valueUnchanged).padStart(3)}`);
}

async function createMissingFields(supabase, rows, fields) {
  const resolved = [];
  for (const field of fields) {
    if (!field.pendingCreate) {
      resolved.push(field);
      continue;
    }
    const { data, error } = await supabase
      .from('preference_field')
      .insert(pendingFieldPayload(field, rows))
      .select('id, tenant_id, name, label, field_type, options, display_order, is_active, entity_scope')
      .single();
    if (error) fail(`Could not create BNMS group field "${field.label}": ${error.message}`);
    if (!data?.id) fail(`Creating BNMS group field "${field.label}" returned no id.`);
    console.log(`  + Created group field: ${field.label} (${data.id})`);
    resolved.push({ ...field, id: data.id, pendingCreate: false, displayOrder: data.display_order });
  }

  // Re-audit from persisted definitions before group rows are touched.
  const persisted = await loadFieldDefinitions(supabase);
  return auditFieldMapping(rows, persisted);
}

async function applyImport(supabase, initialPlan, fields) {
  const failures = [];
  const result = {
    groupCreates: 0,
    groupExisting: 0,
    valueCreates: 0,
    valueUpdates: 0,
    valueUnchanged: 0,
  };
  const groupIdsByName = new Map();

  for (const item of initialPlan.plans) {
    let group = item.existingGroup;
    if (!group) {
      const { data, error } = await supabase
        .from('organization_group')
        .insert({ tenant_id: TENANT_ID, name: item.row.name })
        .select('id, tenant_id, name')
        .single();
      if (error || !data?.id) {
        failures.push({ row: item.row.sourceRow, name: item.row.name, stage: 'group create', message: error?.message || 'no group id returned' });
        continue;
      }
      group = data;
      result.groupCreates += 1;
    } else {
      result.groupExisting += 1;
    }
    groupIdsByName.set(normName(item.row.name), group.id);

    for (const valuePlan of item.valuePlans) {
      const field = fields.find((candidate) => candidate.fieldName === valuePlan.field.fieldName);
      if (!field?.id) {
        failures.push({ row: item.row.sourceRow, name: item.row.name, stage: `field ${valuePlan.field.label}`, message: 'field id was not resolved' });
        continue;
      }
      if (valuePlan.action === 'unchanged') {
        result.valueUnchanged += 1;
        continue;
      }
      const { data, error } = await supabase
        .from('organization_group_preference_value')
        .upsert(
          {
            tenant_id: TENANT_ID,
            organization_group_id: group.id,
            field_id: field.id,
            value: valuePlan.desired,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'organization_group_id,field_id', ignoreDuplicates: false },
        )
        .select('id, organization_group_id, field_id, value')
        .single();
      if (error || !data?.id || data.value !== valuePlan.desired) {
        failures.push({
          row: item.row.sourceRow,
          name: item.row.name,
          stage: `custom field ${field.label}`,
          message: error?.message || 'write did not return the expected value',
        });
        continue;
      }
      if (valuePlan.action === 'create') result.valueCreates += 1;
      else result.valueUpdates += 1;
    }
  }

  return { result, failures, groupIdsByName };
}

async function verifyImport(supabase, rows, fields) {
  const allGroups = await fetchAll(supabase, 'organization_group', 'id, tenant_id, name', TENANT_ID);
  const groupsByNorm = buildGroupMap(allGroups, rows);
  const sourceGroups = rows.map((row) => ({ row, group: groupsByNorm.get(normName(row.name)) })).filter((entry) => entry.group);
  const missingNames = rows.filter((row) => !groupsByNorm.has(normName(row.name))).map((row) => row.name);
  const preferences = await loadPreferenceValues(
    supabase,
    sourceGroups.map((entry) => entry.group.id),
    fields.map((field) => field.id),
  );

  const mismatches = [];
  for (const { row, group } of sourceGroups) {
    for (const field of fields) {
      const stored = preferences.get(`${group.id}::${field.id}`);
      const expected = rowValue(row, field);
      if (!stored || stored.value !== expected) {
        mismatches.push({
          row: row.sourceRow,
          group: row.name,
          field: field.label,
          expected,
          actual: stored?.value ?? '(missing)',
        });
      }
    }
  }

  const representativeRegions = [...new Set(rows.map((row) => rowValue(row, fields.find((field) => field.fieldName === 'group_region'))))].sort();
  const representative = representativeRegions.map((region) => {
    const row = rows.find((candidate) => rowValue(candidate, fields.find((field) => field.fieldName === 'group_region')) === region);
    const group = groupsByNorm.get(normName(row.name));
    return `${region}: ${row.name} (${group?.id || 'MISSING'})`;
  });

  console.log('\n--- Post-import verification ---');
  console.log(`  Spreadsheet names found: ${sourceGroups.length}/${rows.length}`);
  console.log(`  Expected custom values:  ${rows.length * fields.length}`);
  console.log(`  Matching custom values:  ${rows.length * fields.length - mismatches.length}`);
  console.log(`  Duplicate source names:  0`);
  console.log('  Representative groups by region:');
  representative.forEach((line) => console.log(`    - ${line}`));

  if (missingNames.length || mismatches.length) {
    console.error('\nVerification exceptions:');
    missingNames.forEach((name) => console.error(`  - Missing group: ${name}`));
    mismatches.slice(0, 25).forEach((mismatch) => {
      console.error(`  - Row ${mismatch.row}, ${mismatch.group}, ${mismatch.field}: expected "${mismatch.expected}", got "${mismatch.actual}"`);
    });
    if (mismatches.length > 25) console.error(`  - ... ${mismatches.length - 25} further field mismatch(es)`);
    fail(`Verification failed: ${missingNames.length} missing group(s), ${mismatches.length} field mismatch(es).`);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((arg) => arg !== '--apply')) {
    fail('Only --apply is supported. With no flag, this importer performs a dry run.');
  }

  console.log('\n=== Import BNMS trust groups ===');
  console.log(`Tenant: ${TENANT_ID} (BNMS)`);
  console.log(`Mode:   ${apply ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);

  const rows = readWorkbook();
  const supabase = getSupabase();
  const definitions = await loadFieldDefinitions(supabase);
  const fields = auditFieldMapping(rows, definitions);
  const groups = await fetchAll(supabase, 'organization_group', 'id, tenant_id, name', TENANT_ID);
  const groupsByNorm = buildGroupMap(groups, rows);
  const existingSourceGroupIds = rows
    .map((row) => groupsByNorm.get(normName(row.name))?.id)
    .filter(Boolean);
  const existingFieldIds = fields.filter((field) => field.id).map((field) => field.id);
  const preferences = await loadPreferenceValues(supabase, existingSourceGroupIds, existingFieldIds);
  const plan = buildPlan(rows, groupsByNorm, fields, preferences);

  console.log(`\nWorkbook: ${rows.length} validated source rows; ${groups.length} current BNMS group(s).`);
  reportAudit(rows, fields, plan);

  if (!apply) {
    console.log('\n=== DRY RUN complete ===');
    console.log('No database rows or field definitions were modified. Re-run with --apply to import.\n');
    return;
  }

  console.log('\n--- Applying approved field-definition changes ---');
  const resolvedFields = await createMissingFields(supabase, rows, fields);

  // Re-plan after pending fields receive persistent IDs, before importing groups.
  const refreshedGroups = await fetchAll(supabase, 'organization_group', 'id, tenant_id, name', TENANT_ID);
  const refreshedByNorm = buildGroupMap(refreshedGroups, rows);
  const refreshedGroupIds = rows.map((row) => refreshedByNorm.get(normName(row.name))?.id).filter(Boolean);
  const refreshedValues = await loadPreferenceValues(supabase, refreshedGroupIds, resolvedFields.map((field) => field.id));
  const refreshedPlan = buildPlan(rows, refreshedByNorm, resolvedFields, refreshedValues);

  console.log('\n--- Applying group and custom-value import ---');
  const { result, failures } = await applyImport(supabase, refreshedPlan, resolvedFields);
  console.log('\n=== APPLY summary ===');
  console.log(`  Groups created:          ${result.groupCreates}`);
  console.log(`  Existing groups:         ${result.groupExisting}`);
  console.log(`  Custom values created:   ${result.valueCreates}`);
  console.log(`  Custom values updated:   ${result.valueUpdates}`);
  console.log(`  Custom values unchanged: ${result.valueUnchanged}`);
  console.log(`  Failed row operations:   ${failures.length}`);
  if (failures.length) {
    failures.forEach((failure) => console.error(`  - Row ${failure.row}, ${failure.name}, ${failure.stage}: ${failure.message}`));
    fail('Import completed with failures. Re-run after resolving the errors; completed operations are idempotent.');
  }

  await verifyImport(supabase, rows, resolvedFields);
  console.log('\nImport and verification completed successfully.\n');
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});