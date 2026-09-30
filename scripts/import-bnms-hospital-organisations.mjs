#!/usr/bin/env node
/**
 * Import BNMS hospital and imaging-site organisations plus their private groups.
 *
 * This is deliberately a destination-only, one-off importer. It defaults to a
 * fully validating dry run and will only write when passed --apply.
 *
 * Usage:
 *   node scripts/import-bnms-hospital-organisations.mjs
 *   node scripts/import-bnms-hospital-organisations.mjs --apply
 */

import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const HOSPITALS_FILE = path.join(REPO_ROOT, 'attached_assets', 'Hospitals_import_23.08.26_1787548699712.xlsx');
const PRIVATE_GROUPS_FILE = path.join(REPO_ROOT, 'attached_assets', 'Private_groups_import_23.08.26_1787555310531.xlsx');
const HOSPITAL_HEADERS = [
  'Hospital / organisation name',
  'Dropdown category',
  'Principal parent organisation',
  'BNMS region',
  'Country',
  'Town / city',
  'Postcode',
  'Site code',
  'Parent code',
];
const PRIVATE_GROUP_HEADERS = [
  'Parent organisation',
  'Parent category',
  'BNMS region',
  'Country',
  'Town / city',
  'Postcode',
];
const EXPECTED_HOSPITAL_ROWS = 1978;
const EXPECTED_PRIVATE_GROUP_ROWS = 10;
const YORKSHIRE_SOURCE_VALUE = 'Yorkshire & the Humber';
const YORKSHIRE_DESTINATION_VALUE = 'Yorkshire and the Humber';

const ORGANISATION_FIELD_SPECS = [
  { header: 'Dropdown category', name: 'organisation_type', label: 'Type', fieldType: 'dropdown', key: 'category', existingOnly: true },
  { header: 'BNMS region', name: 'region', label: 'Region', fieldType: 'dropdown', key: 'region', existingOnly: true, canonicalise: canonicaliseRegion },
  { header: 'Country', name: 'country', label: 'Country', fieldType: 'dropdown', key: 'country', createIfMissing: true },
  { header: 'Town / city', name: 'town_city', label: 'Town / city', fieldType: 'text', key: 'townCity', createIfMissing: true },
  { header: 'Postcode', name: 'postcode', label: 'Postcode', fieldType: 'text', key: 'postcode', createIfMissing: true },
  { header: 'Site code', name: 'site_code', label: 'Site code', fieldType: 'text', key: 'siteCode', existingOnly: true },
  { header: 'Parent code', name: 'parent_code', label: 'Parent code', fieldType: 'text', key: 'parentCode', existingOnly: true },
];

const GROUP_FIELD_SPECS = [
  { header: 'Parent category', name: 'group_type', label: 'Group type', fieldType: 'dropdown', key: 'category', existingOnly: true },
  { header: 'BNMS region', name: 'group_region', label: 'Group region', fieldType: 'dropdown', key: 'region', existingOnly: true, canonicalise: canonicaliseRegion },
  { header: 'Country', name: 'group_country', label: 'Country', fieldType: 'dropdown', key: 'country', existingOnly: true },
  { header: 'Town / city', name: 'group_town_city', label: 'Town / city', fieldType: 'text', key: 'townCity', existingOnly: true },
  { header: 'Postcode', name: 'group_postcode', label: 'Postcode', fieldType: 'text', key: 'postcode', existingOnly: true },
];

function fail(message) {
  throw new Error(message);
}

function canonicaliseRegion(value) {
  return value === YORKSHIRE_SOURCE_VALUE ? YORKSHIRE_DESTINATION_VALUE : value;
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

function getSupabase() {
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required. SOURCE and bare SUPABASE credentials are not permitted.');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function valuesFromOptions(raw) {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      fail('A dropdown field has invalid JSON options.');
    }
  }
  if (raw == null) return [];
  if (!Array.isArray(raw)) fail('A dropdown field options value is not an array.');
  return raw.map((option) => {
    if (option && typeof option === 'object') return String(option.value ?? option.label ?? '').trim();
    return String(option ?? '').trim();
  }).filter(Boolean);
}

function optionObjects(values) {
  return values.map((value) => ({ label: value, value }));
}

function rowValue(row, spec) {
  const raw = String(row[spec.key] ?? '').trim();
  return spec.canonicalise ? spec.canonicalise(raw) : raw;
}

function ensureExactHeaders(grid, expected, label) {
  const headers = (grid[0] || []).map((value) => String(value ?? '').trim());
  if (headers.length !== expected.length || headers.some((value, index) => value !== expected[index])) {
    fail(`${label} headers must be exactly: ${expected.join(' | ')}. Found: ${headers.join(' | ') || '(none)'}.`);
  }
}

function readSingleSheet(file, expectedHeaders, label) {
  const workbook = XLSX.readFile(file);
  if (workbook.SheetNames.length !== 1) {
    fail(`${label} must contain exactly one sheet; found ${workbook.SheetNames.length}.`);
  }
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    defval: null,
    raw: false,
  });
  ensureExactHeaders(grid, expectedHeaders, label);
  return grid;
}

function requireUniqueNames(rows, kind) {
  const seen = new Map();
  for (const row of rows) {
    const key = normName(row.name);
    if (!key) fail(`${kind} row ${row.sourceRow} has a blank name.`);
    const prior = seen.get(key);
    if (prior) {
      fail(`Duplicate normalized ${kind} name "${row.name}" in source rows ${prior.sourceRow} and ${row.sourceRow}.`);
    }
    seen.set(key, row);
  }
  return seen;
}

function readSources() {
  const hospitalGrid = readSingleSheet(HOSPITALS_FILE, HOSPITAL_HEADERS, 'Hospital workbook');
  const hospitals = [];
  for (let index = 1; index < hospitalGrid.length; index += 1) {
    const values = HOSPITAL_HEADERS.map((_, column) => String(hospitalGrid[index]?.[column] ?? '').trim());
    if (values.every((value) => !value)) continue;
    const mandatoryHeaders = HOSPITAL_HEADERS.slice(0, 5);
    const missing = mandatoryHeaders.filter((_, column) => !values[column]);
    if (missing.length) fail(`Hospital workbook row ${index + 1} is missing mandatory value(s): ${missing.join(', ')}.`);
    hospitals.push({
      sourceRow: index + 1,
      name: values[0],
      category: values[1],
      parentName: values[2],
      region: values[3],
      country: values[4],
      townCity: values[5],
      postcode: values[6],
      siteCode: values[7],
      parentCode: values[8],
    });
  }
  if (hospitals.length !== EXPECTED_HOSPITAL_ROWS) {
    fail(`Hospital workbook must contain ${EXPECTED_HOSPITAL_ROWS} data rows; found ${hospitals.length}.`);
  }
  requireUniqueNames(hospitals, 'organisation');

  const groupGrid = readSingleSheet(PRIVATE_GROUPS_FILE, PRIVATE_GROUP_HEADERS, 'Private-group workbook');
  const privateGroups = [];
  for (let index = 1; index < groupGrid.length; index += 1) {
    const values = PRIVATE_GROUP_HEADERS.map((_, column) => String(groupGrid[index]?.[column] ?? '').trim());
    if (values.every((value) => !value)) continue;
    const missing = PRIVATE_GROUP_HEADERS.filter((_, column) => !values[column]);
    if (missing.length) fail(`Private-group workbook row ${index + 1} is missing mandatory value(s): ${missing.join(', ')}.`);
    privateGroups.push({
      sourceRow: index + 1,
      name: values[0],
      category: values[1],
      region: values[2],
      country: values[3],
      townCity: values[4],
      postcode: values[5],
    });
  }
  if (privateGroups.length !== EXPECTED_PRIVATE_GROUP_ROWS) {
    fail(`Private-group workbook must contain ${EXPECTED_PRIVATE_GROUP_ROWS} data rows; found ${privateGroups.length}.`);
  }
  const privateByNorm = requireUniqueNames(privateGroups, 'private group');

  const privateParents = new Set(privateGroups.map((row) => normName(row.name)));
  for (const hospital of hospitals) {
    if (hospital.category === 'Private hospital or imaging centre' && !privateParents.has(normName(hospital.parentName))) {
      fail(`Hospital workbook row ${hospital.sourceRow} has private parent "${hospital.parentName}", which is missing from the private-group workbook.`);
    }
  }

  return { hospitals, privateGroups, privateByNorm };
}

async function fetchAll(supabase, table, columns) {
  const result = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('tenant_id', TENANT_ID)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) fail(`Could not read ${table}: ${error.message}`);
    result.push(...(data || []));
    if ((data || []).length < pageSize) return result;
  }
}

async function loadDefinitions(supabase, entityScope) {
  const { data, error } = await supabase
    .from('preference_field')
    .select('id, tenant_id, name, label, field_type, options, display_order, is_active, entity_scope')
    .eq('tenant_id', TENANT_ID)
    .eq('entity_scope', entityScope)
    .order('display_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) fail(`Could not load ${entityScope} preference fields: ${error.message}`);
  return data || [];
}

function auditFields(rows, definitions, specs, entityScope) {
  const byName = new Map();
  for (const field of definitions) {
    if (byName.has(field.name)) fail(`More than one ${entityScope} preference field is named "${field.name}". Resolve the ambiguity before importing.`);
    byName.set(field.name, field);
  }

  return specs.map((spec, index) => {
    const field = byName.get(spec.name);
    if (!field) {
      if (!spec.createIfMissing) {
        fail(`Required mapping missing: "${spec.header}" needs active ${entityScope} field "${spec.label}" (${spec.name}).`);
      }
      return { ...spec, id: null, pendingCreate: true, displayOrder: index };
    }
    if (!field.is_active || field.label !== spec.label || field.field_type !== spec.fieldType) {
      fail(`Invalid mapping for "${spec.header}": ${entityScope} field "${spec.name}" must be active, labelled "${spec.label}", and be type "${spec.fieldType}".`);
    }
    const desiredValues = [...new Set(rows.map((row) => rowValue(row, spec)).filter(Boolean))].sort();
    const currentOptions = spec.fieldType === 'dropdown' ? valuesFromOptions(field.options) : [];
    const missingOptions = spec.fieldType === 'dropdown'
      ? desiredValues.filter((value) => !currentOptions.includes(value))
      : [];
    return {
      ...spec,
      id: field.id,
      pendingCreate: false,
      displayOrder: field.display_order,
      currentOptions,
      missingOptions,
    };
  });
}

function buildGroupMap(groups, sourceParents) {
  const map = new Map();
  const duplicateNames = new Map();
  for (const group of groups) {
    const key = normName(group.name);
    if (!key) continue;
    if (map.has(key)) {
      duplicateNames.set(key, [...(duplicateNames.get(key) || [map.get(key)]), group]);
    } else {
      map.set(key, group);
    }
  }
  for (const [key, duplicates] of duplicateNames) {
    if (sourceParents.has(key)) {
      fail(`Existing BNMS groups ${duplicates.map((group) => `"${group.name}" (${group.id})`).join(' and ')} all match source parent "${sourceParents.get(key).name}". Resolve duplicate names before importing.`);
    }
  }
  return map;
}

function auditParents(hospitals, privateGroups, groups) {
  const expectedParents = new Map();
  for (const hospital of hospitals) {
    const key = normName(hospital.parentName);
    if (!expectedParents.has(key)) expectedParents.set(key, { name: hospital.parentName, sourceRow: hospital.sourceRow });
  }
  const groupMap = buildGroupMap(groups, expectedParents);
  const privateByNorm = new Map(privateGroups.map((row) => [normName(row.name), row]));
  const unresolved = [];
  for (const [key, parent] of expectedParents) {
    if (!groupMap.has(key) && !privateByNorm.has(key)) unresolved.push(parent);
  }
  if (unresolved.length) {
    fail(`Unresolved source parent group(s): ${unresolved.map((row) => `"${row.name}" (hospital row ${row.sourceRow})`).join(', ')}.`);
  }
  return { expectedParents, groupMap };
}

function preferenceKey(parentId, fieldId) {
  return `${parentId}::${fieldId}`;
}

async function loadPreferenceValues(supabase, table, parentColumn, parentIds, fieldIds) {
  const values = new Map();
  if (!parentIds.length || !fieldIds.length) return values;
  for (let index = 0; index < parentIds.length; index += 200) {
    const ids = parentIds.slice(index, index + 200);
    const pageSize = 500;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from(table)
        .select(`id, ${parentColumn}, field_id, value`)
        .in(parentColumn, ids)
        .in('field_id', fieldIds)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) fail(`Could not read ${table}: ${error.message}`);
      for (const value of data || []) {
        const key = preferenceKey(value[parentColumn], value.field_id);
        if (values.has(key)) fail(`Duplicate stored custom value for ${table} ${key}. Resolve it before importing.`);
        values.set(key, value);
      }
      if ((data || []).length < pageSize) break;
    }
  }
  return values;
}

function createFieldPayload(spec, rows, entityScope) {
  const values = [...new Set(rows.map((row) => rowValue(row, spec)).filter(Boolean))].sort();
  return {
    tenant_id: TENANT_ID,
    entity_scope: entityScope,
    name: spec.name,
    label: spec.label,
    field_type: spec.fieldType,
    options: spec.fieldType === 'dropdown' ? optionObjects(values) : null,
    is_active: true,
    is_required: false,
    display_order: spec.displayOrder,
  };
}

async function applyFieldChanges(supabase, fieldAudit, rows, entityScope) {
  for (const field of fieldAudit) {
    if (field.pendingCreate) {
      const { data, error } = await supabase
        .from('preference_field')
        .insert(createFieldPayload(field, rows, entityScope))
        .select('id, tenant_id, name, label, field_type, options, display_order, is_active, entity_scope')
        .single();
      if (error || !data?.id) fail(`Could not create ${entityScope} field "${field.label}": ${error?.message || 'no id returned'}.`);
      console.log(`  + Created ${entityScope} field: ${field.label}`);
      continue;
    }
    if (field.missingOptions?.length) {
      const options = optionObjects([...field.currentOptions, ...field.missingOptions]);
      const { data, error } = await supabase
        .from('preference_field')
        .update({ options })
        .eq('id', field.id)
        .select('id, options')
        .single();
      if (error || !data?.id) fail(`Could not add ${entityScope} option(s) to "${field.label}": ${error?.message || 'no field returned'}.`);
      const persisted = new Set(valuesFromOptions(data.options));
      const notPersisted = field.missingOptions.filter((value) => !persisted.has(value));
      if (notPersisted.length) fail(`Dropdown options did not persist for "${field.label}": ${notPersisted.join(', ')}.`);
      console.log(`  ~ Added ${field.missingOptions.length} option(s) to ${entityScope} field: ${field.label}`);
    }
  }
}

function printAudit(hospitals, privateGroups, orgFields, groupFields, initialPlan) {
  console.log('\n--- Approved source-to-destination mapping ---');
  console.log('  Hospital / organisation name -> Organization.name (core)');
  console.log('  Principal parent organisation -> Organization.organization_group_id (resolved parent group)');
  orgFields.forEach((field) => {
    const destination = field.pendingCreate ? `${field.label} [NEW ${field.fieldType} field]` : `${field.label} (${field.fieldType})`;
    console.log(`  Hospital ${field.header} -> Organization custom field ${destination}`);
  });
  console.log('  Private Parent organisation -> Organization Group.name (core)');
  groupFields.forEach((field) => console.log(`  Private ${field.header} -> Organization Group custom field ${field.label} (${field.fieldType})`));
  console.log(`  Yorkshire canonicalisation -> "${YORKSHIRE_SOURCE_VALUE}" becomes "${YORKSHIRE_DESTINATION_VALUE}"`);
  console.log('  Private workbook has no Parent code column -> no group parent code is created or changed.');

  console.log('\n--- Approved field-definition changes ---');
  const changes = [...orgFields.map((field) => ({ field, scope: 'organization' })), ...groupFields.map((field) => ({ field, scope: 'organization_group' }))];
  const pending = changes.filter(({ field }) => field.pendingCreate);
  const optionChanges = changes.filter(({ field }) => field.missingOptions?.length);
  if (!pending.length && !optionChanges.length) console.log('  None.');
  pending.forEach(({ field, scope }) => console.log(`  CREATE ${scope} field ${field.label} (${field.fieldType})`));
  optionChanges.forEach(({ field, scope }) => console.log(`  ADD ${scope} ${field.label} option(s): ${field.missingOptions.join(', ')}`));

  console.log('\n--- Validated import plan ---');
  console.log(`  Hospital workbook rows:       ${hospitals.length}`);
  console.log(`  Private-group workbook rows:  ${privateGroups.length}`);
  console.log(`  Private hospital relationships:${hospitals.filter((row) => row.category === 'Private hospital or imaging centre').length}`);
  console.log(`  Parent groups resolved:       ${initialPlan.expectedParents.size}/${initialPlan.expectedParents.size}`);
  console.log(`  Private groups to create:     ${initialPlan.privateCreates}`);
  console.log(`  Private groups already exist: ${initialPlan.privateExisting}`);
  console.log(`  Organisations to create:      ${initialPlan.orgCreates}`);
  console.log(`  Organisations already exist:  ${initialPlan.orgExisting}`);
}

function planImport(hospitals, privateGroups, groups, organizations) {
  const { expectedParents, groupMap } = auditParents(hospitals, privateGroups, groups);
  const organizationSourceNames = new Map(hospitals.map((row) => [normName(row.name), row]));
  const organizationMap = new Map();
  const duplicateOrganizations = new Map();
  for (const organization of organizations) {
    const key = normName(organization.name);
    if (organizationMap.has(key)) duplicateOrganizations.set(key, [...(duplicateOrganizations.get(key) || [organizationMap.get(key)]), organization]);
    else organizationMap.set(key, organization);
  }
  for (const [key, duplicates] of duplicateOrganizations) {
    if (organizationSourceNames.has(key)) {
      const source = organizationSourceNames.get(key);
      fail(`Existing BNMS organisations ${duplicates.map((organization) => `"${organization.name}" (${organization.id})`).join(' and ')} all match hospital row ${source.sourceRow}. Resolve duplicate names before importing.`);
    }
  }
  return {
    expectedParents,
    groupMap,
    organizationMap,
    privateCreates: privateGroups.filter((row) => !groupMap.has(normName(row.name))).length,
    privateExisting: privateGroups.filter((row) => groupMap.has(normName(row.name))).length,
    orgCreates: hospitals.filter((row) => !organizationMap.has(normName(row.name))).length,
    orgExisting: hospitals.filter((row) => organizationMap.has(normName(row.name))).length,
  };
}

async function upsertValue(supabase, table, parentColumn, parentId, fieldId, desired, existing) {
  if (!desired) return 'blank';
  if (existing?.value === desired) return 'unchanged';
  if (existing) {
    const { data, error } = await supabase
      .from(table)
      .update({ value: desired, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select(`id, ${parentColumn}, field_id, value`)
      .single();
    if (error || !data?.id || data.value !== desired) fail(`Could not update ${table} custom value: ${error?.message || 'unexpected response'}.`);
    return 'update';
  }
  const { data, error } = await supabase
    .from(table)
    .insert({ tenant_id: TENANT_ID, [parentColumn]: parentId, field_id: fieldId, value: desired })
    .select(`id, ${parentColumn}, field_id, value`)
    .single();
  if (error || !data?.id || data.value !== desired) fail(`Could not create ${table} custom value: ${error?.message || 'unexpected response'}.`);
  return 'create';
}

async function createOrganizationsInBatches(supabase, rows, groupMap, organizationMap, result) {
  const missing = rows.filter((row) => !organizationMap.has(normName(row.name)));
  for (let index = 0; index < missing.length; index += 200) {
    const batch = missing.slice(index, index + 200);
    const payload = batch.map((row) => {
      const group = groupMap.get(normName(row.parentName));
      if (!group?.id) fail(`Hospital row ${row.sourceRow}, "${row.name}": resolved parent "${row.parentName}" has no id.`);
      return { tenant_id: TENANT_ID, name: row.name, organization_group_id: group.id };
    });
    const { data, error } = await supabase
      .from('organization')
      .insert(payload)
      .select('id, tenant_id, name, organization_group_id');
    if (error || !data || data.length !== batch.length) {
      fail(`Could not create hospital organization batch beginning at source row ${batch[0].sourceRow}: ${error?.message || `expected ${batch.length} rows, received ${data?.length ?? 0}`}.`);
    }
    const created = new Map(data.map((organization) => [normName(organization.name), organization]));
    for (const row of batch) {
      const organization = created.get(normName(row.name));
      const expectedGroup = groupMap.get(normName(row.parentName));
      if (!organization?.id || organization.organization_group_id !== expectedGroup.id) {
        fail(`Hospital row ${row.sourceRow}, "${row.name}": creation response did not return its expected parent link.`);
      }
      organizationMap.set(normName(row.name), organization);
      result.organizations.creates += 1;
      result.organizations.links += 1;
    }
  }
}

async function upsertOrganizationValuesInBatches(
  supabase,
  rows,
  fields,
  organizationMap,
  existingValues,
  counters,
  changedOrganizationIds,
) {
  const planned = [];
  const clears = [];
  for (const row of rows) {
    const organization = organizationMap.get(normName(row.name));
    if (!organization?.id) fail(`Hospital row ${row.sourceRow}, "${row.name}": no organization id available for custom values.`);
    for (const field of fields) {
      const desired = rowValue(row, field);
      if (!desired) {
        const existing = existingValues.get(preferenceKey(organization.id, field.id));
        if (existing) {
          clears.push({ row, field, organization, existing });
          changedOrganizationIds.add(organization.id);
        } else {
          counters.blanks += 1;
        }
        continue;
      }
      const existing = existingValues.get(preferenceKey(organization.id, field.id));
      if (existing?.value === desired) {
        counters.unchanged += 1;
        continue;
      }
      planned.push({
        row,
        field,
        action: existing ? 'update' : 'create',
        payload: {
          organization_id: organization.id,
          field_id: field.id,
          value: desired,
          updated_at: new Date().toISOString(),
        },
      });
      changedOrganizationIds.add(organization.id);
    }
  }
  for (let index = 0; index < planned.length; index += 250) {
    const batch = planned.slice(index, index + 250);
    const { data, error } = await supabase
      .from('organization_preference_value')
      .upsert(batch.map((entry) => entry.payload), {
        onConflict: 'organization_id,field_id',
        ignoreDuplicates: false,
      })
      .select('id, organization_id, field_id, value');
    if (error || !data || data.length !== batch.length) {
      fail(`Could not upsert organization custom-value batch beginning at hospital row ${batch[0].row.sourceRow}: ${error?.message || `expected ${batch.length} rows, received ${data?.length ?? 0}`}.`);
    }
    const returned = new Map(data.map((value) => [preferenceKey(value.organization_id, value.field_id), value]));
    for (const entry of batch) {
      const value = returned.get(preferenceKey(entry.payload.organization_id, entry.payload.field_id));
      if (!value?.id || value.value !== entry.payload.value) {
        fail(`Hospital row ${entry.row.sourceRow}, "${entry.row.name}", ${entry.field.label}: custom-value upsert did not return the expected value.`);
      }
      countAction(counters, entry.action);
    }
  }
  for (let index = 0; index < clears.length; index += 200) {
    const batch = clears.slice(index, index + 200);
    const ids = batch.map((entry) => entry.existing.id);
    const { data, error } = await supabase
      .from('organization_preference_value')
      .delete()
      .in('id', ids)
      .select('id, organization_id, field_id, value');
    if (error || !data || data.length !== batch.length) {
      fail(`Could not clear organization custom-value batch beginning at hospital row ${batch[0].row.sourceRow}: ${error?.message || `expected ${batch.length} rows, received ${data?.length ?? 0}`}.`);
    }
    const returnedIds = new Set(data.map((value) => value.id));
    for (const entry of batch) {
      if (!returnedIds.has(entry.existing.id)) {
        fail(`Hospital row ${entry.row.sourceRow}, "${entry.row.name}", ${entry.field.label}: clear did not return the deleted custom value.`);
      }
      counters.updates += 1;
      counters.clears += 1;
    }
  }
}

function emptyCounters() {
  return { creates: 0, updates: 0, unchanged: 0, blanks: 0, clears: 0 };
}

function countAction(counters, action) {
  if (action === 'create') counters.creates += 1;
  else if (action === 'update') counters.updates += 1;
  else if (action === 'unchanged') counters.unchanged += 1;
  else if (action === 'blank') counters.blanks += 1;
}

async function applyImport(supabase, hospitals, privateGroups, orgFields, groupFields) {
  const groups = await fetchAll(supabase, 'organization_group', 'id, tenant_id, name');
  const organizations = await fetchAll(supabase, 'organization', 'id, tenant_id, name, organization_group_id');
  const plan = planImport(hospitals, privateGroups, groups, organizations);
  const groupValues = await loadPreferenceValues(
    supabase,
    'organization_group_preference_value',
    'organization_group_id',
    privateGroups.map((row) => plan.groupMap.get(normName(row.name))?.id).filter(Boolean),
    groupFields.map((field) => field.id),
  );
  const orgValues = await loadPreferenceValues(
    supabase,
    'organization_preference_value',
    'organization_id',
    hospitals.map((row) => plan.organizationMap.get(normName(row.name))?.id).filter(Boolean),
    orgFields.map((field) => field.id),
  );
  const result = {
    groups: { creates: 0, updates: 0, unchanged: 0 },
    organizations: { creates: 0, updates: 0, unchanged: 0, links: 0 },
    groupValues: emptyCounters(),
    organizationValues: emptyCounters(),
  };
  const existingSourceOrganizationIds = new Set(
    hospitals.map((row) => plan.organizationMap.get(normName(row.name))?.id).filter(Boolean),
  );
  const changedExistingOrganizationIds = new Set();

  for (const row of privateGroups) {
    let group = plan.groupMap.get(normName(row.name));
    const wasCreated = !group;
    if (!group) {
      const { data, error } = await supabase
        .from('organization_group')
        .insert({ tenant_id: TENANT_ID, name: row.name })
        .select('id, tenant_id, name')
        .single();
      if (error || !data?.id) fail(`Private-group row ${row.sourceRow}, "${row.name}": could not create group: ${error?.message || 'no id returned'}.`);
      group = data;
      plan.groupMap.set(normName(row.name), group);
      result.groups.creates += 1;
    }
    let changed = wasCreated;
    for (const field of groupFields) {
      const action = await upsertValue(
        supabase,
        'organization_group_preference_value',
        'organization_group_id',
        group.id,
        field.id,
        rowValue(row, field),
        groupValues.get(preferenceKey(group.id, field.id)),
      );
      countAction(result.groupValues, action);
      if (action === 'create' || action === 'update') changed = true;
    }
    if (!wasCreated) {
      if (changed) result.groups.updates += 1;
      else result.groups.unchanged += 1;
    }
  }

  // Existing source-controlled parent links are updated individually so each
  // response can be tied to its exact workbook row. New organisations are
  // inserted in checked batches below.
  for (const row of hospitals) {
    const expectedGroup = plan.groupMap.get(normName(row.parentName));
    if (!expectedGroup?.id) fail(`Hospital row ${row.sourceRow}, "${row.name}": resolved parent "${row.parentName}" has no id.`);
    const organization = plan.organizationMap.get(normName(row.name));
    if (organization && organization.organization_group_id !== expectedGroup.id) {
      const { data, error } = await supabase
        .from('organization')
        .update({ organization_group_id: expectedGroup.id, updated_at: new Date().toISOString() })
        .eq('id', organization.id)
        .select('id, organization_group_id')
        .single();
      if (error || data?.organization_group_id !== expectedGroup.id) {
        fail(`Hospital row ${row.sourceRow}, "${row.name}": could not set parent "${row.parentName}": ${error?.message || 'unexpected response'}.`);
      }
      plan.organizationMap.set(normName(row.name), { ...organization, organization_group_id: data.organization_group_id });
      result.organizations.links += 1;
      changedExistingOrganizationIds.add(organization.id);
    }
  }
  await createOrganizationsInBatches(supabase, hospitals, plan.groupMap, plan.organizationMap, result);
  await upsertOrganizationValuesInBatches(
    supabase,
    hospitals,
    orgFields,
    plan.organizationMap,
    orgValues,
    result.organizationValues,
    changedExistingOrganizationIds,
  );
  result.organizations.updates = [...changedExistingOrganizationIds]
    .filter((id) => existingSourceOrganizationIds.has(id))
    .length;
  result.organizations.unchanged = existingSourceOrganizationIds.size - result.organizations.updates;
  return result;
}

function findDuplicateSourceMatches(records, sourceRows) {
  const wanted = new Set(sourceRows.map((row) => normName(row.name)));
  const matches = new Map();
  for (const record of records) {
    const key = normName(record.name);
    if (!wanted.has(key)) continue;
    matches.set(key, [...(matches.get(key) || []), record]);
  }
  return [...matches.entries()].filter(([, values]) => values.length > 1);
}

async function verifyImport(supabase, hospitals, privateGroups, orgFields, groupFields) {
  const groups = await fetchAll(supabase, 'organization_group', 'id, tenant_id, name');
  const organizations = await fetchAll(supabase, 'organization', 'id, tenant_id, name, organization_group_id');
  const expectedParents = new Map();
  for (const row of hospitals) {
    if (!expectedParents.has(normName(row.parentName))) expectedParents.set(normName(row.parentName), { name: row.parentName, sourceRow: row.sourceRow });
  }
  const groupMap = buildGroupMap(groups, expectedParents);
  const organizationSourceNames = new Map(hospitals.map((row) => [normName(row.name), row]));
  const organizationMap = new Map();
  for (const organization of organizations) {
    const key = normName(organization.name);
    if (!organizationMap.has(key)) organizationMap.set(key, organization);
  }
  const groupDuplicates = findDuplicateSourceMatches(groups, privateGroups);
  const organizationDuplicates = findDuplicateSourceMatches(organizations, hospitals);
  const privateGroupEntries = privateGroups.map((row) => ({ row, group: groupMap.get(normName(row.name)) }));
  const hospitalEntries = hospitals.map((row) => ({ row, organization: organizationMap.get(normName(row.name)) }));
  const groupValues = await loadPreferenceValues(
    supabase,
    'organization_group_preference_value',
    'organization_group_id',
    privateGroupEntries.map((entry) => entry.group?.id).filter(Boolean),
    groupFields.map((field) => field.id),
  );
  const orgValues = await loadPreferenceValues(
    supabase,
    'organization_preference_value',
    'organization_id',
    hospitalEntries.map((entry) => entry.organization?.id).filter(Boolean),
    orgFields.map((field) => field.id),
  );

  const exceptions = [];
  for (const { row, group } of privateGroupEntries) {
    if (!group) {
      exceptions.push(`Private-group row ${row.sourceRow}: missing "${row.name}".`);
      continue;
    }
    for (const field of groupFields) {
      const stored = groupValues.get(preferenceKey(group.id, field.id));
      const expected = rowValue(row, field);
      if (!stored || stored.value !== expected) exceptions.push(`Private-group row ${row.sourceRow}, "${row.name}", ${field.label}: expected "${expected}", got "${stored?.value ?? '(missing)'}".`);
    }
  }
  for (const { row, organization } of hospitalEntries) {
    if (!organization) {
      exceptions.push(`Hospital row ${row.sourceRow}: missing "${row.name}".`);
      continue;
    }
    const expectedGroup = groupMap.get(normName(row.parentName));
    if (!expectedGroup) {
      exceptions.push(`Hospital row ${row.sourceRow}, "${row.name}": unresolved parent "${row.parentName}".`);
    } else if (organization.organization_group_id !== expectedGroup.id) {
      exceptions.push(`Hospital row ${row.sourceRow}, "${row.name}": expected parent "${row.parentName}", got group id "${organization.organization_group_id ?? '(none)'}".`);
    }
    for (const field of orgFields) {
      const expected = rowValue(row, field);
      const stored = orgValues.get(preferenceKey(organization.id, field.id));
      if (!expected) {
        if (stored && String(stored.value ?? '') !== '') {
          exceptions.push(`Hospital row ${row.sourceRow}, "${row.name}", ${field.label}: expected blank, got "${stored.value}".`);
        }
      } else if (!stored || stored.value !== expected) {
        exceptions.push(`Hospital row ${row.sourceRow}, "${row.name}", ${field.label}: expected "${expected}", got "${stored?.value ?? '(missing)'}".`);
      }
    }
  }

  console.log('\n--- Post-import verification ---');
  console.log(`  Private groups found:       ${privateGroupEntries.filter((entry) => entry.group).length}/${privateGroups.length}`);
  console.log(`  Source organisations found: ${hospitalEntries.filter((entry) => entry.organization).length}/${hospitals.length}`);
  console.log(`  Parent groups resolved:     ${expectedParents.size}/${expectedParents.size}`);
  console.log(`  Incorrect/missing links:    ${exceptions.filter((line) => line.includes('expected parent') || line.includes('unresolved parent')).length}`);
  console.log(`  Duplicate source group names:${groupDuplicates.length}`);
  console.log(`  Duplicate source org names: ${organizationDuplicates.length}`);
  console.log(`  Custom-value exceptions:    ${exceptions.filter((line) => !line.includes('expected parent') && !line.includes('unresolved parent') && !line.includes(': missing')).length}`);

  groupDuplicates.forEach(([key, records]) => exceptions.push(`Duplicate normalized group "${key}": ${records.map((record) => record.id).join(', ')}.`));
  organizationDuplicates.forEach(([key, records]) => exceptions.push(`Duplicate normalized organisation "${key}": ${records.map((record) => record.id).join(', ')}.`));
  if (exceptions.length) {
    console.error('\nVerification exceptions:');
    exceptions.slice(0, 50).forEach((exception) => console.error(`  - ${exception}`));
    if (exceptions.length > 50) console.error(`  - ... ${exceptions.length - 50} additional exception(s)`);
    fail(`Verification failed with ${exceptions.length} exception(s).`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply')) fail('Only --apply is supported. With no flag, this importer performs a dry run.');
  const apply = args.includes('--apply');
  console.log('\n=== Import BNMS hospital organisations ===');
  console.log(`Tenant: ${TENANT_ID} (BNMS)`);
  console.log(`Mode:   ${apply ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);

  const { hospitals, privateGroups } = readSources();
  const supabase = getSupabase();
  const [organizationDefinitions, groupDefinitions, groups, organizations] = await Promise.all([
    loadDefinitions(supabase, 'organization'),
    loadDefinitions(supabase, 'organization_group'),
    fetchAll(supabase, 'organization_group', 'id, tenant_id, name'),
    fetchAll(supabase, 'organization', 'id, tenant_id, name, organization_group_id'),
  ]);
  const orgFields = auditFields(hospitals, organizationDefinitions, ORGANISATION_FIELD_SPECS, 'organization');
  const groupFields = auditFields(privateGroups, groupDefinitions, GROUP_FIELD_SPECS, 'organization_group');
  const initialPlan = planImport(hospitals, privateGroups, groups, organizations);
  printAudit(hospitals, privateGroups, orgFields, groupFields, initialPlan);

  if (!apply) {
    console.log('\n=== DRY RUN complete ===');
    console.log('No database rows, options, or field definitions were modified. Re-run with --apply to import.\n');
    return;
  }

  console.log('\n--- Applying approved field-definition changes before organisation writes ---');
  await applyFieldChanges(supabase, groupFields, privateGroups, 'organization_group');
  await applyFieldChanges(supabase, orgFields, hospitals, 'organization');

  // Re-audit every persisted mapping and option before creating any group or organisation row.
  const [persistedOrgDefinitions, persistedGroupDefinitions] = await Promise.all([
    loadDefinitions(supabase, 'organization'),
    loadDefinitions(supabase, 'organization_group'),
  ]);
  const persistedOrgFields = auditFields(hospitals, persistedOrgDefinitions, ORGANISATION_FIELD_SPECS, 'organization');
  const persistedGroupFields = auditFields(privateGroups, persistedGroupDefinitions, GROUP_FIELD_SPECS, 'organization_group');
  const incomplete = [...persistedOrgFields, ...persistedGroupFields]
    .filter((field) => field.pendingCreate || field.missingOptions?.length);
  if (incomplete.length) fail(`Field-definition audit remains unresolved: ${incomplete.map((field) => field.label).join(', ')}.`);

  console.log('\n--- Applying private parent groups and organisations ---');
  const result = await applyImport(supabase, hospitals, privateGroups, persistedOrgFields, persistedGroupFields);
  console.log('\n=== APPLY summary ===');
  console.log(`  Groups created/updated/unchanged:        ${result.groups.creates}/${result.groups.updates}/${result.groups.unchanged}`);
  console.log(`  Organisations created/updated/unchanged: ${result.organizations.creates}/${result.organizations.updates}/${result.organizations.unchanged}`);
  console.log(`  Organisation parent links set:           ${result.organizations.links}`);
  console.log(`  Group custom values create/update/same:  ${result.groupValues.creates}/${result.groupValues.updates}/${result.groupValues.unchanged}`);
  console.log(`  Org custom values create/update/same:    ${result.organizationValues.creates}/${result.organizationValues.updates}/${result.organizationValues.unchanged}`);
  console.log(`  Optional blank values cleared/unchanged: ${result.organizationValues.clears}/${result.organizationValues.blanks}`);

  await verifyImport(supabase, hospitals, privateGroups, persistedOrgFields, persistedGroupFields);
  console.log('\nImport and verification completed successfully.\n');
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exit(1);
});