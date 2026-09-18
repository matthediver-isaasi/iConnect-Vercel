import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { validateCustomObjectRecordData } from '../../api/_lib/customObjectDomain.js';

export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const OBJECT_ID = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
export const PHONE_ID = '2126d5c5-ee9e-4ef4-b8f6-e584c5523b76';
export const PROJECT = 'lvmzliemqnieeoruhkik';
export const KEYS = Object.freeze([
  'address_line_1',
  'address_line2',
  'address_line_3',
  'address_town_city',
  'address_county',
  'address_post_code',
  'phone_number',
]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_FILE = path.join(
  ROOT,
  'attached_assets',
  'Department_addresses_17.09.26_1789712397406.xlsx',
);
const SOURCE_DIGEST = 'acfc52ca8baf88c09ac76a688d05ba5c98ba1ee4b44ac766f8f900bd9b78225f';
const SHEET = 'NM departments';
const HEADERS = Object.freeze([
  'Organisation',
  'Organisation department: Name (Departments)',
  'Organisation department: Address line 1 (Departments)',
  'Organisation department: Address line 2 (Departments)',
  'Organisation department: Address line 3 (Departments)',
  'Organisation department: Address Town/City (Departments)',
  'Organisation department: Address county (Departments)',
  'Organisation department: Address post code (Departments)',
  'Organisation department: Phone number (Departments)',
  'BNMS Region',
]);
const SOURCE_ROWS = 301;
const SOURCE_PAIRS = 298;

function fail(message) {
  throw new Error(message);
}

function canonical(value) {
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function stable(value) {
  return JSON.stringify(canonical(value));
}

export function digest(value) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function normalise(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u0096\u2010-\u2015-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-GB');
}

function sourceCell(value) {
  return String(value ?? '').trim();
}

function pairKey(organisationName, departmentName) {
  return `${normalise(organisationName)}::${normalise(departmentName)}`;
}

export function parseDepartmentLabel(value, sourceRow) {
  const colon = value.indexOf(':');
  if (colon < 1 || colon !== value.lastIndexOf(':')) {
    fail(`Source row ${sourceRow} Department name must contain exactly one colon.`);
  }
  const left = value.slice(0, colon).trim();
  const right = value.slice(colon + 1).trim();
  if (!left || left !== right) {
    fail(`Source row ${sourceRow} Department name must repeat identical text on both sides of the colon.`);
  }
  return left;
}

export function assertIdenticalDuplicate(first, values, sourceRow) {
  if (first && KEYS.some((fieldKey) => first.values[fieldKey] !== values[fieldKey])) {
    fail(`Repeated Organisation/Department pair at rows ${first.sourceRow} and ${sourceRow} has different address or phone values.`);
  }
}

export function readSource() {
  const bytes = fs.readFileSync(SOURCE_FILE);
  const actualDigest = createHash('sha256').update(bytes).digest('hex');
  if (actualDigest !== SOURCE_DIGEST) {
    fail(`Source workbook digest changed: expected ${SOURCE_DIGEST}, found ${actualDigest}.`);
  }
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== SHEET) {
    fail(`Workbook must contain only the "${SHEET}" sheet.`);
  }
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[SHEET], {
    header: 1,
    defval: null,
    raw: false,
  });
  const headers = (grid[0] || []).map(sourceCell);
  if (headers.length !== HEADERS.length
    || headers.some((header, index) => header !== HEADERS[index])) {
    fail(`Source headers must be exactly: ${HEADERS.join(' | ')}.`);
  }
  const populated = grid.slice(1)
    .map((row, index) => ({ row, sourceRow: index + 2 }))
    .filter(({ row }) => row.some((cell) => sourceCell(cell)));
  if (populated.length !== SOURCE_ROWS) {
    fail(`Source must contain exactly ${SOURCE_ROWS} populated rows; found ${populated.length}.`);
  }

  const firstByPair = new Map();
  const consolidated = new Map();
  const rows = populated.map(({ row: raw, sourceRow }) => {
    if (raw.length > HEADERS.length && raw.slice(HEADERS.length).some((cell) => sourceCell(cell))) {
      fail(`Source row ${sourceRow} contains data beyond the ten approved columns.`);
    }
    const cells = HEADERS.map((_, column) => sourceCell(raw[column]));
    if (!cells[0] || !cells[1]) {
      fail(`Source row ${sourceRow} must contain Organisation and Department names.`);
    }
    const left = parseDepartmentLabel(cells[1], sourceRow);
    const key = pairKey(cells[0], left);
    const values = Object.fromEntries(KEYS.map((fieldKey, offset) => [
      fieldKey,
      cells[offset + 2] || null,
    ]));
    const first = firstByPair.get(key);
    assertIdenticalDuplicate(first, values, sourceRow);
    const duplicateOf = first?.sourceRow ?? null;
    const row = {
      sourceRow,
      organisationName: cells[0],
      departmentName: left,
      region: cells[9] || null,
      values,
      duplicateOf,
      pairKey: key,
    };
    if (!first) {
      firstByPair.set(key, row);
      consolidated.set(key, {
        ...row,
        sourceRows: [sourceRow],
      });
    } else {
      consolidated.get(key).sourceRows.push(sourceRow);
    }
    return row;
  });
  if (consolidated.size !== SOURCE_PAIRS) {
    fail(`Source must contain exactly ${SOURCE_PAIRS} unique Organisation/Department pairs; found ${consolidated.size}.`);
  }
  return {
    file: SOURCE_FILE,
    fileDigest: actualDigest,
    sheet: SHEET,
    headers: [...HEADERS],
    rows,
    items: [...consolidated.values()],
    pairCount: consolidated.size,
  };
}

function isArchived(row) {
  return Boolean(row?.archived_at);
}

function isInactiveOrganisation(row) {
  return isArchived(row)
    || ['archived', 'inactive', 'deleted'].includes(String(row?.status || '').toLowerCase());
}

function fieldDiffs(before, after) {
  return KEYS.filter((key) => stable(before?.[key] ?? null) !== stable(after?.[key] ?? null))
    .map((key) => ({ key, before: before?.[key] ?? null, after: after?.[key] ?? null }));
}

export function resolveApprovedMatch(matches, approval) {
  if (!approval) return matches;
  if (stable(matches.map(row => row.id).sort()) !== stable([...approval.candidateIds].sort())) {
    throw new Error('Approved candidate set changed; a fresh confirmation is required.');
  }
  const selected = matches.find(row => row.id === approval.selectedId);
  if (!selected || !String(selected.created_at).startsWith('2026-08-27')) {
    throw new Error('Approved original 27 August record is unavailable.');
  }
  return [selected];
}

export function makePlan(source, state, approvedResolutions = {}) {
  const blockers = [];
  const block = (message) => {
    if (!blockers.includes(message)) blockers.push(message);
  };
  const tenant = state?.tenant;
  if (tenant?.id !== TENANT_ID || !/^(BNMS|British Nuclear Medicine Society)$/i.test(String(tenant?.name || '').trim())) {
    block(`Pinned BNMS tenant ${TENANT_ID} was not resolved.`);
  }
  const object = state?.object;
  if (object?.id !== OBJECT_ID || object?.tenant_id !== TENANT_ID
    || object?.object_key !== 'org_department' || object?.status !== 'active'
    || isArchived(object)) {
    block(`Pinned active BNMS Organisation Department object ${OBJECT_ID} was not resolved.`);
  }

  const fields = Array.isArray(state?.fields) ? state.fields : [];
  const fieldsByKey = new Map();
  for (const field of fields) {
    if (field.tenant_id !== TENANT_ID || field.custom_object_id !== OBJECT_ID
      || field.entity_scope !== 'custom_object') {
      block(`Loaded field "${field.name || field.id || '(unknown)'}" is outside the pinned BNMS Department object.`);
    }
  }
  for (const key of KEYS) {
    const matches = fields.filter((field) => field.name === key && !isArchived(field) && field.is_active !== false);
    if (matches.length !== 1) {
      block(`Expected exactly one active "${key}" field; found ${matches.length}.`);
      continue;
    }
    const field = matches[0];
    if (key !== 'phone_number' && field.field_type !== 'text') {
      block(`Address field "${key}" must use text type, not "${field.field_type}".`);
    }
    fieldsByKey.set(key, field);
  }
  const phoneField = fieldsByKey.get('phone_number') || null;
  if (phoneField && phoneField.id !== PHONE_ID) {
    block(`Phone field must use pinned id ${PHONE_ID}.`);
  }
  if (phoneField && !['number', 'text'].includes(phoneField.field_type)) {
    block(`Pinned Phone number field must currently be number or text, not "${phoneField.field_type}".`);
  }
  const phoneChange = phoneField ? {
    required: phoneField.field_type === 'number',
    fieldId: PHONE_ID,
    from: phoneField.field_type,
    to: 'text',
  } : null;

  const organisations = Array.isArray(state?.organisations) ? state.organisations : [];
  const records = Array.isArray(state?.records) ? state.records : [];
  const definitions = Array.isArray(state?.definitions) ? state.definitions : [];
  const edges = Array.isArray(state?.edges) ? state.edges : [];
  for (const row of [...organisations, ...records, ...definitions, ...edges]) {
    if (row?.tenant_id !== TENANT_ID) block(`Destination state contains foreign-tenant row ${row?.id || '(unknown)'}.`);
  }
  const matchingDefinitions = definitions.filter((definition) => (
    definition.source_kind === 'custom_object'
    && definition.source_custom_object_id === OBJECT_ID
    && definition.target_kind === 'organization'
    && definition.target_custom_object_id == null
    && definition.status === 'active'
    && !isArchived(definition)
  ));
  if (matchingDefinitions.length !== 1) {
    block(`Expected exactly one active Department-to-Organisation definition; found ${matchingDefinitions.length}.`);
  }
  const definition = matchingDefinitions[0];

  const sourceOrgKeys = new Set(source.items.map((item) => normalise(item.organisationName)));
  const orgByName = new Map();
  for (const organisation of organisations) {
    const key = normalise(organisation.name);
    if (!sourceOrgKeys.has(key)) continue;
    if (isInactiveOrganisation(organisation)) {
      const sourceRows = source.items.filter((item) => normalise(item.organisationName) === key)
        .flatMap((item) => item.sourceRows).join(', ');
      block(`Source row(s) ${sourceRows}: Organisation "${organisation.name}" resolves to an archived or inactive destination row ${organisation.id}.`);
      continue;
    }
    const list = orgByName.get(key) || [];
    list.push(organisation);
    orgByName.set(key, list);
  }
  for (const [key, matches] of orgByName) {
    const approval = Object.entries(approvedResolutions.organisations || {})
      .find(([name]) => normalise(name) === key)?.[1];
    if (approval) {
      try { orgByName.set(key, resolveApprovedMatch(matches, approval)); }
      catch (error) { block(`Organisation "${key}": ${error.message}`); }
      if (orgByName.get(key).length === 1) continue;
    }
    if (matches.length > 1) {
      const sourceRows = source.items.filter((item) => normalise(item.organisationName) === key)
        .flatMap((item) => item.sourceRows).join(', ');
      block(`Source row(s) ${sourceRows}: Organisation match "${key}" is ambiguous (${matches.length} active rows).`);
    }
  }

  const recordsById = new Map(records.map((record) => [record.id, record]));
  const activeOrgEdgesBySource = new Map();
  if (definition) {
    for (const edge of edges.filter((candidate) => candidate.relationship_definition_id === definition.id)) {
      if (isArchived(edge)) continue;
      const list = activeOrgEdgesBySource.get(edge.source_record_id) || [];
      list.push(edge);
      activeOrgEdgesBySource.set(edge.source_record_id, list);
    }
  }
  for (const [recordId, recordEdges] of activeOrgEdgesBySource) {
    if (recordEdges.length > 1) {
      const record = recordsById.get(recordId);
      const targetIds = new Set(recordEdges.map((edge) => edge.target_record_id));
      const organisationNames = new Set(organisations
        .filter((organisation) => targetIds.has(organisation.id))
        .map((organisation) => normalise(organisation.name)));
      const sourceRows = source.items.filter((item) => (
        normalise(item.departmentName) === normalise(record?.data?.name)
        && organisationNames.has(normalise(item.organisationName))
      )).flatMap((item) => item.sourceRows).join(', ');
      block(`${sourceRows ? `Source row(s) ${sourceRows}: ` : ''}Department record ${recordId} has ${recordEdges.length} active Organisation relationships.`);
    }
  }

  const validationFields = fields.map((field) => (
    field.id === PHONE_ID && field.field_type === 'number'
      ? { ...field, field_type: 'text' }
      : field
  ));
  const planned = [];
  const pairStatuses = new Map();
  for (const sourceItem of source.items) {
    const sourceRowsLabel = sourceItem.sourceRows.join(', ');
    const pairState = { status: 'unresolved', recordId: null, organisationId: null };
    pairStatuses.set(sourceItem.pairKey, pairState);
    const organisationMatches = orgByName.get(normalise(sourceItem.organisationName)) || [];
    if (organisationMatches.length !== 1) {
      pairState.status = 'blocked';
      if (organisationMatches.length === 0) {
        block(`Source row(s) ${sourceRowsLabel}: Organisation "${sourceItem.organisationName}" was not found.`);
      } else {
        block(`Source row(s) ${sourceRowsLabel}: Organisation "${sourceItem.organisationName}" is ambiguous (${organisationMatches.length} active rows).`);
      }
      continue;
    }
    const organisation = organisationMatches[0];
    pairState.organisationId = organisation.id;
    let candidates = [];
    const archivedCandidates = [];
    for (const record of records) {
      if (record.custom_object_id !== OBJECT_ID) continue;
      if (normalise(record.data?.name) !== normalise(sourceItem.departmentName)) continue;
      const recordEdges = edges.filter((edge) => (
        definition
        && edge.relationship_definition_id === definition.id
        && edge.source_record_id === record.id
        && edge.target_record_id === organisation.id
      ));
      if (isArchived(record) || recordEdges.some(isArchived)) archivedCandidates.push(record);
      if (!isArchived(record) && recordEdges.some((edge) => !isArchived(edge))) candidates.push(record);
    }
    if (archivedCandidates.length) {
      pairState.status = 'blocked';
      block(`Source row(s) ${sourceRowsLabel}: pair "${sourceItem.organisationName}" / "${sourceItem.departmentName}" has archived destination history.`);
    }
    const approval = approvedResolutions.departments?.[
      `${sourceItem.organisationName}::${sourceItem.departmentName}`
    ];
    if (approval) {
      try { candidates = resolveApprovedMatch(candidates, approval); }
      catch (error) {
        pairState.status = 'blocked';
        block(`Source row(s) ${sourceRowsLabel}: ${error.message}`);
        continue;
      }
    }
    if (candidates.length !== 1) {
      pairState.status = 'blocked';
      block(candidates.length
        ? `Source row(s) ${sourceRowsLabel}: pair "${sourceItem.organisationName}" / "${sourceItem.departmentName}" is ambiguous (${candidates.length} active records).`
        : `Source row(s) ${sourceRowsLabel}: Department "${sourceItem.departmentName}" was not found in Organisation "${sourceItem.organisationName}".`);
      continue;
    }
    const record = candidates[0];
    pairState.recordId = record.id;
    if (recordsById.get(record.id) !== record) block(`Department record ${record.id} is duplicated in destination state.`);
    const beforeData = structuredClone(record.data || {});
    const supplied = Object.fromEntries(
      KEYS.filter((key) => sourceItem.values[key] !== null)
        .map((key) => [key, sourceItem.values[key]]),
    );
    const validation = validateCustomObjectRecordData({
      data: supplied,
      fields: validationFields,
      existingData: beforeData,
      mode: 'update',
    });
    if (!validation.ok) {
      pairState.status = 'blocked';
      block(`Source row(s) ${sourceRowsLabel} is invalid: ${validation.errors.map((error) => error.message).join('; ')}.`);
      continue;
    }
    const afterData = validation.data;
    const diffs = fieldDiffs(beforeData, afterData);
    const patch = Object.fromEntries(diffs.map(({ key, after }) => [key, after]));
    if (pairState.status !== 'blocked') pairState.status = diffs.length ? 'changed' : 'unchanged';
    planned.push({
      sourceRow: sourceItem.sourceRow,
      sourceRows: [...sourceItem.sourceRows],
      recordId: record.id,
      organisationId: organisation.id,
      beforeData,
      patch,
      afterData,
      diffs,
      blankKeys: KEYS.filter((key) => sourceItem.values[key] === null),
    });
  }

  const itemsByRecord = new Map();
  for (const item of planned) {
    const matches = itemsByRecord.get(item.recordId) || [];
    matches.push(item);
    itemsByRecord.set(item.recordId, matches);
  }
  for (const [recordId, matches] of itemsByRecord) {
    if (matches.length < 2) continue;
    const rows = matches.flatMap((item) => item.sourceRows).join(', ');
    block(`Source row(s) ${rows}: unique pairs resolve to the same Department record ${recordId}.`);
    for (const item of matches) {
      const sourceItem = source.items.find((candidate) => candidate.sourceRow === item.sourceRow);
      if (sourceItem) pairStatuses.get(sourceItem.pairKey).status = 'blocked';
    }
  }
  const plannedByRow = new Map(planned.flatMap((item) => item.sourceRows.map((row) => [row, item])));
  const rowReports = [];
  for (const sourceRow of source.rows) {
    const item = plannedByRow.get(sourceRow.sourceRow);
    const pairState = pairStatuses.get(sourceRow.pairKey);
    rowReports.push({
      sourceRow: sourceRow.sourceRow,
      duplicateOf: sourceRow.duplicateOf,
      pairKey: sourceRow.pairKey,
      status: pairState?.status || 'unresolved',
      recordId: item?.recordId ?? pairState?.recordId ?? null,
      organisationId: item?.organisationId ?? pairState?.organisationId ?? null,
    });
  }
  const changed = planned.filter((item) => item.diffs.length > 0);
  const blankCellsPreserved = planned.reduce(
    (total, item) => total + item.blankKeys.length,
    0,
  );
  return {
    blockers,
    items: planned,
    rows: rowReports,
    summary: {
      sourceRows: source.rows.length,
      sourcePairs: source.items.length,
      duplicateRows: source.rows.filter((row) => row.duplicateOf !== null).length,
      matched: planned.length,
      recordsUpdated: changed.length,
      recordsUnchanged: planned.length - changed.length,
      fieldValuesChanged: changed.reduce((total, item) => total + item.diffs.length, 0),
      blankCellsPreserved,
      changedRecords: changed.length,
      unchangedRecords: planned.length - changed.length,
      changedFields: changed.reduce((total, item) => total + item.diffs.length, 0),
      blankValues: blankCellsPreserved,
      blockers: blockers.length,
    },
    phoneChange,
    phoneField,
  };
}