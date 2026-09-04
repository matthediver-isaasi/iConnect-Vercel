#!/usr/bin/env node
/**
 * Guarded, dry-run-first import for the pinned BNMS former-members export.
 * The four records without an email address are deliberately not importable:
 * member.email is the reconciliation key and an address must never be guessed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import {
  TENANT_ID, applyPlan, clean, emailKey, memberAssignmentNullability,
  parseBritishDate, transformed, validateReturnedRows, verifyOrCompensate,
} from './import-bnms-direct-debit-members.mjs';
export { TENANT_ID };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', 'Former_members_to_import_04.09.26_1788516103454.csv');
export const EXPECTED_FILE_SHA256 = 'e29011cad00c1938420f83496fb6cba552286cebcb49411aef84c769d989487d';
export const ROW_COUNT = 442;
export const IMPORT_ROW_COUNT = 410;
export const COLUMN_COUNT = 19;
export const HEADERS = Object.freeze([
  'ym_web_site_member_id', 'Member Since', 'ym_date_membership_expires',
  'ym_membership_type', 'member_class', 'First Name', 'Last Name', 'Title',
  'Email', 'alternative_email_address', 'member_region', 'Mobile', 'Group UUID',
  'Organisation UUID', 'Department UUID', 'occupation', 'srp/irpa_affiliate',
  'qualifications', 'Category - Focus Area',
]);
export const REVIEWED_EMAILLESS_LEGACY_IDS = Object.freeze(['69293534', '56480757', '67179504', '69400844']);
// Excel serialised these phones in scientific notation.  Their original digits
// cannot be recovered safely, so only this managed field is left untouched.
export const REVIEWED_SCIENTIFIC_PHONE_LEGACY_IDS = Object.freeze(['71404398', '73399496', '74091852', '79218031', '79707038', '74510391', '74404773', '72173350', '70255649', '71643965', '74643111', '72463875', '74041143', '74599952', '72327214', '77926730', '72292517', '77582980', '74040404', '71979949', '74692854', '79929729', '73963047', '75454151']);
// Reviewed after the live dropdown audit: these literal values do not exist in
// the active member Region options and are deliberately not canonicalised.
export const REVIEWED_UNSUPPORTED_REGION_LEGACY_IDS = Object.freeze(['71979949', '56480475', '70180647']);
// Live hierarchy audit found this export reference absent from the pinned BNMS
// tenant; it is blocked rather than assigned to a guessed organisation.
export const REVIEWED_MISSING_HIERARCHY_LEGACY_IDS = Object.freeze(['75730117', '72551331']);
export const CORE_MAPPINGS = Object.freeze([
  { column: 1, destination: 'created_on', transform: 'date' },
  { column: 5, destination: 'first_name' }, { column: 6, destination: 'last_name' },
  { column: 8, destination: 'email', transform: 'email' }, { column: 11, destination: 'mobile', transform: 'phone' },
]);
export const CUSTOM_MAPPINGS = Object.freeze([
  ['50d7b71c-29b0-4d4c-a817-f39edf35f2e0', 0, 'ym_web_site_member_id', 'YM Web Site Member ID', 'text'],
  ['2f04cda8-33f9-4df4-bcd5-e7150e4ca9ae', 2, 'ym_date_membership_expires', 'YM Date Membership Expires', 'text', 'validated-date'],
  ['40bdb74f-e8e0-4ad1-9760-b1128256a752', 3, 'ym_membership_type', 'YM Membership type', 'dropdown'],
  ['87f120ff-92e6-4d52-944b-9ba9d7b1fac0', 4, 'member_class', 'Member class', 'dropdown'],
  ['4f2e504c-1663-4dd8-a486-274159834320', 7, 'title', 'Title', 'dropdown'],
  ['b3d6ddbe-57c3-45a8-8f03-316f90b3dfbd', 9, 'alternative_email_address', 'Alternative email address', 'email'],
  ['0e3e3b1f-5a3d-40b5-a4b5-f0761c115216', 10, 'member_region', 'Region', 'dropdown'],
  ['1c84695f-e8f8-4afd-b4be-e54f5f540a26', 15, 'occupation', 'Occupation', 'dropdown'],
  // BNMS stores this as the supplied pipe-delimited textarea, not invented rows.
  ['5a12aae9-d754-45ce-ac47-a97109a690e2', 17, 'qualifications', 'Qualifications', 'textarea'],
  ['2dcf5b2b-670d-4058-a3a6-b48c084cca39', 16, 'srp/irpa_affiliate', 'SRP/IRPA Affiliate', 'boolean', 'boolean'],
].map(([id, column, name, label, type, transform]) => ({ id, column, name, label, type, transform })));
export const FOCUS_AREA = Object.freeze({ column: 18, id: '9e6a7200-1194-4e75-98d1-25a29303e95e', name: 'Focus Area' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const fail = (message) => { throw new Error(message); };
const check = (error, context) => { if (error) fail(`${context}: ${error.message}`); };

/** Decode each maximal valid UTF-8 sequence; only isolated bad bytes are CP1252. */
export function decodeMixedEncoding(bytes) {
  let out = ''; const utf8 = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i], width = b < 0x80 ? 1 : b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    if (width && i + width <= bytes.length) try { out += utf8.decode(bytes.subarray(i, i + width)); i += width; continue; } catch { /* one CP1252 byte below */ }
    out += iconv.decode(bytes.subarray(i, i + 1), 'windows-1252'); i += 1;
  }
  if (out.includes('\uFFFD') || /(?:Ã[\u0080-\u00ff]|Â[\u0080-\u00ff]|â(?:€™|€œ|€|€“|€”|[\u0080-\u00bf]))/.test(out)
    || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(out)) fail('Decoded CSV contains replacement, mojibake, or control characters.');
  return out;
}
export function parsePhone(value, context) {
  const raw = clean(value);
  if (!raw) return raw;
  if (/e[+-]?\d+/i.test(raw)) fail(`Scientific-notation phone at ${context} is unsafe and is not guessed.`);
  const compact = raw.replace(/[\s().-]/g, '');
  if (!/^(?:\+44|0044|0)?\d{6,14}$/.test(compact)) fail(`Invalid British/international phone at ${context}: "${value}".`);
  return raw;
}
function xform(value, transform, context) {
  if (transform === 'phone') return parsePhone(value, context);
  return transformed(value, transform, context);
}
export function parseSourceBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== EXPECTED_FILE_SHA256) fail(`CSV fingerprint mismatch; expected ${EXPECTED_FILE_SHA256}, found ${fingerprint}.`);
  const grid = parse(decodeMixedEncoding(bytes), { bom: true, relax_column_count: false, skip_empty_lines: true });
  if (!grid.length || grid[0].length !== COLUMN_COUNT || grid[0].some((v, i) => clean(v) !== HEADERS[i])) fail(`CSV must have the exact ${COLUMN_COUNT}-column positional header contract.`);
  const rows = grid.slice(1).map((input, i) => {
    const sourceRow = i + 2; if (input.length !== COLUMN_COUNT) fail(`CSV row ${sourceRow} must contain exactly ${COLUMN_COUNT} columns.`);
    const values = input.map(clean); if (!values.some(Boolean)) return null;
    if (!values[0] || !values[5] || !values[6]) fail(`CSV row ${sourceRow} has blank required legacy ID or name.`);
    parseBritishDate(values[1], `Member Since at row ${sourceRow}`); if (values[2]) parseBritishDate(values[2], `membership expiry at row ${sourceRow}`);
    if (values[8] && !EMAIL_RE.test(values[8])) fail(`CSV row ${sourceRow} has invalid Email "${values[8]}".`);
    if (values[9] && !EMAIL_RE.test(values[9])) fail(`CSV row ${sourceRow} has invalid alternative email.`);
    const scientificPhone = /e[+-]?\d+/i.test(values[11]);
    if (scientificPhone) values[11] = ''; // reviewed: never reconstruct or write a rounded phone
    else parsePhone(values[11], `row ${sourceRow}`);
    for (const c of [12, 13, 14]) if (values[c] && !UUID_RE.test(values[c])) fail(`CSV row ${sourceRow} has invalid UUID in column ${c + 1}.`);
    if (!['TRUE', 'FALSE'].includes(values[16])) fail(`CSV row ${sourceRow} has invalid SRP/IRPA Affiliate value.`);
    if ([12, 13, 14].filter((c) => values[c]).length > 1) fail(`CSV row ${sourceRow} has more than one hierarchy destination.`);
    return { sourceRow, legacyId: values[0], email: values[8] ? emailKey(values[8]) : null, values, scientificPhone };
  }).filter(Boolean);
  if (rows.length !== ROW_COUNT) fail(`CSV must contain exactly ${ROW_COUNT} populated records; found ${rows.length}.`);
  for (const key of ['legacyId', 'email']) { const seen = new Map(); for (const row of rows) if (row[key]) { if (seen.has(row[key])) fail(`Duplicate ${key} at rows ${seen.get(row[key])} and ${row.sourceRow}.`); seen.set(row[key], row.sourceRow); } }
  const excluded = rows.filter((r) => !r.email);
  if (excluded.length !== REVIEWED_EMAILLESS_LEGACY_IDS.length || excluded.some((r) => !REVIEWED_EMAILLESS_LEGACY_IDS.includes(r.legacyId))) fail('Reviewed email-less exclusion contract drifted.');
  const suppressedPhones = rows.filter((r) => r.scientificPhone);
  if (suppressedPhones.length !== REVIEWED_SCIENTIFIC_PHONE_LEGACY_IDS.length || suppressedPhones.some((r) => !REVIEWED_SCIENTIFIC_PHONE_LEGACY_IDS.includes(r.legacyId))) fail('Reviewed scientific-phone suppression contract drifted.');
  // A scientific Excel rendering cannot safely be reconciled to a phone.  The
  // complete record is blocked, rather than silently importing a partial row.
  const unsupportedRegions = rows.filter((r) => r.values[10] === 'Overseas Other');
  if (unsupportedRegions.length !== REVIEWED_UNSUPPORTED_REGION_LEGACY_IDS.length || unsupportedRegions.some((r) => !REVIEWED_UNSUPPORTED_REGION_LEGACY_IDS.includes(r.legacyId))) fail('Reviewed unsupported-Region exclusion contract drifted.');
  const missingHierarchy = rows.filter((r) => REVIEWED_MISSING_HIERARCHY_LEGACY_IDS.includes(r.legacyId));
  if (missingHierarchy.length !== REVIEWED_MISSING_HIERARCHY_LEGACY_IDS.length) fail('Reviewed missing-hierarchy exclusion contract drifted.');
  const blocked = rows.filter((r) => !r.email || r.scientificPhone || unsupportedRegions.includes(r) || missingHierarchy.includes(r));
  if (blocked.length !== 32) fail('Reviewed blocked-row count drifted.');
  return { fingerprint, rows, excluded, suppressedPhones, unsupportedRegions, missingHierarchy, blocked, importRows: rows.filter((r) => r.email && !r.scientificPhone && !unsupportedRegions.includes(r) && !missingHierarchy.includes(r)) };
}
export const readSource = (file = FILE) => parseSourceBytes(readFileSync(file));

function auditField(contract, fields, source) {
  // BNMS has both member and organisation Region fields.  Scope is part of
  // the contract and must constrain candidates before checking ambiguity.
  const found = fields.filter((f) => f.entity_scope === 'member'
    && (f.id === contract.id || f.name === contract.name || f.label === contract.label));
  if (found.length !== 1) fail(`Expected one unambiguous live field for "${contract.label}"; found ${found.length}.`);
  const f = found[0]; if (f.id !== contract.id || f.tenant_id !== TENANT_ID || f.entity_scope !== 'member' || f.name !== contract.name || f.label !== contract.label || f.field_type !== contract.type || !f.is_active) fail(`Live field contract drifted for "${contract.label}".`);
  const requested = [...new Set(source.importRows.map((r) => r.values[contract.column]).filter(Boolean))];
  if (contract.type === 'dropdown') { const allowed = new Set((f.options || []).flatMap((o) => [clean(o.value), clean(o.label)])); const bad = requested.filter((v) => !allowed.has(v)); if (bad.length) fail(`Unsupported "${contract.label}" value(s): ${bad.join(', ')}.`); }
  else if (f.options != null) fail(`Field "${contract.label}" unexpectedly has controlled options.`);
  return { ...contract, requested };
}
export const auditMappings = (fields, source) => CUSTOM_MAPPINGS.map((m) => auditField(m, fields, source));
export function auditFocusArea(categories, source) {
  const found = categories.filter((c) => c.id === FOCUS_AREA.id || c.name === FOCUS_AREA.name);
  if (found.length !== 1 || found[0].id !== FOCUS_AREA.id || found[0].tenant_id !== TENANT_ID || !found[0].is_active) fail('Live Focus Area category contract drifted.');
  const requested = [...new Set(source.importRows.flatMap((r) => r.values[18].split('|').map(clean).filter(Boolean)))], allowed = new Set((found[0].subcategories || []).map(clean));
  const bad = requested.filter((v) => !allowed.has(v)); if (bad.length) fail(`Unsupported Focus Area value(s): ${bad.join(', ')}. Values are never canonicalized.`);
  return { ...FOCUS_AREA, requested };
}

export function auditHierarchy(source, state) {
  const groups = new Map((state.groups || []).map((x) => [x.id, x])), orgs = new Map((state.organizations || []).map((x) => [x.id, x])), deps = new Map((state.departments || []).map((x) => [x.id, x]));
  const defs = state.relationshipDefinitions || [], parentDef = defs.filter((d) => d.relationship_key === 'organisation' && d.tenant_id === TENANT_ID && d.source_kind === 'custom_object' && d.target_kind === 'organization' && d.cardinality === 'many_to_one' && d.is_required && d.status === 'active'), memberDef = defs.filter((d) => d.relationship_key === 'members' && d.tenant_id === TENANT_ID && d.source_kind === 'custom_object' && d.target_kind === 'member' && d.cardinality === 'many_to_many' && !d.is_required && d.status === 'active');
  if (parentDef.length !== 1 || memberDef.length !== 1 || parentDef[0].source_custom_object_id !== memberDef[0].source_custom_object_id) fail('Department relationship definitions drifted.');
  const parents = new Map();
  for (const r of source.importRows) {
    if (r.values[12] && groups.get(r.values[12])?.tenant_id !== TENANT_ID) fail(`Row ${r.sourceRow}: Group is missing or outside BNMS.`);
    if (r.values[13] && orgs.get(r.values[13])?.tenant_id !== TENANT_ID) fail(`Row ${r.sourceRow}: Organisation is missing or outside BNMS.`);
    if (r.values[14]) { const d = deps.get(r.values[14]), edge = (state.parentEdges || []).filter((e) => !e.archived_at && e.relationship_definition_id === parentDef[0].id && e.source_record_id === r.values[14]); if (d?.tenant_id !== TENANT_ID || d.archived_at || d.custom_object_id !== memberDef[0].source_custom_object_id || edge.length !== 1 || orgs.get(edge[0].target_record_id)?.tenant_id !== TENANT_ID) fail(`Row ${r.sourceRow}: Department parent hierarchy is invalid.`); parents.set(r.values[14], edge[0].target_record_id); }
  } return { departmentParents: parents, memberDefinition: memberDef[0] };
}

export function makePlan(source, state, mappings, hierarchy, focus) {
  const byEmail = new Map();
  for (const member of state.members || []) {
    const key = emailKey(member.email);
    if (byEmail.has(key)) fail(`Ambiguous destination Member email "${key}".`);
    byEmail.set(key, member);
  }
  const prefs = new Map();
  for (const pref of state.preferenceValues || []) {
    const key = `${pref.member_id}|${pref.field_id}`;
    if (prefs.has(key)) fail(`Duplicate destination preference ${key}.`);
    prefs.set(key, pref);
  }
  const areas = new Set((state.memberCategories || []).map((x) => `${x.member_id}|${clean(x.subcategory_name)}`));
  return { items: source.importRows.map((row) => {
    const member = byEmail.get(row.email) || null;
    const patch = {};
    for (const mapping of CORE_MAPPINGS) if (row.values[mapping.column]) {
      const desired = xform(row.values[mapping.column], mapping.transform, `row ${row.sourceRow}`);
      const current = clean(member?.[mapping.destination]);
      if (!member || (mapping.transform === 'date' ? current.slice(0, 10) !== desired : current !== desired)) patch[mapping.destination] = desired;
    }
    const group = row.values[12];
    const departmentId = row.values[14] || null;
    const org = row.values[13] || (departmentId && hierarchy.departmentParents.get(departmentId));
    // No hierarchy input deliberately preserves both existing assignments.
    if (group) {
      if (!member || member.organization_group_id !== group) patch.organization_group_id = group;
      if (member?.organization_id != null) patch.organization_id = null;
    } else if (org) {
      if (!member || member.organization_id !== org) patch.organization_id = org;
      if (member?.organization_group_id != null) patch.organization_group_id = null;
    }
    const preferences = mappings.flatMap((m) => { if (!row.values[m.column]) return []; const desired = String(xform(row.values[m.column], m.transform, `row ${row.sourceRow}`)), existing = member && prefs.get(`${member.id}|${m.id}`); return [{ mapping: m, desired, existing, action: !existing ? 'insert' : clean(existing.value) === desired ? 'unchanged' : 'update' }]; });
    const focusAreas = row.values[18].split('|').map(clean).filter(Boolean).map((name) => ({ name, action: member && areas.has(`${member.id}|${name}`) ? 'unchanged' : 'insert' }));
    const relatedEdges = member ? (state.memberEdges || []).filter((edge) => edge.target_record_id === member.id) : [];
    const activeEdges = relatedEdges.filter((edge) => edge.relationship_definition_id === hierarchy.memberDefinition.id && !edge.archived_at);
    const exactEdges = departmentId ? activeEdges.filter((edge) => edge.source_record_id === departmentId) : [];
    if (exactEdges.length > 1) fail(`Member "${row.email}" has duplicate active Department edges.`);
    // The migrated Department model is many-to-many. A single legacy source
    // value ensures that edge exists; it is never authority to remove any
    // additional active Department memberships.
    const conflictingEdges = [];
    const edgeAction = departmentId ? (exactEdges.length ? 'unchanged' : 'insert') : 'none';
    return { row, member, patch, action: member ? Object.keys(patch).length ? 'update' : 'unchanged' : 'insert', preferences, focusAreas, departmentId, edgeAction, conflictingEdges, exactEdges, activeDepartmentEdges: activeEdges };
  }) };
}

async function fetchAll(db, table, columns, configure = (q) => q) {
  const out = [];
  for (let n = 0;; n += 500) {
    let result;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        result = await configure(db.from(table).select(columns).order('id').range(n, n + 499));
        if (!result.error) break;
        if (attempt === 4) check(result.error, `Could not read ${table}`);
      } catch (error) {
        if (attempt === 4) fail(`Could not read ${table}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
    const data = result?.data || [];
    out.push(...data);
    if (data.length < 500) return out;
  }
}
async function fetchAllForIds(db, table, columns, column, ids, configure = (q) => q) {
  const values = [...ids];
  const rows = [];
  for (let index = 0; index < values.length; index += 25) {
    rows.push(...await fetchAll(
      db,
      table,
      columns,
      (query) => configure(query.in(column, values.slice(index, index + 25))),
    ));
  }
  return rows;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
/**
 * Preserve precisely what this importer is not allowed to change.  Unlike the
 * generic importer this is row-aware: a blank source mobile/preference is
 * explicitly protected rather than treated as generally writable.
 */
export async function preservationSnapshot(
  db,
  source,
  mappings,
  hierarchy,
  plan,
  preserveMemberIds = null,
  loadedState = null,
) {
  const allMembers = loadedState?.members
    || await fetchAll(db, 'member', '*', (q) => q.eq('tenant_id', TENANT_ID));
  const sourceByEmail = new Map(source.rows.map((row) => [row.email, row]));
  const sourceMembers = allMembers.filter((member) => sourceByEmail.has(emailKey(member.email)));
  const ids = preserveMemberIds || new Set(sourceMembers.map((member) => member.id));
  // These reads are intentionally sequential. Running several paginated,
  // ID-filtered snapshots concurrently can exhaust the destination API's
  // connection budget before the guarded write begins.
  const memberPrefs = loadedState?.preferenceValues || (ids.size
    ? await fetchAllForIds(db, 'member_preference_value', '*', 'member_id', ids)
    : []);
  const relationships = loadedState?.memberEdges || (ids.size
    ? await fetchAllForIds(
      db,
      'custom_object_relationship',
      '*',
      'target_record_id',
      ids,
      (q) => q.eq('relationship_definition_id', hierarchy.memberDefinition.id),
    )
    : []);
  const focusRows = loadedState?.memberCategories || (ids.size
    ? await fetchAllForIds(
      db,
      'member_resource_category',
      '*',
      'member_id',
      ids,
      (q) => q.eq('resource_category_id', FOCUS_AREA.id),
    )
    : []);
  const protectedMembers = sourceMembers.filter((member) => ids.has(member.id)).map((member) => {
    const row = sourceByEmail.get(emailKey(member.email));
    const writable = new Set(['updated_at']);
    for (const mapping of CORE_MAPPINGS) if (row.values[mapping.column]) writable.add(mapping.destination);
    if (row.values[12] || row.values[13] || row.values[14]) {
      writable.add('organization_id'); writable.add('organization_group_id');
    }
    return Object.fromEntries(Object.entries(member).filter(([key]) => !writable.has(key)));
  });
  const memberById = new Map(sourceMembers.map((member) => [member.id, member]));
  const protectedPrefs = memberPrefs.filter((pref) => {
    const row = sourceByEmail.get(emailKey(memberById.get(pref.member_id)?.email));
    const mapping = mappings.find((item) => item.id === pref.field_id);
    return !mapping || !row || !row.values[mapping.column];
  });
  const plannedByEmail = new Map((plan?.items || []).map((item) => [item.row.email, item]));
  const authorizedRelationshipIds = new Set((plan?.items || []).flatMap((item) =>
    ['archive', 'replace'].includes(item.edgeAction) ? item.conflictingEdges.map((edge) => edge.id) : []));
  const authorizedRelationshipKeys = new Set();
  const authorizedFocusKeys = new Set();
  for (const member of sourceMembers) {
    const item = plannedByEmail.get(emailKey(member.email));
    if (!item) continue;
    if (item.departmentId && ['insert', 'replace'].includes(item.edgeAction)) {
      authorizedRelationshipKeys.add(`${hierarchy.memberDefinition.id}|${item.departmentId}|${member.id}`);
    }
    for (const area of item.focusAreas.filter((value) => value.action === 'insert')) {
      authorizedFocusKeys.add(`${member.id}|${FOCUS_AREA.id}|${area.name}`);
    }
  }
  return {
    memberIds: ids,
    digest: digest({
      protectedMembers,
      protectedPrefs,
      protectedRelationships: relationships.filter((row) =>
        !authorizedRelationshipIds.has(row.id)
        && !authorizedRelationshipKeys.has(`${row.relationship_definition_id}|${row.source_record_id}|${row.target_record_id}`)),
      protectedFocus: focusRows.filter((row) =>
        !authorizedFocusKeys.has(`${row.member_id}|${row.resource_category_id}|${clean(row.subcategory_name)}`)),
    }),
  };
}
export async function writeFocusAreas(db, plan, focus, journal) {
  const emails = new Set(plan.items.map((i) => i.row.email));
  const members = (await fetchAll(db, 'member', 'id,email,tenant_id', (q) => q.eq('tenant_id', TENANT_ID)))
    .filter((m) => emails.has(emailKey(m.email)));
  const byEmail = new Map(members.map((m) => [emailKey(m.email), m]));
  for (const item of plan.items) {
    const member = byEmail.get(item.row.email);
    if (!member) fail(`Could not resolve Member "${item.row.email}" for Focus Area write.`);
    const writes = item.focusAreas.filter((x) => x.action === 'insert')
      .map((x) => ({ id: randomUUID(), member_id: member.id, resource_category_id: focus.id, subcategory_name: x.name }));
    if (!writes.length) continue;
    // Journal deterministic identities before the request: a network failure
    // after commit, or an incomplete returning payload, remains recoverable.
    const ids = writes.map((x) => x.id);
    journal.push({ label: `delete Focus Areas for ${member.id}`, rollback: async () => {
      const { data: deleted, error: rollbackError } = await db.from('member_resource_category').delete().in('id', ids).select('id');
      check(rollbackError, 'Focus Area rollback failed');
      // Zero means the insert definitely did not commit; all means recovery
      // succeeded after commit.  Anything in between is unsafe ambiguity.
      if ((deleted || []).length !== 0 && (deleted || []).length !== ids.length) fail('Focus Area rollback was incomplete.');
    } });
    const { data, error } = await db.from('member_resource_category').insert(writes).select('id,member_id,resource_category_id,subcategory_name');
    check(error, `Could not write Focus Areas for "${item.row.email}"`);
    validateReturnedRows(data, writes, ['member_id', 'resource_category_id', 'subcategory_name'], 'Focus Area insert');
  }
}
export async function loadState(db, source) {
  const ids = [...new Set(source.importRows.flatMap((r) => [r.values[12], r.values[13], r.values[14]]).filter(Boolean))], legacy = source.importRows.map((r) => r.legacyId);
  const [tenantResult, fields, categories, groups, organizations, departments, defs, parents, members, nullability, legacyValues] = await Promise.all([
    db.from('tenant').select('id,name').eq('id', TENANT_ID).maybeSingle(), fetchAll(db, 'preference_field', 'id,tenant_id,name,label,field_type,entity_scope,is_active,options', (q) => q.eq('tenant_id', TENANT_ID)), fetchAll(db, 'resource_category', 'id,tenant_id,name,subcategories,is_active', (q) => q.eq('tenant_id', TENANT_ID)), fetchAll(db, 'organization_group', 'id,tenant_id,name', (q) => q.eq('tenant_id', TENANT_ID)), fetchAll(db, 'organization', 'id,tenant_id,name,organization_group_id', (q) => q.eq('tenant_id', TENANT_ID)), fetchAll(db, 'custom_object_record', 'id,tenant_id,custom_object_id,archived_at', (q) => q.in('id', ids)), fetchAll(db, 'custom_object_relationship_definition', 'id,tenant_id,relationship_key,source_kind,source_custom_object_id,target_kind,cardinality,is_required,status', (q) => q.eq('tenant_id', TENANT_ID)), fetchAll(db, 'custom_object_relationship', 'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at', (q) => q.in('source_record_id', ids)), fetchAll(db, 'member', '*', (q) => q.eq('tenant_id', TENANT_ID)), memberAssignmentNullability(), fetchAll(db, 'member_preference_value', 'id,member_id,field_id,value', (q) => q.eq('field_id', CUSTOM_MAPPINGS[0].id).in('value', legacy)),
  ]); check(tenantResult.error, 'Could not resolve BNMS'); if (tenantResult.data?.id !== TENANT_ID || !/bnms|british nuclear medicine society/i.test(tenantResult.data.name || '')) fail('Pinned destination is not BNMS.');
  const emails = new Set(source.importRows.map((r) => r.email)), matched = members.filter((m) => emails.has(emailKey(m.email))), mids = matched.map((m) => m.id);
  const [preferenceValues, memberCategories, memberEdges] = await Promise.all([
    mids.length
      ? fetchAllForIds(db, 'member_preference_value', 'id,member_id,field_id,value', 'member_id', mids)
      : [],
    mids.length
      ? fetchAllForIds(
        db,
        'member_resource_category',
        'id,member_id,resource_category_id,subcategory_name',
        'member_id',
        mids,
        (q) => q.eq('resource_category_id', FOCUS_AREA.id),
      )
      : [],
    mids.length
      ? fetchAllForIds(
        db,
        'custom_object_relationship',
        'id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at',
        'target_record_id',
        mids,
      )
      : [],
  ]);
  return { fields, categories, groups, organizations, departments, relationshipDefinitions: defs, parentEdges: parents, members: matched, preferenceValues, memberCategories, memberEdges, nullability, legacyValues };
}
export function auditLegacyConflicts(source, state) {
  const expectedLegacy = new Map(source.importRows.map((row) => [row.legacyId, row]));
  const membersByEmail = new Map(state.members.map((member) => [emailKey(member.email), member]));
  const seenLegacy = new Set();
  for (const value of state.legacyValues) {
    const row = expectedLegacy.get(clean(value.value));
    if (!row) fail('Live legacy-ID lookup returned an unrelated record.');
    if (seenLegacy.has(row.legacyId) || membersByEmail.get(row.email)?.id !== value.member_id) {
      fail(`Legacy ID "${row.legacyId}" conflicts with a different live BNMS Member.`);
    }
    seenLegacy.add(row.legacyId);
  }
}

async function main() {
  const apply = process.argv.slice(2).includes('--apply'); if (process.argv.slice(2).some((x) => x !== '--apply')) fail('Only --apply is supported.');
  const source = readSource(), db = createClient(process.env.DEST_SUPABASE_URL || fail('DEST_SUPABASE_URL is required.'), process.env.DEST_SUPABASE_KEY || fail('DEST_SUPABASE_KEY is required.'), { auth: { persistSession: false } }), state = await loadState(db, source), mappings = auditMappings(state.fields, source), focus = auditFocusArea(state.categories, source), hierarchy = auditHierarchy(source, state), plan = makePlan(source, state, mappings, hierarchy, focus);
  auditLegacyConflicts(source, state);
  console.log(`BNMS former members: ${source.rows.length} actual populated records; ${source.importRows.length} eligible; ${source.blocked.length} reviewed blocked.`);
  console.log(`Blocked missing-email IDs: ${source.excluded.map((r) => r.legacyId).join(', ')}. Blocked scientific-phone IDs: ${source.suppressedPhones.map((r) => r.legacyId).join(', ')}. Blocked unsupported-Region IDs: ${source.unsupportedRegions.map((r) => r.legacyId).join(', ')}. Blocked missing-hierarchy IDs: ${source.missingHierarchy.map((r) => r.legacyId).join(', ')}.`);
  console.log(`Plan: ${plan.items.filter((i) => i.action === 'insert').length} insert, ${plan.items.filter((i) => i.action === 'update').length} update; ${plan.items.flatMap((i) => i.preferences).filter((p) => p.action !== 'unchanged').length} preferences; ${plan.items.flatMap((i) => i.focusAreas).filter((p) => p.action !== 'unchanged').length} Focus Areas.`);
  if (!apply) return console.log('DRY RUN complete: no writes.');
  if (source.importRows.some((r) => !r.values[12] && !r.values[13] && !r.values[14]) && (!state.nullability?.organization_id || !state.nullability?.organization_group_id)) fail('Unassigned new members require confirmed nullable hierarchy columns.');
  // Snapshot only eligible records: it captures all fields/preferences/edges
  // this importer is not entitled to change, including blank source cells.
  const managedSource = { ...source, rows: source.importRows };
  const before = await preservationSnapshot(db, managedSource, mappings, hierarchy, plan, null, state);
  console.log('Pre-write preservation snapshot complete.');
  const result = await applyPlan(db, plan, hierarchy);
  console.log(`Guarded core write complete: ${result.memberWrites} Member, ${result.preferenceWrites} preference, ${result.edgeWrites} Department changes.`);
  try {
    await writeFocusAreas(db, plan, focus, result.journal);
    console.log('Guarded Focus Area write complete.');
  } catch (error) {
    await verifyOrCompensate(result.journal, async () => { throw error; });
    throw error;
  }
  await verifyOrCompensate(result.journal, async () => {
    console.log('Running post-write reload and zero-write replay.');
    const verified = await loadState(db, source);
    const verifiedMappings = auditMappings(verified.fields, source);
    const verifiedHierarchy = auditHierarchy(source, verified);
    const replay = makePlan(source, verified, verifiedMappings, verifiedHierarchy, auditFocusArea(verified.categories, source));
    if (replay.items.some((i) => i.action !== 'unchanged' || i.edgeAction !== 'unchanged' && i.edgeAction !== 'none'
      || i.preferences.some((p) => p.action !== 'unchanged') || i.focusAreas.some((x) => x.action !== 'unchanged'))) fail('Post-write replay is not zero-write.');
    const expectedDepartmentRelationships = source.importRows.filter((row) => row.values[14]).length;
    const verifiedDepartmentRelationships = replay.items.filter((item) => item.departmentId && item.edgeAction === 'unchanged').length;
    if (verifiedDepartmentRelationships !== expectedDepartmentRelationships) {
      fail(`Department relationship replay mismatch: ${verifiedDepartmentRelationships}/${expectedDepartmentRelationships} active exact edges.`);
    }
    const after = await preservationSnapshot(
      db,
      managedSource,
      verifiedMappings,
      verifiedHierarchy,
      plan,
      before.memberIds,
      verified,
    );
    if (before.digest !== after.digest) fail('Unmanaged member, preference, relationship, or outside-target data drifted.');
  }); console.log('Applied with guarded writes and zero-write replay.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });