// Shared, headless import-slice processor for the Import Manager.
//
// This module contains the actual row-processing logic (both the SQL fast path
// and the JS fallback path) that was originally inline in api/imports/execute.js.
// It is intentionally pure with respect to the import-job bookkeeping: it does
// NOT read or write the csv_import_job row. Callers (the legacy browser-driven
// execute endpoint AND the background worker) own job persistence; this module
// only performs the entity inserts/updates/notes/preferences for one
// time-budgeted slice and returns running totals + the next cursor.
//
// Phase 1 (the fast bulk DB paths — the process_member_import_batch RPC and the
// batched JS path) lives here so both entry points share one implementation.

import { filterCommunicationCategoriesForMember } from '../../shared/communicationCategoryMembership.js';

// Parse boolean values (true/false/yes/no) case-insensitively.
export function parseBoolean(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim().toLowerCase();
  if (['true', 'yes', '1', 'y', 't'].includes(str)) return true;
  if (['false', 'no', '0', 'n', 'f'].includes(str)) return false;
  return null;
}

// Parse a date string based on the supplied format. Returns an ISO date string
// in UTC to avoid timezone shifts, or null when it cannot be parsed.
export function parseDate(dateStr, format) {
  if (!dateStr || !format) return null;

  const str = String(dateStr).trim();
  if (!str) return null;

  const parts = str.split(/[\/\-\.]/);
  if (parts.length !== 3) return null;

  let day, month, year;
  const formatLower = format.toLowerCase();

  if (formatLower.startsWith('dd')) {
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
  } else if (formatLower.startsWith('mm')) {
    month = parseInt(parts[0], 10);
    day = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
  } else if (formatLower.startsWith('yy')) {
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    day = parseInt(parts[2], 10);
  } else {
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
  }

  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  if (day < 1 || day > 31) return null;
  if (month < 1 || month > 12) return null;

  if (year < 100) {
    year = year < 50 ? 2000 + year : 1900 + year;
  }

  const utcTimestamp = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  if (isNaN(utcTimestamp)) return null;

  const date = new Date(utcTimestamp);
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1 || date.getUTCFullYear() !== year) {
    return null;
  }

  return date.toISOString();
}

// --- Auxiliary persistence helpers ---------------------------------------
// These power the set-based persistence of custom field values, communication
// preferences, and notes for BOTH the member and organisation fast paths. They
// replace the old per-row upserts that forced these imports onto the slow JS
// path. All writes are batched; failures are logged, never thrown, so a logging
// hiccup in an auxiliary table cannot abort an otherwise-successful import.

// Build a Map of lower(trim(identifier)) -> entity id for a tenant, fetched in
// pages so it is correct even past PostgREST's default 1,000-row response cap
// (a single un-ranged select silently drops everyone after the first 1,000, so
// notes/custom values went unmatched on large tenants).
async function fetchIdByKey(supabase, { table, tenantId, keyField }) {
  const map = new Map();
  const PAGE = 1000;
  let from = 0;
  // Hard cap the number of pages so a pathological tenant can't loop forever.
  for (let page = 0; page < 1000; page++) {
    const { data, error } = await supabase
      .from(table)
      .select('id, ' + keyField)
      .eq('tenant_id', tenantId)
      .not(keyField, 'is', null)
      .neq(keyField, '')
      .range(from, from + PAGE - 1);
    if (error) {
      console.log(`[Import] fetchIdByKey(${table}.${keyField}) error: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    for (const r of data) {
      const raw = r[keyField];
      if (raw == null) continue;
      const key = String(raw).toLowerCase().trim();
      if (key && !map.has(key)) map.set(key, r.id);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

async function batchUpsert(supabase, table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from(table)
      .upsert(rows.slice(i, i + 500), { onConflict });
    if (error) console.log(`[Import] ${table} upsert error: ${error.message}`);
  }
}

async function batchInsert(supabase, table, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    const { error } = await supabase.from(table).insert(slice);
    if (error) console.log(`[Import] ${table} insert error: ${error.message}`);
    else inserted += slice.length;
  }
  return inserted;
}

export async function filterImportCommunicationPreferences(supabase, tenantId, rows) {
  if (!rows.length) return [];
  const categoryIds = [...new Set(rows.map((row) => row.category_id).filter(Boolean))];
  const memberIds = [...new Set(rows.map((row) => row.member_id).filter(Boolean))];
  const [
    { data: categories, error: categoryError },
    { data: roleAssignments, error: roleError },
    { data: members, error: memberError },
  ] = await Promise.all([
    supabase
      .from('communication_category')
      .select('id, member_enabled')
      .eq('tenant_id', tenantId)
      .in('id', categoryIds),
    supabase
      .from('communication_category_role')
      .select('category_id, role_id')
      .eq('tenant_id', tenantId)
      .in('category_id', categoryIds),
    supabase
      .from('member')
      .select('id, role_id')
      .eq('tenant_id', tenantId)
      .in('id', memberIds),
  ]);

  if (categoryError || roleError || memberError) {
    console.log(
      `[Import] communication eligibility lookup failed: ${
        categoryError?.message || roleError?.message || memberError?.message
      }`
    );
    return rows.filter((row) => row.is_subscribed === false);
  }

  const categoryById = new Map((categories || []).map((category) => [category.id, category]));
  const memberById = new Map((members || []).map((member) => [member.id, member]));
  const eligibleByMember = new Map();
  for (const member of members || []) {
    eligibleByMember.set(
      member.id,
      new Set(
        filterCommunicationCategoriesForMember(categories || [], roleAssignments || [], member)
          .map(({ id }) => id)
      )
    );
  }

  return rows.filter((row) => {
    if (!categoryById.has(row.category_id) || !memberById.has(row.member_id)) return false;
    return row.is_subscribed === false
      || eligibleByMember.get(row.member_id)?.has(row.category_id);
  });
}

// Resolve a mapped cell value (date parsing + clear-on-empty) the same way the
// core transform does, so auxiliary values stay consistent with core fields.
function resolveCellValue(row, mapping) {
  let value = row[mapping.sourceColumn];
  if (mapping.clearOnEmpty && (!value || (typeof value === 'string' && value.trim() === ''))) {
    return null;
  }
  if (value !== null && value !== undefined && mapping.targetType === 'date' && mapping.dateFormat) {
    const parsed = parseDate(value, mapping.dateFormat);
    if (parsed) return parsed;
  }
  if (typeof value === 'string') return value.trim();
  return value;
}

// Persist custom fields + communication preferences + notes for a slice of
// member rows, [from, to). Idempotent for custom/comm (upserts), so a retried
// slice re-runs harmlessly. Returns the number of notes inserted this slice.
async function persistMemberAux({ supabase, records, from, to, mappings, identifierMapping, tenantId, authorMemberId }) {
  const customMappings = mappings.filter(m => m.targetField?.startsWith('custom:') && m.preferenceFieldId);
  const commMappings = mappings.filter(m => m.targetField?.startsWith('comm:'));
  const noteMappings = mappings.filter(m => m.targetField === '__add_note__');
  if (customMappings.length === 0 && commMappings.length === 0 && noteMappings.length === 0) {
    return 0;
  }

  const idByKey = await fetchIdByKey(supabase, { table: 'member', tenantId, keyField: 'email' });
  const customByKey = new Map();
  const commByKey = new Map();
  const notes = [];
  const now = new Date().toISOString();

  for (let i = from; i < to && i < records.length; i++) {
    const row = records[i];
    const identifierValue = row[identifierMapping.sourceColumn]?.trim();
    if (!identifierValue) continue;
    const memberId = idByKey.get(identifierValue.toLowerCase());
    if (!memberId) continue;

    for (const m of customMappings) {
      const value = resolveCellValue(row, m);
      customByKey.set(`${memberId}|${m.preferenceFieldId}`, {
        member_id: memberId,
        field_id: m.preferenceFieldId,
        value: value?.trim?.() || value,
      });
    }
    for (const m of commMappings) {
      const categoryId = m.targetField.replace('comm:', '');
      if (!categoryId) continue;
      const optedIn = parseBoolean(row[m.sourceColumn]);
      if (optedIn !== null) {
        // The real column is is_subscribed (NOT opted_in); writing opted_in
        // silently errored and dropped every imported preference.
        commByKey.set(`${memberId}|${categoryId}`, {
          member_id: memberId,
          category_id: categoryId,
          is_subscribed: optedIn,
          tenant_id: tenantId,
        });
      }
    }
    for (const m of noteMappings) {
      const raw = row[m.sourceColumn];
      if (raw && String(raw).trim()) {
        notes.push({
          target_member_id: memberId,
          author_member_id: authorMemberId,
          content: String(raw).trim(),
          created_at: now,
          updated_at: now,
        });
      }
    }
  }

  if (customByKey.size > 0) {
    await batchUpsert(supabase, 'member_preference_value', Array.from(customByKey.values()), 'member_id,field_id');
  }
  if (commByKey.size > 0) {
    const authorizedPreferences = await filterImportCommunicationPreferences(
      supabase,
      tenantId,
      Array.from(commByKey.values())
    );
    await batchUpsert(supabase, 'member_communication_preference', authorizedPreferences, 'member_id,category_id');
  }
  let notesCreated = 0;
  if (notes.length > 0) {
    notesCreated = await batchInsert(supabase, 'member_note', notes);
  }
  return notesCreated;
}

// Persist custom fields + notes for a slice of organisation rows, [from, to).
async function persistOrgAux({ supabase, records, from, to, mappings, identifierMapping, tenantId, authorMemberId }) {
  const customMappings = mappings.filter(m => m.targetField?.startsWith('custom:') && m.preferenceFieldId);
  const noteMappings = mappings.filter(m => m.targetField === '__add_note__');
  if (customMappings.length === 0 && noteMappings.length === 0) {
    return 0;
  }

  const idByKey = await fetchIdByKey(supabase, { table: 'organization', tenantId, keyField: 'name' });
  const customByKey = new Map();
  const notes = [];
  const now = new Date().toISOString();

  for (let i = from; i < to && i < records.length; i++) {
    const row = records[i];
    const identifierValue = row[identifierMapping.sourceColumn]?.trim();
    if (!identifierValue) continue;
    const orgId = idByKey.get(identifierValue.toLowerCase());
    if (!orgId) continue;

    for (const m of customMappings) {
      const value = resolveCellValue(row, m);
      customByKey.set(`${orgId}|${m.preferenceFieldId}`, {
        organization_id: orgId,
        field_id: m.preferenceFieldId,
        value: value?.trim?.() || value,
      });
    }
    for (const m of noteMappings) {
      const raw = row[m.sourceColumn];
      if (raw && String(raw).trim()) {
        notes.push({
          organization_id: orgId,
          member_id: authorMemberId,
          content: String(raw).trim(),
          attachments: [],
          created_at: now,
          updated_at: now,
        });
      }
    }
  }

  if (customByKey.size > 0) {
    await batchUpsert(supabase, 'organization_preference_value', Array.from(customByKey.values()), 'organization_id,field_id');
  }
  let notesCreated = 0;
  if (notes.length > 0) {
    notesCreated = await batchInsert(supabase, 'organization_note', notes);
  }
  return notesCreated;
}

// The member SQL function persists this fixed set of core columns. custom:* and
// comm:* fields are NOT columns on member, but they are persisted set-based by
// persistMemberAux after the RPC, so they are fast-path-safe too. Anything else
// (biography, social URLs, login flags, external_id) is still JS-path only
// because the RPC does not write those columns.
const SQL_FASTPATH_FIELDS = new Set([
  'email', 'first_name', 'last_name', 'mobile', 'landline', 'job_title',
  'role_id', 'role_effective_from', 'organization_id', 'created_on', '__add_note__',
]);

// The organisation SQL function persists this fixed set of core columns; custom:*
// values and notes are persisted set-based by persistOrgAux.
const ORG_SQL_FASTPATH_FIELDS = new Set([
  'name', 'description', 'website_url', 'logo_url', 'email', 'phone', 'status',
  'created_at', '__add_note__',
]);

// Process one time-budgeted slice of an import.
//
// Params:
//   supabase            - service-role Supabase client
//   records             - full parsed array of row objects (header-keyed)
//   offset              - cursor to resume from (row index)
//   mappings            - active column->field mappings
//   entityType          - 'member' | 'organization'
//   identifierField     - field used to match existing records (e.g. 'email')
//   tenantId            - tenant scope (required)
//   authorMemberId      - member id recorded as note author
//   forceJsPath         - once true, stay on the JS path for all later slices
//   running             - { created, updated, skipped, errors, notes } carried across slices
//   timeBudgetMs        - stop processing new batches after this many ms
//
// Returns:
//   { done, offset, created, updated, skipped, errors, notes, path, errorLog, summary? }
//   - path is 'js' once the run is pinned to the JS path, else null.
//   - summary is only present when done === true.
export async function processImportSlice({
  supabase,
  records,
  offset = 0,
  mappings,
  entityType,
  identifierField,
  tenantId,
  authorMemberId = null,
  forceJsPath = false,
  running = {},
  timeBudgetMs = 40000,
}) {
  const chunkStartTime = Date.now();
  const timeBudgetReached = () => Date.now() - chunkStartTime > timeBudgetMs;

  let runningCreated = Math.max(0, parseInt(running.created, 10) || 0);
  let runningUpdated = Math.max(0, parseInt(running.updated, 10) || 0);
  let runningSkipped = Math.max(0, parseInt(running.skipped, 10) || 0);
  let runningErrors = Math.max(0, parseInt(running.errors, 10) || 0);
  let runningNotes = Math.max(0, parseInt(running.notes, 10) || 0);

  const identifierMapping = mappings.find((m) => m.targetField === identifierField);
  if (!identifierMapping) {
    throw new Error(`No mapping for identifier field: ${identifierField}`);
  }

  const tableName = entityType === 'organization' ? 'organization' : 'member';

  // custom:* and comm:* are fast-path-safe because persistMemberAux writes them
  // set-based after the RPC.
  const isAuxMapping = (m) =>
    m.targetField?.startsWith('custom:') || m.targetField?.startsWith('comm:');
  const allMappingsFastPathSafe = mappings.every(
    (m) => !m.targetField || SQL_FASTPATH_FIELDS.has(m.targetField) || isAuxMapping(m)
  );
  // The org fast path is only used when matching by name (the default org
  // identifier); custom:* values are persisted set-based by persistOrgAux.
  const allMappingsOrgFastPathSafe = mappings.every(
    (m) => !m.targetField || ORG_SQL_FASTPATH_FIELDS.has(m.targetField) || m.targetField?.startsWith('custom:')
  );

  // Set to true only if the SQL function fails on the very first batch and we
  // fall back to the JS path. Surfaced to the caller so later slices stay on
  // the JS path.
  let firstBatchRpcFailed = false;

  // --- Member SQL fast path -------------------------------------------------
  if (!forceJsPath && entityType === 'member' && identifierField === 'email' && allMappingsFastPathSafe) {
    // custom:*, comm:* and __add_note__ mappings are NOT sent to the RPC — they
    // are persisted set-based, per processed slice, by persistMemberAux below.
    const batch = records.map((row, index) => {
      const record = { row_index: index };

      for (const mapping of mappings) {
        if (!mapping.sourceColumn || !mapping.targetField) continue;
        if (mapping.targetField === '__add_note__') continue;
        if (mapping.targetField.startsWith('custom:') || mapping.targetField.startsWith('comm:')) continue;

        let value = row[mapping.sourceColumn];
        if (value !== undefined && value !== null) {
          value = String(value).trim();
        }
        if (value && mapping.targetType === 'date' && mapping.dateFormat) {
          const parsed = parseDate(value, mapping.dateFormat);
          if (parsed) value = parsed;
        }

        if (mapping.targetField === 'email') {
          record.email = value ? value.toLowerCase() : value;
        } else if (mapping.targetField === 'first_name') record.first_name = value;
        else if (mapping.targetField === 'last_name') record.last_name = value;
        else if (mapping.targetField === 'mobile') record.mobile = value;
        else if (mapping.targetField === 'landline') record.landline = value;
        else if (mapping.targetField === 'job_title') record.job_title = value;
        else if (mapping.targetField === 'role_id') record.role_name = value; // SQL looks up by name
        else if (mapping.targetField === 'role_effective_from') record.role_effective_from = value;
        else if (mapping.targetField === 'organization_id') record.organization_name = value; // SQL looks up by name
        else if (mapping.targetField === 'created_on') record.created_on = value;
      }

      return record;
    });

    const SQL_BATCH_SIZE = 1000;
    let chunkCreated = 0;
    let chunkUpdated = 0;
    let chunkSkipped = 0;
    let chunkErrors = 0;

    // Track the start of the slice processed THIS invocation so we persist
    // auxiliary data only for the rows the RPC actually touched this time.
    const sliceStart = offset;
    let sqlOffset = offset;
    let sqlDone = false;
    for (let i = offset; i < batch.length; i += SQL_BATCH_SIZE) {
      // Always process at least one batch per invocation, then respect budget.
      if (i > offset && timeBudgetReached()) break;

      const chunk = batch.slice(i, i + SQL_BATCH_SIZE);

      const { data, error } = await supabase.rpc('process_member_import_batch', {
        batch: chunk,
        p_tenant_id: tenantId,
      });

      if (error) {
        // Only safe to fall back to the JS path when nothing has been imported
        // yet for the whole run (very first batch of the very first slice).
        if (i === 0) {
          firstBatchRpcFailed = true;
          break;
        }
        throw new Error(`Import failed mid-run (SQL batch at row ${i + 1}): ${error.message}`);
      }

      if (data) {
        chunkCreated += data.created || 0;
        chunkUpdated += data.updated || 0;
        chunkSkipped += data.skipped || 0;
        chunkErrors += data.errors || 0;
      }

      sqlOffset = i + SQL_BATCH_SIZE;
      if (sqlOffset >= batch.length) sqlDone = true;
    }

    if (!firstBatchRpcFailed) {
      runningCreated += chunkCreated;
      runningUpdated += chunkUpdated;
      runningSkipped += chunkSkipped;
      runningErrors += chunkErrors;

      // Persist custom fields / comm prefs / notes for exactly the rows the RPC
      // processed this invocation. Members exist now (RPC ran), so the
      // email->id lookup resolves. Idempotent for custom/comm (upserts).
      const sliceEnd = Math.min(sqlOffset, records.length);
      if (sliceEnd > sliceStart) {
        const auxNotes = await persistMemberAux({
          supabase,
          records,
          from: sliceStart,
          to: sliceEnd,
          mappings,
          identifierMapping,
          tenantId,
          authorMemberId,
        });
        runningNotes += auxNotes;
      }

      if (!sqlDone) {
        return {
          done: false,
          path: null,
          offset: Math.min(sqlOffset, records.length),
          created: runningCreated,
          updated: runningUpdated,
          skipped: runningSkipped,
          errors: runningErrors,
          notes: runningNotes,
          errorLog: [],
        };
      }

      // Final SQL slice: finalize and return.
      return {
        done: true,
        path: null,
        offset: records.length,
        created: runningCreated,
        updated: runningUpdated,
        skipped: runningSkipped,
        errors: runningErrors,
        notes: runningNotes,
        errorLog: [],
        summary: {
          totalRows: records.length,
          processedRows: runningCreated + runningUpdated,
          createdRows: runningCreated,
          updatedRows: runningUpdated,
          skippedRows: runningSkipped,
          errorRows: runningErrors,
          notesCreated: runningNotes,
        },
      };
    }
    // else: firstBatchRpcFailed at offset 0 — fall through to the JS path.
  }

  // --- Organisation SQL fast path ------------------------------------------
  // Mirrors the member fast path: the RPC writes core columns, then persistOrgAux
  // writes custom values + notes set-based, per processed slice. Only used when
  // matching by name (the default org identifier).
  if (!forceJsPath && entityType === 'organization' && identifierField === 'name' && allMappingsOrgFastPathSafe) {
    const batch = records.map((row, index) => {
      const record = { row_index: index };

      for (const mapping of mappings) {
        if (!mapping.sourceColumn || !mapping.targetField) continue;
        if (mapping.targetField === '__add_note__') continue;
        if (mapping.targetField.startsWith('custom:')) continue;

        let value = row[mapping.sourceColumn];
        if (value !== undefined && value !== null) {
          value = String(value).trim();
        }
        if (value && mapping.targetType === 'date' && mapping.dateFormat) {
          const parsed = parseDate(value, mapping.dateFormat);
          if (parsed) value = parsed;
        }

        if (mapping.targetField === 'name') record.name = value;
        else if (mapping.targetField === 'description') record.description = value;
        else if (mapping.targetField === 'website_url') record.website_url = value;
        else if (mapping.targetField === 'logo_url') record.logo_url = value;
        else if (mapping.targetField === 'email') record.email = value ? value.toLowerCase() : value;
        else if (mapping.targetField === 'phone') record.phone = value;
        else if (mapping.targetField === 'status') record.status = value;
        else if (mapping.targetField === 'created_at') record.created_at = value;
      }

      return record;
    });

    const SQL_BATCH_SIZE = 1000;
    let chunkCreated = 0;
    let chunkUpdated = 0;
    let chunkSkipped = 0;
    let chunkErrors = 0;

    const sliceStart = offset;
    let sqlOffset = offset;
    let sqlDone = false;
    for (let i = offset; i < batch.length; i += SQL_BATCH_SIZE) {
      if (i > offset && timeBudgetReached()) break;

      const chunk = batch.slice(i, i + SQL_BATCH_SIZE);

      const { data, error } = await supabase.rpc('process_organization_import_batch', {
        batch: chunk,
        p_tenant_id: tenantId,
      });

      if (error) {
        if (i === 0) {
          firstBatchRpcFailed = true;
          break;
        }
        throw new Error(`Import failed mid-run (org SQL batch at row ${i + 1}): ${error.message}`);
      }

      if (data) {
        chunkCreated += data.created || 0;
        chunkUpdated += data.updated || 0;
        chunkSkipped += data.skipped || 0;
        chunkErrors += data.errors || 0;
      }

      sqlOffset = i + SQL_BATCH_SIZE;
      if (sqlOffset >= batch.length) sqlDone = true;
    }

    if (!firstBatchRpcFailed) {
      runningCreated += chunkCreated;
      runningUpdated += chunkUpdated;
      runningSkipped += chunkSkipped;
      runningErrors += chunkErrors;

      const sliceEnd = Math.min(sqlOffset, records.length);
      if (sliceEnd > sliceStart) {
        const auxNotes = await persistOrgAux({
          supabase,
          records,
          from: sliceStart,
          to: sliceEnd,
          mappings,
          identifierMapping,
          tenantId,
          authorMemberId,
        });
        runningNotes += auxNotes;
      }

      if (!sqlDone) {
        return {
          done: false,
          path: null,
          offset: Math.min(sqlOffset, records.length),
          created: runningCreated,
          updated: runningUpdated,
          skipped: runningSkipped,
          errors: runningErrors,
          notes: runningNotes,
          errorLog: [],
        };
      }

      return {
        done: true,
        path: null,
        offset: records.length,
        created: runningCreated,
        updated: runningUpdated,
        skipped: runningSkipped,
        errors: runningErrors,
        notes: runningNotes,
        errorLog: [],
        summary: {
          totalRows: records.length,
          processedRows: runningCreated + runningUpdated,
          createdRows: runningCreated,
          updatedRows: runningUpdated,
          skippedRows: runningSkipped,
          errorRows: runningErrors,
          notesCreated: runningNotes,
        },
      };
    }
    // else: firstBatchRpcFailed at offset 0 — fall through to the JS path.
  }

  // --- JS path -------------------------------------------------------------
  // Surfaced to the caller so that, once we are on the JS path (either by
  // mapping shape or by SQL fallback), every later slice stays on it.
  const jsPathHint = (forceJsPath || firstBatchRpcFailed) ? 'js' : null;

  const customValueTable = entityType === 'organization'
    ? 'organization_preference_value'
    : 'member_preference_value';
  const entityIdField = entityType === 'organization' ? 'organization_id' : 'member_id';

  const isEmailIdentifier = identifierField === 'email';

  // Re-built every slice. Because each slice does a fresh fetch, rows inserted
  // by earlier slices are visible here, so cross-slice de-duplication works
  // naturally (a member created in slice 1 is updated, not re-created, later).
  let existingEntities = [];
  if (isEmailIdentifier) {
    const { data } = await supabase
      .from(tableName)
      .select('id, email')
      .eq('tenant_id', tenantId)
      .not('email', 'is', null)
      .neq('email', '');
    existingEntities = data || [];
  } else {
    const allIdentifierValues = records
      .map((row) => row[identifierMapping.sourceColumn]?.trim())
      .filter((v) => v);
    const { data } = await supabase
      .from(tableName)
      .select('id, ' + identifierField)
      .eq('tenant_id', tenantId)
      .in(identifierField, allIdentifierValues);
    existingEntities = data || [];
  }

  const existingMap = new Map();
  existingEntities.forEach((e) => {
    const key = isEmailIdentifier && e[identifierField]
      ? e[identifierField].toLowerCase().trim()
      : e[identifierField];
    existingMap.set(key, e.id);
  });

  let chunkCreated = 0;
  let chunkUpdated = 0;
  let chunkSkipped = 0;
  let chunkErrors = 0;
  const errorLog = [];
  const notesToCreate = [];
  const memberNotesToCreate = [];

  const hasRoleMapping = entityType === 'member' && mappings.some((m) => m.targetField === 'role_id');
  let roleMap = new Map();
  if (hasRoleMapping) {
    const { data: roles } = await supabase
      .from('role')
      .select('id, name')
      .eq('tenant_id', tenantId);
    if (roles) {
      roles.forEach((role) => roleMap.set(role.name.toLowerCase().trim(), role.id));
    }
  }

  const hasOrgMapping = entityType === 'member' && mappings.some((m) => m.targetField === 'organization_id');
  let orgMap = new Map();
  if (hasOrgMapping) {
    const { data: orgs } = await supabase
      .from('organization')
      .select('id, name')
      .eq('tenant_id', tenantId);
    if (orgs) {
      orgs.forEach((org) => orgMap.set(org.name.toLowerCase().trim(), org.id));
    }
  }

  const BATCH_SIZE = 50;
  let sliceEnd = offset;

  for (let batchStart = offset; batchStart < records.length; batchStart += BATCH_SIZE) {
    if (batchStart > offset && timeBudgetReached()) break;

    const batchEnd = Math.min(batchStart + BATCH_SIZE, records.length);
    const batch = records.slice(batchStart, batchEnd);

    const toInsert = [];
    const toUpdate = [];

    for (let i = 0; i < batch.length; i++) {
      const rowIndex = batchStart + i;
      const row = batch[i];
      const identifierValue = row[identifierMapping.sourceColumn]?.trim();

      if (!identifierValue) {
        chunkSkipped++;
        errorLog.push({ row: rowIndex + 1, error: 'Empty identifier value' });
        continue;
      }

      const coreData = {};
      let noteContent = null;

      for (const mapping of mappings) {
        if (!mapping.sourceColumn || !mapping.targetField) continue;

        let value = row[mapping.sourceColumn];

        if (mapping.clearOnEmpty && (!value || value.trim() === '')) {
          value = null;
        }

        if (value !== null && mapping.targetType === 'date' && mapping.dateFormat) {
          const parsedDate = parseDate(value, mapping.dateFormat);
          if (parsedDate) value = parsedDate;
        }

        if (mapping.targetField === '__add_note__') {
          if (value && typeof value === 'string' && value.trim()) {
            noteContent = value.trim();
          }
          continue;
        }

        if (mapping.targetField === 'role_id' && value && typeof value === 'string') {
          const roleName = value.trim().toLowerCase();
          const roleId = roleMap.get(roleName);
          if (roleId) coreData['role_id'] = roleId;
          continue;
        }

        if (mapping.targetField === 'organization_id' && value && typeof value === 'string') {
          const orgName = value.trim().toLowerCase();
          const orgId = orgMap.get(orgName);
          if (orgId) coreData['organization_id'] = orgId;
          continue;
        }

        if (mapping.targetField.startsWith('custom:') || mapping.targetField.startsWith('comm:')) {
          // Handled in their own blocks below; never written into coreData.
          continue;
        } else if (mapping.targetField === 'id') {
          continue;
        } else {
          if (value === null || (typeof value === 'string' && value.trim() !== '')) {
            let normalized = value === null ? null : value.trim();
            if (normalized !== null && mapping.targetField === 'email') {
              normalized = normalized.toLowerCase();
            }
            coreData[mapping.targetField] = normalized;
          }
        }
      }

      const lookupKey = isEmailIdentifier ? identifierValue.toLowerCase() : identifierValue;
      const existingId = existingMap.get(lookupKey);

      if (existingId) {
        toUpdate.push({ id: existingId, data: coreData, noteContent, identifierValue, rowIndex });
      } else {
        toInsert.push({ data: coreData, noteContent, identifierValue, rowIndex });
      }
    }

    // Batch insert new records.
    if (toInsert.length > 0) {
      const insertData = toInsert.map((r) => ({ ...r.data, tenant_id: tenantId }));
      const { data: inserted, error: insertError } = await supabase
        .from(tableName)
        .insert(insertData)
        .select('id, ' + identifierField);

      if (insertError) {
        if (insertError.code === '23505' && isEmailIdentifier) {
          // Fall back to individual inserts to identify which rows are duplicates.
          for (const record of toInsert) {
            const { data: singleInserted, error: singleError } = await supabase
              .from(tableName)
              .insert({ ...record.data, tenant_id: tenantId })
              .select('id, ' + identifierField)
              .single();

            if (singleError) {
              if (singleError.code === '23505') {
                const { data: existing } = await supabase
                  .from(tableName)
                  .select('id')
                  .eq('tenant_id', tenantId)
                  .ilike('email', record.data.email)
                  .single();

                if (existing) {
                  const { error: updateError } = await supabase
                    .from(tableName)
                    .update(record.data)
                    .eq('id', existing.id);

                  if (!updateError) {
                    chunkUpdated++;
                    existingMap.set(record.data.email?.toLowerCase(), existing.id);
                  } else {
                    chunkErrors++;
                    errorLog.push({ row: record.rowIndex + 1, identifier: record.identifierValue, error: 'Failed to update existing record' });
                  }
                } else {
                  chunkErrors++;
                  errorLog.push({ row: record.rowIndex + 1, identifier: record.identifierValue, error: 'Duplicate email exists' });
                }
              } else {
                chunkErrors++;
                errorLog.push({ row: record.rowIndex + 1, identifier: record.identifierValue, error: singleError.message });
              }
            } else if (singleInserted) {
              chunkCreated++;
              const lk = isEmailIdentifier && singleInserted[identifierField]
                ? singleInserted[identifierField].toLowerCase()
                : singleInserted[identifierField];
              existingMap.set(lk, singleInserted.id);
            }
          }
        } else {
          toInsert.forEach((r) => {
            chunkErrors++;
            errorLog.push({ row: r.rowIndex + 1, identifier: r.identifierValue, error: insertError.message });
          });
        }
      } else {
        chunkCreated += inserted.length;

        inserted.forEach((entity) => {
          const entityIdentifier = entity[identifierField];
          const lk = isEmailIdentifier && entityIdentifier
            ? entityIdentifier.toLowerCase()
            : entityIdentifier;
          const original = toInsert.find((r) => {
            const origKey = isEmailIdentifier && r.data[identifierField]
              ? r.data[identifierField].toLowerCase()
              : r.data[identifierField];
            return origKey === lk;
          });
          if (original && original.noteContent) {
            if (entityType === 'organization') {
              notesToCreate.push({
                organization_id: entity.id,
                member_id: authorMemberId,
                content: original.noteContent,
                attachments: [],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });
            } else if (entityType === 'member') {
              memberNotesToCreate.push({
                target_member_id: entity.id,
                author_member_id: authorMemberId,
                content: original.noteContent,
                attachments: [],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });
            }
          }
          existingMap.set(lk, entity.id);
        });
      }
    }

    // Update existing records one by one (different data each).
    for (const updateItem of toUpdate) {
      if (Object.keys(updateItem.data).length > 0) {
        const { error: updateError } = await supabase
          .from(tableName)
          .update(updateItem.data)
          .eq('id', updateItem.id);

        if (updateError) {
          chunkErrors++;
          errorLog.push({ row: updateItem.rowIndex + 1, identifier: updateItem.identifierValue, error: updateError.message });
          continue;
        }
      }
      chunkUpdated++;

      if (updateItem.noteContent) {
        if (entityType === 'organization') {
          notesToCreate.push({
            organization_id: updateItem.id,
            member_id: authorMemberId,
            content: updateItem.noteContent,
            attachments: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        } else if (entityType === 'member') {
          memberNotesToCreate.push({
            target_member_id: updateItem.id,
            author_member_id: authorMemberId,
            content: updateItem.noteContent,
            attachments: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    sliceEnd = batchEnd;
  }

  const done = sliceEnd >= records.length;

  // Batch insert this slice's organization notes at once.
  if (notesToCreate.length > 0 && entityType === 'organization') {
    await supabase.from('organization_note').insert(notesToCreate);
  }

  // Batch insert this slice's member notes at once.
  if (memberNotesToCreate.length > 0 && entityType === 'member') {
    await supabase.from('member_note').insert(memberNotesToCreate);
  }

  const chunkNotes = notesToCreate.length + memberNotesToCreate.length;

  // Communication preferences for this slice's member imports. De-duplicated by
  // (member_id, category_id) — a single upsert batch cannot touch the same
  // conflict target twice, and a member can legitimately appear more than once.
  const commMappings = mappings.filter((m) => m.targetField?.startsWith('comm:'));
  if (entityType === 'member' && commMappings.length > 0) {
    const commPrefsByKey = new Map();

    for (let i = offset; i < sliceEnd; i++) {
      const row = records[i];
      const identifierValue = row[identifierMapping.sourceColumn]?.trim();
      if (!identifierValue) continue;

      const lookupKey = isEmailIdentifier ? identifierValue.toLowerCase() : identifierValue;
      const entityId = existingMap.get(lookupKey);
      if (!entityId) continue;

      for (const mapping of commMappings) {
        const categoryId = mapping.targetField.replace('comm:', '');
        if (!categoryId) continue;

        const rawValue = row[mapping.sourceColumn];
        const optedIn = parseBoolean(rawValue);

        if (optedIn !== null) {
          commPrefsByKey.set(`${entityId}|${categoryId}`, {
            member_id: entityId,
            category_id: categoryId,
            // Real column is is_subscribed (NOT opted_in); the old name
            // silently errored and dropped every imported preference.
            is_subscribed: optedIn,
            tenant_id: tenantId,
          });
        }
      }
    }

    const commPrefsToUpsert = Array.from(commPrefsByKey.values());
    if (commPrefsToUpsert.length > 0) {
      const authorizedPreferences = await filterImportCommunicationPreferences(
        supabase,
        tenantId,
        commPrefsToUpsert
      );
      const COMM_BATCH_SIZE = 500;
      for (let i = 0; i < authorizedPreferences.length; i += COMM_BATCH_SIZE) {
        const chunk = authorizedPreferences.slice(i, i + COMM_BATCH_SIZE);
        await supabase
          .from('member_communication_preference')
          .upsert(chunk, { onConflict: 'member_id,category_id' });
      }
    }
  }

  // Custom fields for this slice. De-duplicated by (entity_id, field_id). The
  // real column is `field_id` (NOT `preference_field_id`).
  const customMappings = mappings.filter((m) => m.targetField?.startsWith('custom:'));
  if (customMappings.length > 0) {
    const customValuesByKey = new Map();

    for (let i = offset; i < sliceEnd; i++) {
      const row = records[i];
      const identifierValue = row[identifierMapping.sourceColumn]?.trim();
      if (!identifierValue) continue;

      const lookupKey = isEmailIdentifier ? identifierValue.toLowerCase() : identifierValue;
      const entityId = existingMap.get(lookupKey);
      if (!entityId) continue;

      for (const mapping of customMappings) {
        if (!mapping.preferenceFieldId) continue;

        let value = row[mapping.sourceColumn];
        if (mapping.clearOnEmpty && (!value || value.trim() === '')) {
          value = null;
        }

        if (value !== null && mapping.targetType === 'date' && mapping.dateFormat) {
          const parsedDate = parseDate(value, mapping.dateFormat);
          if (parsedDate) value = parsedDate;
        }

        customValuesByKey.set(`${entityId}|${mapping.preferenceFieldId}`, {
          [entityIdField]: entityId,
          field_id: mapping.preferenceFieldId,
          value: value?.trim?.() || value,
        });
      }
    }

    const customValuesToUpsert = Array.from(customValuesByKey.values());
    if (customValuesToUpsert.length > 0) {
      const CUSTOM_BATCH_SIZE = 500;
      for (let i = 0; i < customValuesToUpsert.length; i += CUSTOM_BATCH_SIZE) {
        const chunk = customValuesToUpsert.slice(i, i + CUSTOM_BATCH_SIZE);
        await supabase
          .from(customValueTable)
          .upsert(chunk, { onConflict: `${entityIdField},field_id` });
      }
    }
  }

  runningCreated += chunkCreated;
  runningUpdated += chunkUpdated;
  runningSkipped += chunkSkipped;
  runningErrors += chunkErrors;
  runningNotes += chunkNotes;

  const result = {
    done,
    path: jsPathHint,
    offset: sliceEnd,
    created: runningCreated,
    updated: runningUpdated,
    skipped: runningSkipped,
    errors: runningErrors,
    notes: runningNotes,
    errorLog,
  };

  if (done) {
    result.summary = {
      totalRows: records.length,
      processedRows: runningCreated + runningUpdated,
      createdRows: runningCreated,
      updatedRows: runningUpdated,
      skippedRows: runningSkipped,
      errorRows: runningErrors,
      notesCreated: runningNotes,
    };
  }

  return result;
}
