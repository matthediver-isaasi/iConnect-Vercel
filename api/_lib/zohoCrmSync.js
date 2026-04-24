import crypto from 'crypto';
import { supabase } from './database.js';
import {
  upsertZohoCrmRecord,
  updateZohoCrmRecordById,
  updateZohoCrmRecordRichText,
  isZohoCrmConnected,
  zohoCrmApiCall,
  searchZohoCrmRecords,
  fetchZohoCrmRecordRichText
} from './zohoCrmClient.js';

/**
 * Merge a record's rich-text field values into the record JSON before the
 * normal field-mapping pipeline runs. Zoho excludes rich-text fields from
 * the regular `GET /{module}/{id}` payload — without this enrichment any
 * mapping that targets a rich-text field arrives with `null` and overwrites
 * good iConnect data with empty.
 *
 * Gating is read-only: the mapping save endpoint (`api/admin/zoho-crm-sync/
 * mappings.js`) stamps `is_rich_text: true` on each field-mapping row whose
 * Zoho field is rich-text. Here we only check that flag — no live metadata
 * call — so mappings without any rich-text fields incur ZERO extra Zoho API
 * calls per inbound record. Already-populated values short-circuit the per-
 * field fetch (handles the case where a future Zoho behaviour starts
 * inlining rich-text in the regular payload). Per-record rich-text fetch
 * failures are non-fatal: warn + continue, leave the field null.
 */
async function enrichRecordWithRichText(tenantId, mapping, zohoModule, zohoRecord) {
  if (!zohoRecord || typeof zohoRecord !== 'object') return zohoRecord;
  const fieldMappings = Array.isArray(mapping?.field_mappings) ? mapping.field_mappings : [];
  if (fieldMappings.length === 0) return zohoRecord;
  const wanted = fieldMappings
    .filter(m => m?.is_rich_text === true && m.zoho_field)
    .map(m => m.zoho_field);
  if (wanted.length === 0) return zohoRecord;
  const recordId = zohoRecord.id || zohoRecord.Id;
  if (!recordId) return zohoRecord;
  const missing = wanted.filter(name => zohoRecord[name] == null || zohoRecord[name] === '');
  if (missing.length === 0) return zohoRecord;
  try {
    const rt = await fetchZohoCrmRecordRichText(tenantId, zohoModule, recordId, missing);
    return { ...zohoRecord, ...rt };
  } catch (err) {
    console.warn('[ZohoCrmSync] Rich-text fetch failed for', zohoModule, recordId, '-', err?.message || err);
    return zohoRecord;
  }
}

const ENTITY_TABLE = {
  member: 'member',
  organization: 'organization'
};

const PREF_VALUE_TABLE = {
  member: 'member_preference_value',
  organization: 'organization_preference_value'
};

const PREF_VALUE_FK = {
  member: 'member_id',
  organization: 'organization_id'
};

const ECHO_DEBOUNCE_MS = 30 * 1000;

// In-memory tracker of entities recently written by an inbound Zoho sync.
// Any outbound sync triggered for the same entity within the TTL is short-
// circuited regardless of who calls `triggerZohoCrmSync`. This is the
// first-line origin-loop guard; the payload-hash debounce is the second.
const inboundOriginTracker = new Map();
const INBOUND_ORIGIN_TTL_MS = 30 * 1000;

function inboundOriginKey(tenantId, entityType, entityId) {
  return `${tenantId}:${entityType}:${entityId}`;
}

function markInboundOrigin(tenantId, entityType, entityId) {
  if (!tenantId || !entityType || !entityId) return;
  const key = inboundOriginKey(tenantId, entityType, entityId);
  inboundOriginTracker.set(key, Date.now() + INBOUND_ORIGIN_TTL_MS);
}

function hasInboundOrigin(tenantId, entityType, entityId) {
  const key = inboundOriginKey(tenantId, entityType, entityId);
  const expiresAt = inboundOriginTracker.get(key);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    inboundOriginTracker.delete(key);
    return false;
  }
  return true;
}

// Periodic cleanup to keep the tracker bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of inboundOriginTracker) {
    if (now > exp) inboundOriginTracker.delete(k);
  }
}, 60 * 1000).unref?.();

function computeHash(obj) {
  try {
    const normalized = JSON.stringify(sortKeys(obj || {}));
    return crypto.createHash('sha256').update(normalized).digest('hex');
  } catch {
    return null;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => {
      acc[k] = sortKeys(value[k]);
      return acc;
    }, {});
  }
  return value;
}

async function loadEntity(tenantId, entityType, entityId) {
  const table = ENTITY_TABLE[entityType];
  if (!table) throw new Error(`Unsupported entity type: ${entityType}`);
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('id', entityId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadCustomFieldValues(tenantId, entityType, entityId) {
  const table = PREF_VALUE_TABLE[entityType];
  const fk = PREF_VALUE_FK[entityType];
  if (!table || !fk) return {};
  const { data, error } = await supabase
    .from(table)
    .select('field_id, value, preference_field:field_id(id, label, name)')
    .eq(fk, entityId);
  if (error) {
    console.error('[ZohoCrmSync] Failed to load custom values:', error);
    return {};
  }
  const result = {};
  for (const row of data || []) {
    if (row.field_id) result[row.field_id] = row.value;
  }
  return result;
}

function resolveMappedValue(mapping, entity, customValues) {
  const src = mapping.iconnect_field;
  if (!src) return undefined;
  if (src.startsWith('custom:')) {
    const fieldId = src.slice('custom:'.length);
    return customValues[fieldId];
  }
  return entity?.[src];
}

/**
 * Apply a per-row value translation in the requested direction. Returns the
 * translated value when a mapping exists, otherwise the original value. When
 * the row has a value_map but the value is not in it, push a warning entry
 * onto `warnings` so the caller can surface unmapped values to the sync log.
 */
function applyValueMap(mapping, value, direction, warnings) {
  if (value === undefined || value === null || value === '') return value;
  const vm = mapping?.value_map;
  if (!vm || typeof vm !== 'object') return value;
  const dir = direction === 'iconnect_to_zoho' ? vm.iconnect_to_zoho : vm.zoho_to_iconnect;
  if (!dir || typeof dir !== 'object' || Object.keys(dir).length === 0) return value;
  const key = String(value);
  if (Object.prototype.hasOwnProperty.call(dir, key)) {
    return dir[key];
  }
  if (Array.isArray(warnings)) {
    warnings.push({
      direction,
      iconnect_field: mapping.iconnect_field,
      zoho_field: mapping.zoho_field,
      unmapped_value: key
    });
  }
  return value;
}

function buildPayload(mappings, entity, customValues, warnings) {
  const payload = {};
  for (const m of mappings || []) {
    if (!m?.zoho_field) continue;
    const raw = resolveMappedValue(m, entity, customValues);
    if (raw === undefined || raw === null || raw === '') continue;
    const translated = applyValueMap(m, raw, 'iconnect_to_zoho', warnings);
    payload[m.zoho_field] = translated;
  }
  return payload;
}

/**
 * Build a canonical payload — keyed by iConnect field name (or `custom:<id>`
 * for preference fields) — for hash-based echo/loop detection. The same
 * shape is produced from either direction so outbound and inbound hashes
 * are directly comparable.
 */
function buildCanonicalPayload(mappings, entity, customValues) {
  const canonical = {};
  for (const m of mappings || []) {
    if (!m?.iconnect_field || !m?.zoho_field) continue;
    const v = resolveMappedValue(m, entity, customValues);
    if (v === undefined || v === null || v === '') continue;
    canonical[m.iconnect_field] = v;
  }
  return canonical;
}

export async function writeSyncLog(row) {
  return writeLog(row);
}

async function writeLog(row) {
  try {
    const { data, error } = await supabase
      .from('zoho_crm_sync_log')
      .insert({ direction: 'outbound', ...row })
      .select()
      .single();
    if (error) {
      console.error('[ZohoCrmSync] Failed to write log:', error);
      return null;
    }
    return data;
  } catch (err) {
    console.error('[ZohoCrmSync] Log insert exception:', err);
    return null;
  }
}

async function persistZohoIdOnEntity(tenantId, entityType, entityId, zohoId, zohoModule) {
  if (!zohoId) return;
  const table = ENTITY_TABLE[entityType];
  try {
    await supabase
      .from(table)
      .update({ zoho_crm_id: zohoId, zoho_crm_module: zohoModule })
      .eq('id', entityId)
      .eq('tenant_id', tenantId);
  } catch (err) {
    console.error('[ZohoCrmSync] Failed to persist zoho_crm_id:', err);
  }
}

async function getSyncState(tenantId, entityType, entityId, direction) {
  const { data } = await supabase
    .from('zoho_crm_sync_state')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .eq('direction', direction)
    .maybeSingle();
  return data || null;
}

async function recordSyncState(tenantId, entityType, entityId, direction, hash) {
  if (!hash) return;
  try {
    await supabase
      .from('zoho_crm_sync_state')
      .upsert({
        tenant_id: tenantId,
        entity_type: entityType,
        entity_id: entityId,
        direction,
        payload_hash: hash,
        last_synced_at: new Date().toISOString()
      }, { onConflict: 'tenant_id,entity_type,entity_id,direction' });
  } catch (err) {
    console.error('[ZohoCrmSync] Failed to record sync state:', err);
  }
}

/**
 * Outbound: push the iConnect entity to Zoho CRM.
 */
export async function syncEntityToZohoCrm(tenantId, entityType, entityId, options = {}) {
  if (!tenantId || !entityType || !entityId) {
    console.warn('[ZohoCrmSync] Missing params, skipping');
    return null;
  }
  const action = options.action || 'sync';
  const source = options.source || 'trigger';

  // Origin loop short-circuit: do not push back out a write that originated
  // from an inbound sync from Zoho. Two layers:
  //   1. Explicit `fromInbound` option (when callers know).
  //   2. In-memory tracker that records every inbound write for 30s, so
  //      indirect callers (e.g. PATCH endpoints, realtime relays) cannot
  //      accidentally bounce an inbound write back out.
  if (options.fromInbound || hasInboundOrigin(tenantId, entityType, entityId)) {
    console.log('[ZohoCrmSync] Outbound short-circuited (origin: inbound)');
    return null;
  }

  try {
    const { data: mapping, error: mappingErr } = await supabase
      .from('zoho_crm_sync_mapping')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('entity_type', entityType)
      .maybeSingle();
    if (mappingErr) throw mappingErr;
    if (!mapping || !mapping.is_enabled) return null;

    // Honour sync_direction: only push if outbound or bidirectional.
    const direction = mapping.sync_direction || 'outbound';
    if (direction === 'inbound') {
      return null;
    }

    const connected = await isZohoCrmConnected(tenantId);
    if (!connected) {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, status: 'failed', action, source,
        error_message: 'Zoho CRM is not connected for this tenant'
      });
    }

    const entity = await loadEntity(tenantId, entityType, entityId);
    if (!entity) {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, status: 'failed', action, source,
        error_message: 'Entity not found'
      });
    }

    const customValues = await loadCustomFieldValues(tenantId, entityType, entityId);
    const translationWarnings = [];
    const payload = buildPayload(mapping.field_mappings, entity, customValues, translationWarnings);
    const canonicalPayload = buildCanonicalPayload(mapping.field_mappings, entity, customValues);
    if (translationWarnings.length > 0) {
      console.warn('[ZohoCrmSync] Outbound value translation gaps:', translationWarnings);
    }

    if (Object.keys(payload).length === 0) {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, status: 'skipped', action, source,
        error_message: 'No mapped fields had a value to sync'
      });
    }

    // Canonical hash (iConnect-keyed) so it can be compared against inbound
    // payload hashes from `applyInboundFromZoho`.
    const payloadHash = computeHash(canonicalPayload);

    // Echo / no-op detection. If we already pushed this exact payload, skip.
    const lastOutbound = await getSyncState(tenantId, entityType, entityId, 'outbound');
    if (lastOutbound && lastOutbound.payload_hash === payloadHash) {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, status: 'skipped', action, source,
        payload_hash: payloadHash,
        error_message: 'No-op: payload identical to last outbound sync'
      });
    }

    // Inbound debounce: if Zoho just pushed us this exact payload moments ago,
    // do not echo it back.
    const lastInbound = await getSyncState(tenantId, entityType, entityId, 'inbound');
    if (lastInbound && lastInbound.payload_hash === payloadHash &&
        Date.now() - new Date(lastInbound.last_synced_at).getTime() < ECHO_DEBOUNCE_MS) {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, status: 'skipped', action, source,
        payload_hash: payloadHash,
        error_message: 'Debounced: matches recent inbound sync'
      });
    }

    // Rich-text fields must be written via Zoho's dedicated
    // `PUT /{module}/{record_id}/Rich_Text__s` endpoint. Inlining them in
    // the standard /{module} update is documented as supported but is
    // reported to silently drop the value on some tenants — driving iConnect
    // and Zoho out of sync. We split the payload here so the regular fields
    // continue to ride the normal endpoint and rich-text fields use the
    // documented symmetric counterpart of `fetchZohoCrmRecordRichText`. The
    // `is_rich_text` flag is stamped at mapping save (see
    // `api/admin/zoho-crm-sync/mappings.js`) so this needs zero extra Zoho
    // metadata calls per outbound sync.
    const richTextZohoFields = new Set(
      (mapping.field_mappings || [])
        .filter(m => m?.is_rich_text === true && m?.zoho_field)
        .map(m => m.zoho_field)
    );
    const regularPayload = {};
    const richTextPayload = {};
    for (const [k, v] of Object.entries(payload)) {
      if (richTextZohoFields.has(k)) {
        richTextPayload[k] = v;
      } else {
        regularPayload[k] = v;
      }
    }

    const mechanismsUsed = [];
    let result;
    let zohoRecordId = entity.zoho_crm_id;

    if (zohoRecordId && entity.zoho_crm_module === mapping.zoho_module) {
      if (Object.keys(regularPayload).length > 0) {
        result = await updateZohoCrmRecordById(tenantId, mapping.zoho_module, zohoRecordId, regularPayload);
        mechanismsUsed.push(`update_by_id:${Object.keys(regularPayload).length}`);
      } else {
        // All mapped values were rich-text — no work for the standard
        // endpoint. Synthesize a success so the rich-text write below can
        // still run against the known record id.
        result = { success: true, id: zohoRecordId, action: 'update', details: { id: zohoRecordId } };
        mechanismsUsed.push('update_by_id:skipped_no_regular_fields');
      }
    } else {
      // Upsert path. Without a non-rich-text payload Zoho's upsert has
      // nothing to dedupe on, so fail loud rather than create a blank
      // record. In practice unique_key_field (Email/Account_Name/etc.) is
      // never rich-text so this branch is defensive.
      if (Object.keys(regularPayload).length === 0) {
        result = {
          success: false,
          error: 'Cannot upsert a new Zoho record using only rich-text fields — at least one non-rich-text mapped field (including the unique key) must have a value'
        };
        mechanismsUsed.push('upsert:skipped_no_regular_fields');
      } else {
        result = await upsertZohoCrmRecord(tenantId, mapping.zoho_module, regularPayload, mapping.unique_key_field);
        mechanismsUsed.push(`upsert:${Object.keys(regularPayload).length}`);
      }
    }

    // Rich-text write: independent of and non-fatal to the regular update.
    // Per task #413, a rich-text-specific failure must NOT mask the success
    // of other field updates — we surface it via the log instead.
    let richTextResult = null;
    if (result.success && Object.keys(richTextPayload).length > 0) {
      zohoRecordId = result.id || zohoRecordId;
      if (zohoRecordId) {
        try {
          richTextResult = await updateZohoCrmRecordRichText(
            tenantId, mapping.zoho_module, zohoRecordId, richTextPayload
          );
          if (richTextResult.success) {
            mechanismsUsed.push(`rich_text_dedicated:${Object.keys(richTextPayload).length}`);
          } else {
            mechanismsUsed.push(`rich_text_dedicated_failed:${richTextResult.error || 'unknown'}`);
            console.warn('[ZohoCrmSync] Rich-text write failed for', entityType, entityId, '-', richTextResult.error);
          }
        } catch (rtErr) {
          richTextResult = { success: false, error: rtErr?.message || String(rtErr) };
          mechanismsUsed.push(`rich_text_dedicated_threw:${richTextResult.error}`);
          console.warn('[ZohoCrmSync] Rich-text write threw for', entityType, entityId, '-', rtErr?.message || rtErr);
        }
      } else {
        mechanismsUsed.push('rich_text_dedicated_skipped:no_record_id');
      }
    }

    console.log('[ZohoCrmSync] Outbound mechanisms:', mechanismsUsed.join(' + '));

    const warningSuffix = translationWarnings.length > 0
      ? ` [translation warnings: ${translationWarnings
          .map(w => `${w.iconnect_field}→${w.zoho_field}="${w.unmapped_value}"`).join('; ')}]`
      : '';
    const richTextSuffix = (richTextResult && !richTextResult.success)
      ? ` [rich-text write failed: ${richTextResult.error || 'unknown'} — other fields synced OK]`
      : '';

    if (result.success) {
      await persistZohoIdOnEntity(tenantId, entityType, entityId, result.id, mapping.zoho_module);
      // Only stamp the outbound payload hash if the *full* sync (regular
      // + rich-text legs) landed cleanly. If the rich-text leg failed, a
      // future sync of the identical payload should still run so the
      // dedicated rich-text endpoint can be retried — recording the hash
      // here would no-op that retry (see lastOutbound short-circuit
      // above) and let the rich-text drift sit until an unrelated field
      // change forces a new payload.
      const richTextLegFailed = !!(richTextResult && !richTextResult.success);
      if (!richTextLegFailed) {
        await recordSyncState(tenantId, entityType, entityId, 'outbound', payloadHash);
      }
      const okMessage = (warningSuffix || richTextSuffix)
        ? `OK${warningSuffix}${richTextSuffix}`
        : null;
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, zoho_record_id: result.id,
        status: 'success', action: result.action || action, source,
        payload_hash: payloadHash,
        error_message: okMessage,
        request_payload: payload,
        response_payload: {
          ...(result.details || {}),
          mechanisms: mechanismsUsed,
          ...(richTextResult ? { rich_text_result: richTextResult.success
              ? { success: true, fields: Object.keys(richTextPayload) }
              : { success: false, error: richTextResult.error, fields: Object.keys(richTextPayload) } } : {}),
          ...(translationWarnings.length > 0 ? { translation_warnings: translationWarnings } : {})
        }
      });
    }

    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
      zoho_module: mapping.zoho_module, status: 'failed', action, source,
      payload_hash: payloadHash,
      error_message: (result.error || 'Unknown failure') + warningSuffix + richTextSuffix,
      request_payload: payload,
      response_payload: {
        ...(result.details || result.raw || {}),
        mechanisms: mechanismsUsed,
        ...(translationWarnings.length > 0 ? { translation_warnings: translationWarnings } : {})
      }
    });
  } catch (err) {
    console.error('[ZohoCrmSync] Sync failed:', err);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
      status: 'failed', action, source,
      error_message: err?.message || String(err)
    });
  }
}

/**
 * Fire-and-forget wrapper. Pass `fromInbound: true` to suppress outbound echo.
 */
export function triggerZohoCrmSync(tenantId, entityType, entityId, options = {}) {
  if (!tenantId || !entityType || !entityId) return;
  if (entityType !== 'member' && entityType !== 'organization') return;
  Promise.resolve()
    .then(() => syncEntityToZohoCrm(tenantId, entityType, entityId, options))
    .catch(err => console.error('[ZohoCrmSync] Background sync error:', err));
}

export async function retryZohoCrmSyncLog(tenantId, logId) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!logId) throw new Error('logId is required');
  const { data: log, error } = await supabase
    .from('zoho_crm_sync_log')
    .select('*')
    .eq('id', logId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!log) throw new Error('Log entry not found');
  if (!log.entity_id || !log.entity_type) {
    throw new Error('Log entry has no entity to retry');
  }
  // Inbound logs retry through the inbound path with the ORIGINAL Zoho
  // payload (request_payload is always the raw Zoho record for inbound logs).
  if (log.direction === 'inbound') {
    if (!log.zoho_module) throw new Error('Inbound log missing zoho_module');
    const rawPayload = log.request_payload || {};
    if (!rawPayload || (typeof rawPayload === 'object' && Object.keys(rawPayload).length === 0)) {
      throw new Error('Inbound log has no original Zoho payload to replay');
    }
    if (!rawPayload.id && log.zoho_record_id) rawPayload.id = log.zoho_record_id;
    return await applyInboundFromZoho(tenantId, log.zoho_module, rawPayload, { source: 'retry' });
  }
  return await syncEntityToZohoCrm(log.tenant_id, log.entity_type, log.entity_id, { action: 'retry', source: 'retry' });
}

// ===========================================================================
// Reverse sync: Zoho CRM → iConnect
// ===========================================================================

const MODULE_TO_ENTITY_TYPE = {
  Contacts: 'member',
  Leads: 'member',
  Accounts: 'organization'
};

/**
 * Build an iConnect update payload from a Zoho CRM record by reversing the
 * configured field_mappings. Returns { coreUpdates, customUpdates } where
 * `customUpdates` is a map of preference_field id → value to upsert.
 */
function buildReversePayload(mapping, zohoRecord, warnings) {
  const coreUpdates = {};
  const customUpdates = {};
  for (const m of mapping.field_mappings || []) {
    const zohoField = m?.zoho_field;
    const iconnectField = m?.iconnect_field;
    if (!zohoField || !iconnectField) continue;
    if (!Object.prototype.hasOwnProperty.call(zohoRecord, zohoField)) continue;
    const raw = zohoRecord[zohoField];
    const value = applyValueMap(m, raw, 'zoho_to_iconnect', warnings);
    if (iconnectField.startsWith('custom:')) {
      const fieldId = iconnectField.slice('custom:'.length);
      customUpdates[fieldId] = value;
    } else {
      coreUpdates[iconnectField] = value;
    }
  }
  return { coreUpdates, customUpdates };
}

async function findEntityByZohoId(tenantId, entityType, zohoModule, zohoId) {
  const table = ENTITY_TABLE[entityType];
  if (!table) return null;
  // Prefer an exact match on (zoho_crm_id, zoho_crm_module) — but fall back
  // to a module-agnostic match so legacy records linked before
  // `zoho_crm_module` was populated still resolve. Within a tenant, a Zoho
  // record id is effectively unique across modules in practice, and we only
  // call this when the module came from the inbound webhook anyway.
  const { data: scoped } = await supabase
    .from(table)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('zoho_crm_id', zohoId)
    .eq('zoho_crm_module', zohoModule)
    .maybeSingle();
  if (scoped) return scoped;
  const { data: fallback } = await supabase
    .from(table)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('zoho_crm_id', zohoId)
    .or('zoho_crm_module.is.null,zoho_crm_module.eq.' + zohoModule)
    .limit(2);
  if (Array.isArray(fallback) && fallback.length === 1) {
    // Backfill the module so subsequent lookups take the scoped path.
    await persistZohoIdOnEntity(tenantId, entityType, fallback[0].id, zohoId, zohoModule);
    return fallback[0];
  }
  return null;
}

// Returns one of:
//   { entity: <row> }                 — exactly one match
//   { entity: null, reason: 'none' }  — no rows
//   { entity: null, reason: 'ambiguous', count: N } — multiple matches
//   { entity: null, reason: 'error', error: <msg> }
async function findEntityByUniqueField(tenantId, entityType, fieldName, value) {
  if (!fieldName || value === undefined || value === null || value === '') {
    return { entity: null, reason: 'none' };
  }
  const table = ENTITY_TABLE[entityType];
  if (!table) return { entity: null, reason: 'none' };
  try {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('tenant_id', tenantId)
      .eq(fieldName, value)
      .limit(2);
    if (error) return { entity: null, reason: 'error', error: error.message };
    if (!Array.isArray(data) || data.length === 0) return { entity: null, reason: 'none' };
    if (data.length > 1) return { entity: null, reason: 'ambiguous', count: data.length };
    return { entity: data[0] };
  } catch (err) {
    return { entity: null, reason: 'error', error: err?.message || String(err) };
  }
}

function resolveLocalKeyForZohoUnique(mapping) {
  // Map the configured Zoho unique_key_field back to the iConnect column it
  // was paired with in field_mappings (only useful when that pairing is a
  // core field, not a custom: one).
  const m = (mapping.field_mappings || []).find(r => r.zoho_field === mapping.unique_key_field);
  if (!m) return null;
  if (!m.iconnect_field || m.iconnect_field.startsWith('custom:')) return null;
  return m.iconnect_field;
}

function formatStoredCustomValue(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function applyCustomFieldUpdates(tenantId, entityType, entityId, customUpdates) {
  const fk = PREF_VALUE_FK[entityType];
  const table = PREF_VALUE_TABLE[entityType];
  if (!fk || !table) return;
  for (const [fieldId, value] of Object.entries(customUpdates)) {
    const stored = formatStoredCustomValue(value);
    const { data: existing, error: selectError } = await supabase
      .from(table)
      .select('id')
      .eq(fk, entityId)
      .eq('field_id', fieldId)
      .maybeSingle();
    if (selectError) {
      throw new Error(`Failed to read custom value (field_id=${fieldId}): ${selectError.message}`);
    }
    if (existing) {
      const { error: updateError } = await supabase
        .from(table)
        .update({ value: stored, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (updateError) {
        throw new Error(`Failed to update custom value (field_id=${fieldId}): ${updateError.message}`);
      }
    } else {
      const { error: insertError } = await supabase
        .from(table)
        .insert({ [fk]: entityId, field_id: fieldId, value: stored });
      if (insertError) {
        throw new Error(`Failed to insert custom value (field_id=${fieldId}): ${insertError.message}`);
      }
    }
  }
}

/**
 * Apply an inbound Zoho CRM record to the matching iConnect entity.
 * Performs loop / echo detection, conflict resolution, and writes a log entry.
 */
export async function applyInboundFromZoho(tenantId, zohoModule, zohoRecord, options = {}) {
  const source = options.source || 'webhook';
  const entityType = MODULE_TO_ENTITY_TYPE[zohoModule];
  if (!entityType) {
    return await writeLog({
      tenant_id: tenantId, entity_type: 'unknown',
      zoho_module: zohoModule, status: 'failed',
      direction: 'inbound', source, action: 'inbound',
      error_message: `Unsupported Zoho module: ${zohoModule}`
    });
  }

  // Mapping lookup — must match the incoming Zoho module so that, for
  // example, a Contacts webhook is never processed against a Leads-mapped
  // member configuration.
  const { data: mapping } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .eq('zoho_module', zohoModule)
    .maybeSingle();

  if (!mapping || !mapping.is_enabled) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType,
      zoho_module: zohoModule, status: 'skipped',
      direction: 'inbound', source, action: 'inbound',
      error_message: `No enabled mapping configured for tenant/entity/module (${entityType}/${zohoModule})`
    });
  }

  const direction = mapping.sync_direction || 'outbound';
  if (direction === 'outbound') {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType,
      zoho_module: zohoModule, status: 'skipped',
      direction: 'inbound', source, action: 'inbound',
      error_message: 'Mapping is outbound-only — inbound dropped'
    });
  }

  // Merge rich-text values that Zoho hides from the regular GET payload.
  // No-op for mappings without rich-text fields.
  zohoRecord = await enrichRecordWithRichText(tenantId, mapping, zohoModule, zohoRecord);

  const zohoId = zohoRecord?.id || zohoRecord?.Id || null;
  let entity = null;
  // Track every match attempt so the skip log can explain what failed instead
  // of just emitting the bare "No matching iConnect record" message that is
  // impossible to act on from the admin UI.
  const matchAttempts = [];
  if (zohoId) {
    entity = await findEntityByZohoId(tenantId, entityType, zohoModule, zohoId);
    matchAttempts.push(entity
      ? `zoho_crm_id=${zohoId} matched`
      : `zoho_crm_id=${zohoId} not linked to any iConnect ${entityType}`);
  } else {
    matchAttempts.push('Zoho payload had no id field');
  }
  if (!entity) {
    const localKey = resolveLocalKeyForZohoUnique(mapping);
    if (!localKey) {
      matchAttempts.push(
        `unique_key_field "${mapping.unique_key_field || '(unset)'}" is not paired with a core iConnect column in field_mappings — cannot match by unique key`
      );
    } else {
      const matchValue = zohoRecord[mapping.unique_key_field];
      const result = await findEntityByUniqueField(tenantId, entityType, localKey, matchValue);
      if (result.entity) {
        entity = result.entity;
        matchAttempts.push(`${localKey}="${matchValue}" matched 1 iConnect ${entityType}`);
        if (zohoId) {
          await persistZohoIdOnEntity(tenantId, entityType, entity.id, zohoId, zohoModule);
        }
      } else if (result.reason === 'ambiguous') {
        matchAttempts.push(
          `${localKey}="${matchValue}" is not unique — ${result.count}+ iConnect ${entityType} rows matched`
        );
      } else if (result.reason === 'error') {
        matchAttempts.push(`${localKey} lookup errored: ${result.error}`);
      } else {
        const valueRepr = matchValue === undefined || matchValue === null || matchValue === ''
          ? '(empty)'
          : `"${matchValue}"`;
        matchAttempts.push(`${localKey}=${valueRepr} did not match any iConnect ${entityType}`);
      }
    }
  }

  if (!entity) {
    const policy = mapping.unmatched_policy || 'ignore';
    const detail = matchAttempts.join('; ');
    if (policy === 'queue') {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: null,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'pending', direction: 'inbound', source, action: 'inbound',
        error_message: `Queued: no matching iConnect record (policy=queue) — ${detail}`,
        request_payload: zohoRecord
      });
    }
    if (policy === 'create') {
      return await createEntityFromZoho(tenantId, entityType, mapping, zohoModule, zohoRecord, source);
    }
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: null,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action: 'inbound',
      error_message: `No matching iConnect record (policy=ignore) — ${detail}`,
      request_payload: zohoRecord
    });
  }

  const inboundWarnings = [];
  const { coreUpdates, customUpdates } = buildReversePayload(mapping, zohoRecord, inboundWarnings);
  if (inboundWarnings.length > 0) {
    console.warn('[ZohoCrmSync] Inbound value translation gaps:', inboundWarnings);
  }
  const inboundWarningSuffix = inboundWarnings.length > 0
    ? ` [translation warnings: ${inboundWarnings
        .map(w => `${w.zoho_field}→${w.iconnect_field}="${w.unmapped_value}"`).join('; ')}]`
    : '';
  const combinedPayload = { ...coreUpdates, ...Object.fromEntries(Object.entries(customUpdates).map(([k, v]) => [`custom:${k}`, v])) };

  if (Object.keys(combinedPayload).length === 0) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action: 'inbound',
      error_message: 'Inbound payload had no mapped fields',
      request_payload: zohoRecord
    });
  }

  const payloadHash = computeHash(combinedPayload);

  // Echo: this exact payload was just pushed outbound — drop.
  const lastOutbound = await getSyncState(tenantId, entityType, entity.id, 'outbound');
  if (lastOutbound && lastOutbound.payload_hash === payloadHash &&
      Date.now() - new Date(lastOutbound.last_synced_at).getTime() < ECHO_DEBOUNCE_MS) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action: 'inbound',
      payload_hash: payloadHash,
      error_message: 'Debounced: echo of recent outbound sync',
      request_payload: zohoRecord
    });
  }

  // No-op: same content as the last inbound write.
  const lastInbound = await getSyncState(tenantId, entityType, entity.id, 'inbound');
  if (lastInbound && lastInbound.payload_hash === payloadHash) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action: 'inbound',
      payload_hash: payloadHash,
      error_message: 'No-op: payload identical to last inbound sync',
      request_payload: zohoRecord
    });
  }

  // Conflict resolution. Compare Zoho Modified_Time vs entity.updated_at.
  const conflictPolicy = mapping.conflict_policy || 'last_write_wins';
  const zohoModifiedTime = zohoRecord.Modified_Time || zohoRecord.modified_time || null;
  const localUpdatedAt = entity.updated_at || null;
  let conflictResolution = 'no_conflict';
  if (lastInbound && localUpdatedAt &&
      new Date(localUpdatedAt).getTime() > new Date(lastInbound.last_synced_at).getTime()) {
    // Local has changed since the last successful inbound sync → potential conflict.
    if (conflictPolicy === 'iconnect_wins') {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'skipped', direction: 'inbound', source, action: 'inbound',
        payload_hash: payloadHash,
        conflict_resolution: 'iconnect_wins',
        error_message: 'Conflict: iConnect has newer changes (policy=iconnect_wins)',
        request_payload: zohoRecord
      });
    }
    if (conflictPolicy === 'last_write_wins') {
      const zohoTime = zohoModifiedTime ? new Date(zohoModifiedTime).getTime() : 0;
      const localTime = new Date(localUpdatedAt).getTime();
      if (localTime > zohoTime) {
        return await writeLog({
          tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
          zoho_module: zohoModule, zoho_record_id: zohoId,
          status: 'skipped', direction: 'inbound', source, action: 'inbound',
          payload_hash: payloadHash,
          conflict_resolution: 'last_write_wins:iconnect_newer',
          error_message: 'Conflict: iConnect updated_at newer than Zoho Modified_Time',
          request_payload: zohoRecord
        });
      }
      conflictResolution = 'last_write_wins:zoho_newer';
    } else {
      conflictResolution = 'zoho_wins';
    }
  }

  // No-change guard: if every resolved inbound value already matches the
  // current entity / custom-field value, skip the write entirely so we
  // don't bump updated_at and create avoidable churn.
  const currentCustomValues = await loadCustomFieldValues(tenantId, entityType, entity.id);
  const coreChanged = {};
  for (const [k, v] of Object.entries(coreUpdates)) {
    if (entity?.[k] !== v) coreChanged[k] = v;
  }
  const customChanged = {};
  for (const [k, v] of Object.entries(customUpdates)) {
    if (currentCustomValues[k] !== v) customChanged[k] = v;
  }
  if (Object.keys(coreChanged).length === 0 && Object.keys(customChanged).length === 0) {
    await recordSyncState(tenantId, entityType, entity.id, 'inbound', payloadHash);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action: 'inbound',
      payload_hash: payloadHash,
      conflict_resolution: conflictResolution,
      error_message: 'No-op: every mapped value already matches the iConnect record',
      request_payload: zohoRecord
    });
  }

  // Apply update. Mark inbound origin BEFORE the write so any indirectly
  // triggered outbound sync from a downstream listener is short-circuited.
  markInboundOrigin(tenantId, entityType, entity.id);
  const table = ENTITY_TABLE[entityType];
  try {
    if (Object.keys(coreChanged).length > 0) {
      const { error } = await supabase
        .from(table)
        .update({ ...coreChanged, updated_at: new Date().toISOString() })
        .eq('id', entity.id)
        .eq('tenant_id', tenantId);
      if (error) throw error;
    }
    if (Object.keys(customChanged).length > 0) {
      await applyCustomFieldUpdates(tenantId, entityType, entity.id, customChanged);
    }

    await recordSyncState(tenantId, entityType, entity.id, 'inbound', payloadHash);

    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'success', direction: 'inbound', source, action: 'inbound',
      payload_hash: payloadHash,
      conflict_resolution: conflictResolution,
      error_message: inboundWarningSuffix ? `OK${inboundWarningSuffix}` : null,
      request_payload: zohoRecord,
      response_payload: {
        core: coreChanged,
        custom: customChanged,
        ...(inboundWarnings.length > 0 ? { translation_warnings: inboundWarnings } : {})
      }
    });
  } catch (err) {
    console.error('[ZohoCrmSync] Inbound write failed:', err);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'failed', direction: 'inbound', source, action: 'inbound',
      payload_hash: payloadHash,
      conflict_resolution: conflictResolution,
      error_message: (err?.message || String(err)) + inboundWarningSuffix,
      request_payload: zohoRecord,
      response_payload: {
        core: coreChanged,
        custom: customChanged,
        ...(inboundWarnings.length > 0 ? { translation_warnings: inboundWarnings } : {})
      }
    });
  }
}

/**
 * Create a new iConnect entity from a Zoho record under the `create`
 * unmatched policy. Sets zoho_crm_id immediately so future inbound updates
 * find the record by id and never re-create. Marks inbound origin so any
 * downstream trigger doesn't echo the new record back to Zoho.
 */
async function createEntityFromZoho(tenantId, entityType, mapping, zohoModule, zohoRecord, source) {
  const zohoId = zohoRecord?.id || zohoRecord?.Id || null;
  const inboundWarnings = [];
  const { coreUpdates, customUpdates } = buildReversePayload(mapping, zohoRecord, inboundWarnings);
  if (inboundWarnings.length > 0) {
    console.warn(`[ZohoCrmSync] Inbound translation warnings on create (entity=${entityType} zoho_id=${zohoId}):`, inboundWarnings);
  }

  if (Object.keys(coreUpdates).length === 0 && Object.keys(customUpdates).length === 0) {
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: null,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'skipped', direction: 'inbound', source, action: 'create',
      error_message: 'Inbound payload had no mapped fields — cannot create',
      request_payload: zohoRecord
    });
  }

  const table = ENTITY_TABLE[entityType];
  const insertRow = {
    tenant_id: tenantId,
    ...coreUpdates,
    zoho_crm_id: zohoId,
    zoho_crm_module: zohoModule
  };
  try {
    const { data: created, error } = await supabase
      .from(table)
      .insert(insertRow)
      .select()
      .single();
    if (error) throw error;
    markInboundOrigin(tenantId, entityType, created.id);
    if (Object.keys(customUpdates).length > 0) {
      await applyCustomFieldUpdates(tenantId, entityType, created.id, customUpdates);
    }
    const payloadHash = computeHash({
      ...coreUpdates,
      ...Object.fromEntries(Object.entries(customUpdates).map(([k, v]) => [`custom:${k}`, v]))
    });
    await recordSyncState(tenantId, entityType, created.id, 'inbound', payloadHash);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: created.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'success', direction: 'inbound', source, action: 'create',
      payload_hash: payloadHash,
      request_payload: zohoRecord,
      response_payload: {
        core: coreUpdates,
        custom: customUpdates,
        created_id: created.id,
        ...(inboundWarnings.length > 0 ? { translation_warnings: inboundWarnings } : {})
      },
      error_message: inboundWarnings.length > 0
        ? `Translation warnings: ${inboundWarnings.join('; ')}`
        : undefined
    });
  } catch (err) {
    console.error('[ZohoCrmSync] Create-from-zoho failed:', err);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: null,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'failed', direction: 'inbound', source, action: 'create',
      error_message: [err?.message || String(err), ...inboundWarnings].filter(Boolean).join(' | '),
      request_payload: zohoRecord,
      response_payload: inboundWarnings.length > 0 ? { translation_warnings: inboundWarnings } : undefined
    });
  }
}

/**
 * Reconciliation poller: for every enabled inbound/bidirectional mapping,
 * pull records from Zoho whose Modified_Time is greater than the saved cursor
 * and run them through the inbound pipeline. Updates the cursor on success.
 */
export async function pollZohoCrmReconciliation(tenantId, options = {}) {
  const source = options.source || 'poller';
  const summary = { tenant_id: tenantId, mappings: [] };

  const { data: mappings, error } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_enabled', true);
  if (error) throw error;

  for (const mapping of mappings || []) {
    const dir = mapping.sync_direction || 'outbound';
    if (dir === 'outbound') continue;

    const sinceIso = mapping.last_inbound_cursor
      ? new Date(mapping.last_inbound_cursor).toISOString()
      : new Date(Date.now() - 60 * 60 * 1000).toISOString(); // first run: last hour

    const fields = (mapping.field_mappings || [])
      .map(m => m.zoho_field).filter(Boolean);
    fields.push('Modified_Time');
    if (mapping.unique_key_field) fields.push(mapping.unique_key_field);
    const fieldsParam = encodeURIComponent([...new Set(fields)].join(','));

    let page = 1;
    const perPage = 200;
    let processed = 0;
    let maxModified = mapping.last_inbound_cursor ? new Date(mapping.last_inbound_cursor).getTime() : 0;

    try {
      while (true) {
        const endpoint = `/${mapping.zoho_module}` +
          `?fields=${fieldsParam}` +
          `&sort_by=Modified_Time&sort_order=asc` +
          `&per_page=${perPage}&page=${page}`;
        const resp = await zohoCrmApiCall(tenantId, endpoint, {
          headers: { 'If-Modified-Since': sinceIso }
        });
        const records = resp?.data || [];
        if (records.length === 0) break;
        for (const rec of records) {
          // Defensive cursor check (Zoho's If-Modified-Since covers it but be strict)
          const modT = rec.Modified_Time ? new Date(rec.Modified_Time).getTime() : 0;
          if (mapping.last_inbound_cursor && modT <= new Date(mapping.last_inbound_cursor).getTime()) continue;
          await applyInboundFromZoho(tenantId, mapping.zoho_module, rec, { source });
          processed += 1;
          if (modT > maxModified) maxModified = modT;
        }
        const more = resp?.info?.more_records;
        if (!more) break;
        page += 1;
        if (page > 25) break; // safety stop — 5000 records / poll
      }

      if (maxModified > 0) {
        await supabase
          .from('zoho_crm_sync_mapping')
          .update({ last_inbound_cursor: new Date(maxModified).toISOString() })
          .eq('id', mapping.id);
      }
      summary.mappings.push({ entity_type: mapping.entity_type, processed });
    } catch (err) {
      console.error('[ZohoCrmSync] Poller error:', err);
      await writeLog({
        tenant_id: tenantId, entity_type: mapping.entity_type,
        zoho_module: mapping.zoho_module, status: 'failed',
        direction: 'inbound', source, action: 'reconcile',
        error_message: err?.message || String(err)
      });
      summary.mappings.push({ entity_type: mapping.entity_type, processed, error: err.message });
    }
  }

  return summary;
}

// ===========================================================================
// Relink: backfill iConnect → Zoho record-id links after a Zoho module
// switchover (e.g. Accounts module rebuilt) invalidates stored zoho_crm_id
// values. Link-only — does NOT update any field values.
// ===========================================================================

// Whitelist of organisation columns that may be used as the local
// unique-key for relink. Matches ENTITY_CORE_FIELDS.organization in
// api/admin/zoho-crm-sync/metadata.js and prevents PostgREST select-string
// injection via a tampered field_mappings JSON.
const ALLOWED_ORG_LOCAL_KEYS = new Set([
  'name', 'website', 'phone', 'email',
  'address_line_1', 'address_line_2', 'city', 'country',
  'description', 'status'
]);

// Returns one of:
//   { status: 'valid', record }
//   { status: 'mismatch', record, zohoValue }   — Zoho has the id but the
//                                                 unique-key value differs
//   { status: 'missing' }                       — record no longer exists
async function validateExistingZohoLink(tenantId, module, recordId, uniqueKey, expectedValue) {
  try {
    const resp = await zohoCrmApiCall(tenantId, `/${module}/${encodeURIComponent(recordId)}`);
    const record = Array.isArray(resp?.data) ? resp.data[0] : null;
    if (!record) return { status: 'missing' };
    const zohoValue = record[uniqueKey];
    const norm = v => v === undefined || v === null ? '' : String(v).trim().toLowerCase();
    if (norm(zohoValue) !== norm(expectedValue)) {
      return { status: 'mismatch', record, zohoValue };
    }
    return { status: 'valid', record };
  } catch (err) {
    if (/\b404\b|invalid.?id|INVALID_DATA/i.test(err?.message || '')) return { status: 'missing' };
    throw err;
  }
}

function escapeZohoCriteriaValue(v) {
  // Zoho criteria values must escape special chars (parens, commas, etc.)
  // Conservative: backslash-escape parens, commas and backslashes.
  return String(v).replace(/([\\(),])/g, '\\$1');
}

// Deterministic search helper for relink: returns one of
//   { status: 'one',   records: [r] }
//   { status: 'none',  records: [] }
//   { status: 'many',  records: [...] }
//   { status: 'error', error: <msg> }
async function searchZohoByUniqueKey(tenantId, module, fieldName, value) {
  if (value === undefined || value === null || value === '') {
    return { status: 'none', records: [] };
  }
  try {
    const criteria = `(${fieldName}:equals:${escapeZohoCriteriaValue(value)})`;
    const records = await searchZohoCrmRecords(tenantId, module, criteria, ['id', fieldName]);
    if (records.length === 0) return { status: 'none', records: [] };
    if (records.length === 1) return { status: 'one', records };
    return { status: 'many', records };
  } catch (err) {
    return { status: 'error', error: err?.message || String(err) };
  }
}

/**
 * For every organization in the tenant, look it up in the new Zoho Accounts
 * module by the configured unique_key_field and persist the resulting
 * zoho_crm_id. Existing links are validated; stale ones are re-resolved.
 *
 * Decision matrix per org:
 *   - existing zoho_crm_id valid → log 'skipped' (already_linked)
 *   - existing zoho_crm_id stale → search; relink or log 'no_match'/'ambiguous'
 *   - no zoho_crm_id            → search; relink or log 'no_match'/'ambiguous'
 *
 * Returns a summary { processed, relinked, already_linked, no_match,
 * ambiguous, failed }.
 */
export async function relinkOrganizationsToZoho(tenantId, options = {}) {
  const source = options.source || 'admin_relink';
  // Optional resume cursor: only process orgs with id > startAfterId. Lets
  // the caller break a large tenant across multiple invocations without
  // re-validating already-processed records on every run.
  // organization.id is a varchar UUID, so the cursor is a UUID-shaped
  // string. PostgREST's .gt('id', cursorId) on a varchar column is a
  // lexicographic comparison, which is monotonic for UUIDs we generate
  // per row (id asc ordering preserved by our query).
  const startAfterIdRaw = options.startAfterId;
  let cursorId = null;
  if (startAfterIdRaw !== undefined && startAfterIdRaw !== null) {
    if (typeof startAfterIdRaw !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(startAfterIdRaw)) {
      throw new Error(`startAfterId must be a UUID-shaped id string (got ${JSON.stringify(startAfterIdRaw)})`);
    }
    cursorId = startAfterIdRaw;
  }
  const SAMPLE_CAP = 25;
  const summary = {
    tenant_id: tenantId,
    processed: 0,
    relinked: 0,
    already_linked: 0,
    no_match: 0,
    ambiguous: 0,
    failed: 0,
    skipped_no_value: 0
  };
  // Per-org outcome samples surfaced to the admin UI so a failed run is
  // diagnosable without grepping the sync log. Two buckets ensure the
  // diagnostic outcomes (failed/no_match/ambiguous/skipped_no_value) are
  // not crowded out by early already_linked rows in large tenants.
  const PROBLEM_STATUSES = new Set(['failed', 'no_match', 'ambiguous', 'skipped_no_value']);
  const PROBLEM_CAP = 20;
  const SUCCESS_CAP = 5;
  const problemSamples = [];
  const successSamples = [];
  const pushSample = (sample) => {
    if (PROBLEM_STATUSES.has(sample.status)) {
      if (problemSamples.length < PROBLEM_CAP) problemSamples.push(sample);
    } else if (successSamples.length < SUCCESS_CAP) {
      successSamples.push(sample);
    }
  };

  const { data: mapping } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', 'organization')
    .maybeSingle();

  if (!mapping) {
    throw new Error('No organisation mapping configured for this tenant');
  }
  const zohoModule = mapping.zoho_module || 'Accounts';
  const uniqueKey = mapping.unique_key_field;
  if (!uniqueKey) throw new Error('Mapping has no unique_key_field configured');
  // Defence-in-depth: although unique_key_field is admin-controlled via the
  // mappings UI, refuse anything other than a plain Zoho API name so a
  // malicious value cannot break the criteria string syntax.
  if (!/^[A-Za-z0-9_]+$/.test(uniqueKey)) {
    throw new Error(`unique_key_field "${uniqueKey}" is not a valid Zoho API name`);
  }
  const localKey = resolveLocalKeyForZohoUnique(mapping);
  if (!localKey) {
    throw new Error(`unique_key_field "${uniqueKey}" is not paired with a core organisation column in field_mappings`);
  }
  // Whitelist the local column to prevent PostgREST select-string injection
  // via a tampered field_mappings JSON (the admin UI is the only writer, but
  // relying on it for injection safety is brittle).
  if (!ALLOWED_ORG_LOCAL_KEYS.has(localKey)) {
    throw new Error(`Local field "${localKey}" is not permitted as a relink unique key`);
  }

  // Paginate over the organization table — PostgREST caps a single .select()
  // at ~1000 rows, so an unpaged query would silently skip large tenants.
  // Use a monotonic id cursor (not OFFSET) so that successive invocations
  // from the admin UI can resume after the last org processed by the
  // previous run instead of re-validating the earlier ones.
  const PAGE = 500;
  // Vercel serverless functions get cut off at 60s; leave 10s headroom so we
  // can return a partial result instead of an HTML gateway error page.
  const startedAt = Date.now();
  const TIME_BUDGET_MS = 50_000;
  let truncated = false;
  let budgetExceeded = false;
  let lastProcessedId = null;
  // eslint-disable-next-line no-constant-condition
  outer: while (true) {
    let pageQuery = supabase
      .from('organization')
      .select(`id, name, zoho_crm_id, zoho_crm_module, ${localKey}`)
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (cursorId !== null) {
      pageQuery = pageQuery.gt('id', cursorId);
    }
    const { data: orgs, error: orgErr } = await pageQuery;
    if (orgErr) throw orgErr;
    if (!orgs || orgs.length === 0) break;

    for (const org of orgs) {
      if (budgetExceeded) break outer;
      summary.processed += 1;
      const rawValue = org[localKey];
      try {
      // Trim leading/trailing whitespace before searching — the most common
      // real-world cause of a no-match against records that visibly exist in
      // Zoho. Zoho's :equals: search on string fields is already case-
      // insensitive, so case is not normalised here. Empty string after trim
      // is treated as no value.
      const matchValue = (typeof rawValue === 'string') ? rawValue.trim() : rawValue;
      const wasTrimmed = (typeof rawValue === 'string') && rawValue !== matchValue;

      try {
        // 1. Validate existing link if present — must check that Zoho's
        //    unique_key_field value still matches the iConnect value, not just
        //    that the record exists. A "mismatch" means the Zoho record was
        //    re-purposed and we should re-search instead of trusting the id.
        if (org.zoho_crm_id) {
          const existingModule = org.zoho_crm_module || zohoModule;
          if (existingModule === zohoModule) {
            const check = await validateExistingZohoLink(
              tenantId, zohoModule, org.zoho_crm_id, uniqueKey, matchValue
            );
            if (check.status === 'valid') {
              summary.already_linked += 1;
              const msg = `Already linked to valid ${zohoModule}/${org.zoho_crm_id}`;
              await writeLog({
                tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
                zoho_module: zohoModule, zoho_record_id: org.zoho_crm_id,
                status: 'skipped', direction: 'inbound', source, action: 'relink',
                error_message: msg
              });
              pushSample({
                org_id: org.id, org_name: org.name, local_value: matchValue,
                status: 'already_linked', message: msg, zoho_record_id: org.zoho_crm_id
              });
              continue;
            }
            // 'missing' or 'mismatch' → fall through and re-search
          }
        }

        // 2. (Re)search Zoho by unique key
        if (matchValue === undefined || matchValue === null || matchValue === '') {
          summary.skipped_no_value += 1;
          const msg = `Local field "${localKey}" is empty — cannot search Zoho`;
          await writeLog({
            tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
            zoho_module: zohoModule, status: 'skipped', direction: 'inbound',
            source, action: 'relink',
            error_message: msg
          });
          pushSample({
            org_id: org.id, org_name: org.name, local_value: rawValue,
            status: 'skipped_no_value', message: msg
          });
          continue;
        }

        const result = await searchZohoByUniqueKey(tenantId, zohoModule, uniqueKey, matchValue);

        if (result.status === 'error') {
          throw new Error(result.error);
        }
        if (result.status === 'none') {
          summary.no_match += 1;
          const trimNote = wasTrimmed ? ' (trimmed)' : '';
          const msg = `No ${zohoModule} found in Zoho where ${uniqueKey}="${matchValue}"${trimNote}`;
          await writeLog({
            tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
            zoho_module: zohoModule, status: 'skipped', direction: 'inbound',
            source, action: 'relink',
            error_message: msg
          });
          pushSample({
            org_id: org.id, org_name: org.name, local_value: matchValue,
            status: 'no_match', message: msg
          });
          continue;
        }
        if (result.status === 'many') {
          summary.ambiguous += 1;
          const msg = `Ambiguous: ${result.records.length} ${zohoModule} records in Zoho match ${uniqueKey}="${matchValue}"`;
          await writeLog({
            tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
            zoho_module: zohoModule, status: 'skipped', direction: 'inbound',
            source, action: 'relink',
            error_message: msg,
            response_payload: { matches: result.records.map(r => r.id) }
          });
          pushSample({
            org_id: org.id, org_name: org.name, local_value: matchValue,
            status: 'ambiguous', message: msg
          });
          continue;
        }

        // status === 'one'
        const newZohoId = result.records[0].id;
        const wasStale = !!org.zoho_crm_id && org.zoho_crm_id !== newZohoId;
        await persistZohoIdOnEntity(tenantId, 'organization', org.id, newZohoId, zohoModule);
        summary.relinked += 1;
        const msg = wasStale
          ? `Re-linked: stale id ${org.zoho_crm_id} → ${newZohoId}`
          : `Linked via ${uniqueKey}="${matchValue}" → ${newZohoId}`;
        await writeLog({
          tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
          zoho_module: zohoModule, zoho_record_id: newZohoId,
          status: 'success', direction: 'inbound', source, action: 'relink',
          error_message: msg,
          response_payload: { previous_zoho_crm_id: org.zoho_crm_id || null, new_zoho_crm_id: newZohoId }
        });
        pushSample({
          org_id: org.id, org_name: org.name, local_value: matchValue,
          status: 'relinked', message: msg, zoho_record_id: newZohoId
        });
      } catch (err) {
        console.error('[ZohoCrmSync] Relink error for org', org.id, err);
        summary.failed += 1;
        const msg = err?.message || String(err);
        await writeLog({
          tenant_id: tenantId, entity_type: 'organization', entity_id: org.id,
          zoho_module: zohoModule, status: 'failed', direction: 'inbound',
          source, action: 'relink',
          error_message: msg
        });
        pushSample({
          org_id: org.id, org_name: org.name, local_value: matchValue,
          status: 'failed', message: msg
        });
      }
      } finally {
        // Record this org as the last one we touched before enforcing
        // the budget, so the caller can resume strictly after it on
        // the next invocation — regardless of which branch handled it.
        lastProcessedId = org.id;
        // Enforce the time budget after every org regardless of which
        // branch (already_linked / no_match / ambiguous / etc.) handled
        // it. The inner try/catch above uses `continue` for those paths,
        // which would skip a check placed at the bottom of the for-body
        // — but a `finally` always runs before `continue` jumps to the
        // next iteration. We set the flag here and bail out at the top
        // of the next iteration via the labelled break above.
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          truncated = true;
          budgetExceeded = true;
        }
      }
    }

    // Catch the edge case where the budget was exceeded on the last org
    // of the page — the inner-loop's top-of-iteration check would not
    // fire again, so the outer `while` would otherwise fetch another
    // page before noticing.
    if (budgetExceeded) break;
    if (orgs.length < PAGE) break;
    // Advance the cursor to the last id we saw in this page so the next
    // .gt('id', cursorId) query starts strictly after it.
    cursorId = orgs[orgs.length - 1].id;
  }

  const completed = !truncated;
  if (truncated) {
    summary.truncated = true;
    summary.budget_exceeded = budgetExceeded;
    summary.last_processed_id = lastProcessedId;
  } else {
    summary.completed = true;
  }

  return {
    summary,
    truncated,
    completed,
    budget_exceeded: budgetExceeded,
    last_processed_id: lastProcessedId,
    config: {
      zoho_module: zohoModule,
      unique_key_field: uniqueKey,
      local_key: localKey
    },
    samples: [...problemSamples, ...successSamples]
  };
}

// ===========================================================================
// One-time bulk import: Zoho CRM → iConnect.
// Honours the configured field_mappings and is idempotent (safe to re-run).
//
// Merge rules differ by entity type for the UPDATE path:
//   - member:       "non-empty Zoho wins, empty Zoho preserves iConnect" —
//                   a non-empty Zoho value overrides a differing iConnect
//                   value; empty Zoho values never blank out iConnect.
//   - organization: "iConnect wins, Zoho fills blanks only" — a non-empty
//                   Zoho value is only written when the current iConnect
//                   value is empty/missing. iConnect is treated as the
//                   source of truth for organisations.
//
// CREATE behaviour is the same for both: a brand-new iConnect record is
// populated from every non-empty mapped Zoho value.
// ===========================================================================

const NATURAL_KEY_FIELD = {
  member: 'email',
  organization: 'name'
};

function isEmptyZohoValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

// Used by the organisations one-time import to decide whether an iConnect
// field is "empty" and therefore eligible to be filled from a Zoho value.
// Mirrors isEmptyZohoValue so the two sides are judged consistently.
function isEmptyIconnectValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

// Build a flat list of {scope, field, zohoValue, beforeValue, afterValue}
// describing the fields that would actually be written. Used by the dry-run
// preview path so the admin can review the per-field diff before going live.
function buildDiffs({ coreUpdates, customUpdates, coreToWrite, customToWrite, linkPatch, entity, currentCustom, isCreate }) {
  const diffs = [];
  for (const [field, afterValue] of Object.entries(coreToWrite)) {
    diffs.push({
      scope: 'core',
      field,
      zohoValue: coreUpdates[field],
      beforeValue: isCreate ? null : (entity ? entity[field] ?? null : null),
      afterValue
    });
  }
  for (const [field, afterValue] of Object.entries(customToWrite)) {
    diffs.push({
      scope: 'custom',
      field,
      zohoValue: customUpdates[field],
      beforeValue: isCreate ? null : ((currentCustom && currentCustom[field]) ?? null),
      afterValue
    });
  }
  if (linkPatch) {
    diffs.push({
      scope: 'link',
      field: 'zoho_crm_id',
      zohoValue: linkPatch.zoho_crm_id,
      beforeValue: isCreate ? null : (entity ? entity.zoho_crm_id ?? null : null),
      afterValue: linkPatch.zoho_crm_id
    });
    diffs.push({
      scope: 'link',
      field: 'zoho_crm_module',
      zohoValue: linkPatch.zoho_crm_module,
      beforeValue: isCreate ? null : (entity ? entity.zoho_crm_module ?? null : null),
      afterValue: linkPatch.zoho_crm_module
    });
  }
  return diffs;
}

function summariseEntity(entity, entityType) {
  if (!entity) return null;
  const naturalKey = NATURAL_KEY_FIELD[entityType];
  return {
    id: entity.id,
    naturalKey: naturalKey ? { field: naturalKey, value: entity[naturalKey] ?? null } : null,
    zoho_crm_id: entity.zoho_crm_id ?? null,
    zoho_crm_module: entity.zoho_crm_module ?? null
  };
}

async function importOneRecord(tenantId, entityType, mapping, zohoModule, zohoRecord, source, options = {}) {
  const dryRun = options.dryRun === true;
  const action = options.action || 'one_time_import';
  // Merge rich-text values that Zoho hides from the regular GET payload.
  // No-op for mappings without rich-text fields.
  zohoRecord = await enrichRecordWithRichText(tenantId, mapping, zohoModule, zohoRecord);
  const zohoId = zohoRecord?.id || zohoRecord?.Id || null;

  // 1. Resolve existing iConnect record: zoho id first, then natural key.
  let entity = null;
  let matchedBy = null;
  if (zohoId) {
    entity = await findEntityByZohoId(tenantId, entityType, zohoModule, zohoId);
    if (entity) matchedBy = 'zoho_id';
  }
  if (!entity) {
    const naturalKey = NATURAL_KEY_FIELD[entityType];
    const m = (mapping.field_mappings || []).find(r => r.iconnect_field === naturalKey);
    // Fall back to Zoho's standard field for the natural key if the admin's
    // mapping doesn't include it explicitly (Email for Contacts/Leads,
    // Account_Name for Accounts). Without this we'd silently create
    // duplicates when the natural-key field isn't mapped.
    const DEFAULT_ZOHO_NATURAL_KEY_FIELD = {
      Contacts: 'Email',
      Leads: 'Email',
      Accounts: 'Account_Name'
    };
    const zohoFieldForKey = m?.zoho_field || DEFAULT_ZOHO_NATURAL_KEY_FIELD[zohoModule];
    let matchValue = zohoFieldForKey ? zohoRecord[zohoFieldForKey] : null;
    if (matchValue !== undefined && matchValue !== null && matchValue !== '') {
      if (naturalKey === 'email') matchValue = String(matchValue).toLowerCase();
      const result = await findEntityByUniqueField(tenantId, entityType, naturalKey, matchValue);
      if (result.entity) {
        entity = result.entity;
        matchedBy = 'natural_key';
        if (zohoId && !dryRun) await persistZohoIdOnEntity(tenantId, entityType, entity.id, zohoId, zohoModule);
      } else if (result.reason === 'ambiguous') {
        const errorMessage = `Ambiguous: ${result.count}+ iConnect ${entityType}s match ${naturalKey}="${matchValue}" — resolve manually`;
        let logId = null;
        if (!dryRun) {
          const logRow = await writeLog({
            tenant_id: tenantId, entity_type: entityType, entity_id: null,
            zoho_module: zohoModule, zoho_record_id: zohoId,
            status: 'skipped', direction: 'inbound', source, action,
            error_message: errorMessage,
            request_payload: zohoRecord
          });
          logId = logRow?.id || null;
        }
        return { outcome: 'ambiguous', matched: null, matchedBy: null, message: errorMessage, diffs: [], logId };
      } else if (result.reason === 'error') {
        throw new Error(`Natural-key lookup failed: ${result.error}`);
      }
    }
  }

  const { coreUpdates, customUpdates } = buildReversePayload(mapping, zohoRecord);
  if (entityType === 'member' && typeof coreUpdates.email === 'string') {
    coreUpdates.email = coreUpdates.email.toLowerCase();
  }

  if (!entity) {
    // CREATE: only include fields with a non-empty Zoho value.
    const insertRow = { tenant_id: tenantId };
    if (zohoId) {
      insertRow.zoho_crm_id = zohoId;
      insertRow.zoho_crm_module = zohoModule;
    }
    const coreToWrite = {};
    const customToWrite = {};
    let mappedCount = 0;
    for (const [k, v] of Object.entries(coreUpdates)) {
      if (isEmptyZohoValue(v)) continue;
      insertRow[k] = v;
      coreToWrite[k] = v;
      mappedCount += 1;
    }
    for (const [k, v] of Object.entries(customUpdates)) {
      if (isEmptyZohoValue(v)) continue;
      customToWrite[k] = v;
      mappedCount += 1;
    }
    if (mappedCount === 0) {
      const errorMessage = 'Skipped create: Zoho record has no non-empty mapped values';
      let logId = null;
      if (!dryRun) {
        const logRow = await writeLog({
          tenant_id: tenantId, entity_type: entityType, entity_id: null,
          zoho_module: zohoModule, zoho_record_id: zohoId,
          status: 'skipped', direction: 'inbound', source, action,
          error_message: errorMessage,
          request_payload: zohoRecord
        });
        logId = logRow?.id || null;
      }
      return { outcome: 'no_mapped_values', matched: null, matchedBy: null, message: errorMessage, diffs: [], logId };
    }
    const linkPatch = zohoId ? { zoho_crm_id: zohoId, zoho_crm_module: zohoModule } : null;
    const diffs = buildDiffs({
      coreUpdates, customUpdates, coreToWrite, customToWrite, linkPatch,
      entity: null, currentCustom: null, isCreate: true
    });
    if (dryRun) {
      return {
        outcome: 'created',
        matched: null,
        matchedBy: null,
        coreToWrite,
        customToWrite,
        linkPatch,
        diffs
      };
    }
    const table = ENTITY_TABLE[entityType];
    const { data: created, error } = await supabase
      .from(table)
      .insert(insertRow)
      .select()
      .single();
    if (error) throw error;
    markInboundOrigin(tenantId, entityType, created.id);
    if (Object.keys(customToWrite).length > 0) {
      try {
        await applyCustomFieldUpdates(tenantId, entityType, created.id, customToWrite);
      } catch (writeErr) {
        const errorMessage = `Custom field write failed after entity create: ${writeErr?.message || String(writeErr)}`;
        const logRow = await writeLog({
          tenant_id: tenantId, entity_type: entityType, entity_id: created.id,
          zoho_module: zohoModule, zoho_record_id: zohoId,
          status: 'failed', direction: 'inbound', source, action,
          error_message: errorMessage,
          request_payload: zohoRecord,
          response_payload: { created: true, core: insertRow, custom: customToWrite }
        });
        return {
          outcome: 'failed',
          matched: summariseEntity(created, entityType),
          matchedBy: 'created',
          coreToWrite,
          customToWrite,
          linkPatch,
          diffs,
          message: errorMessage,
          logId: logRow?.id || null
        };
      }
    }
    const payloadHash = computeHash({
      ...coreUpdates,
      ...Object.fromEntries(Object.entries(customUpdates).map(([k, v]) => [`custom:${k}`, v]))
    });
    await recordSyncState(tenantId, entityType, created.id, 'inbound', payloadHash);
    const logRow = await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: created.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'success', direction: 'inbound', source, action,
      payload_hash: payloadHash,
      request_payload: zohoRecord,
      response_payload: { created: true, core: insertRow, custom: customToWrite }
    });
    return {
      outcome: 'created',
      matched: summariseEntity(created, entityType),
      matchedBy: 'created',
      coreToWrite,
      customToWrite,
      linkPatch,
      diffs,
      logId: logRow?.id || null
    };
  }

  // UPDATE: merge rules differ by entity type.
  //   - organization: iConnect is the source of truth. Only fill iConnect
  //     fields that are currently empty from a non-empty Zoho value.
  //     Existing iConnect values are never overwritten, even when Zoho
  //     disagrees.
  //   - member (and any other type): preserve today's behaviour — a
  //     non-empty Zoho value overrides a differing iConnect value; empty
  //     Zoho values preserve whatever iConnect currently has.
  const currentCustom = await loadCustomFieldValues(tenantId, entityType, entity.id);
  const iconnectWins = entityType === 'organization';
  const coreToWrite = {};
  for (const [k, v] of Object.entries(coreUpdates)) {
    if (isEmptyZohoValue(v)) continue;
    if (iconnectWins) {
      if (!isEmptyIconnectValue(entity[k])) continue;
    } else {
      if (entity[k] === v) continue;
    }
    coreToWrite[k] = v;
  }
  const customToWrite = {};
  for (const [k, v] of Object.entries(customUpdates)) {
    if (isEmptyZohoValue(v)) continue;
    if (iconnectWins) {
      if (!isEmptyIconnectValue(currentCustom[k])) continue;
    } else {
      if (currentCustom[k] === v) continue;
    }
    customToWrite[k] = v;
  }

  // Always backfill the zoho link if we found this row by natural key earlier
  // (persistZohoIdOnEntity already handled that), but if the entity has no
  // zoho_crm_id at all and we have one, set it on this update too.
  let linkPatch = null;
  if (zohoId && (!entity.zoho_crm_id || entity.zoho_crm_module !== zohoModule)) {
    linkPatch = { zoho_crm_id: zohoId, zoho_crm_module: zohoModule };
  }

  const matched = summariseEntity(entity, entityType);

  if (Object.keys(coreToWrite).length === 0 && Object.keys(customToWrite).length === 0 && !linkPatch) {
    const errorMessage = iconnectWins
      ? 'No-op: every iConnect field already populated; no Zoho values to fill in'
      : 'No-op: every non-empty Zoho value already matches iConnect';
    let logId = null;
    if (!dryRun) {
      const logRow = await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'skipped', direction: 'inbound', source, action,
        error_message: errorMessage,
        request_payload: zohoRecord
      });
      logId = logRow?.id || null;
    }
    return { outcome: 'no_change', matched, matchedBy, message: errorMessage, diffs: [], logId };
  }

  const diffs = buildDiffs({
    coreUpdates, customUpdates, coreToWrite, customToWrite, linkPatch,
    entity, currentCustom, isCreate: false
  });

  if (dryRun) {
    return {
      outcome: 'updated',
      matched,
      matchedBy,
      coreToWrite,
      customToWrite,
      linkPatch,
      diffs
    };
  }

  markInboundOrigin(tenantId, entityType, entity.id);
  const table = ENTITY_TABLE[entityType];
  const updatePayload = { ...coreToWrite, ...(linkPatch || {}) };
  if (Object.keys(updatePayload).length > 0) {
    const { error } = await supabase
      .from(table)
      .update({ ...updatePayload, updated_at: new Date().toISOString() })
      .eq('id', entity.id)
      .eq('tenant_id', tenantId);
    if (error) throw error;
  }
  if (Object.keys(customToWrite).length > 0) {
    try {
      await applyCustomFieldUpdates(tenantId, entityType, entity.id, customToWrite);
    } catch (writeErr) {
      const errorMessage = `Custom field write failed after entity update: ${writeErr?.message || String(writeErr)}`;
      const logRow = await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'failed', direction: 'inbound', source, action,
        error_message: errorMessage,
        request_payload: zohoRecord,
        response_payload: { core: coreToWrite, custom: customToWrite, link: linkPatch }
      });
      return {
        outcome: 'failed',
        matched,
        matchedBy,
        coreToWrite,
        customToWrite,
        linkPatch,
        diffs,
        message: errorMessage,
        logId: logRow?.id || null
      };
    }
  }
  const payloadHash = computeHash({
    ...coreToWrite,
    ...Object.fromEntries(Object.entries(customToWrite).map(([k, v]) => [`custom:${k}`, v])),
    ...(linkPatch || {})
  });
  await recordSyncState(tenantId, entityType, entity.id, 'inbound', payloadHash);
  const logRow = await writeLog({
    tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
    zoho_module: zohoModule, zoho_record_id: zohoId,
    status: 'success', direction: 'inbound', source, action,
    payload_hash: payloadHash,
    request_payload: zohoRecord,
    response_payload: { core: coreToWrite, custom: customToWrite, link: linkPatch }
  });
  return {
    outcome: 'updated',
    matched,
    matchedBy,
    coreToWrite,
    customToWrite,
    linkPatch,
    diffs,
    logId: logRow?.id || null
  };
}

/**
 * One-time bulk import from Zoho CRM into iConnect for a single entity type
 * ('member' or 'organization'). Paginates through every record in the
 * configured Zoho module for this tenant. Idempotent and safe to re-run.
 *
 * Honours the existing field_mappings (including custom: preference fields).
 * Update-merge rules differ by entity type:
 *   - organization: iConnect is the source of truth. Only iConnect fields
 *     that are currently empty are filled from a non-empty Zoho value;
 *     existing iConnect values are never overwritten.
 *   - member: a non-empty Zoho value overrides a differing iConnect value;
 *     empty Zoho values preserve whatever iConnect currently has.
 *
 * New iConnect records are inserted from every non-empty mapped Zoho value
 * when no match is found by zoho_crm_id or natural key (email for members,
 * name for organisations). The zoho_crm_id / zoho_crm_module link is
 * always backfilled on previously unlinked iConnect records, even when no
 * other field needs to be written.
 *
 * Inbound origin is marked on every write so triggered outbound syncs are
 * suppressed during the import. Each record produces one zoho_crm_sync_log
 * row tagged with action='one_time_import'.
 */
export async function importEntityFromZoho(tenantId, entityType, options = {}) {
  if (!ENTITY_TABLE[entityType]) {
    throw new Error(`Unsupported entity type: ${entityType}`);
  }
  const source = options.source || 'one_time_import';
  const summary = {
    tenant_id: tenantId,
    entity_type: entityType,
    zoho_module: null,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    pages: 0,
    errors: []
  };

  const { data: mapping, error: mapErr } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .maybeSingle();
  if (mapErr) throw mapErr;
  if (!mapping) {
    throw new Error(`No Zoho CRM sync mapping is configured for ${entityType} on this tenant`);
  }
  if (!mapping.zoho_module) {
    throw new Error('Mapping has no Zoho module configured');
  }
  if (!Array.isArray(mapping.field_mappings) || mapping.field_mappings.length === 0) {
    throw new Error('Mapping has no field mappings configured — nothing to import');
  }

  const zohoModule = mapping.zoho_module;
  summary.zoho_module = zohoModule;

  const fields = new Set(['id', 'Modified_Time']);
  for (const m of mapping.field_mappings) {
    if (m?.zoho_field) fields.add(m.zoho_field);
  }
  if (mapping.unique_key_field) fields.add(mapping.unique_key_field);
  const fieldsParam = encodeURIComponent([...fields].join(','));

  const perPage = 200;
  const MAX_PAGES = Number(options.maxPages) || 500; // safety: 100k records / run
  let page = 1;

  while (page <= MAX_PAGES) {
    const endpoint = `/${zohoModule}?fields=${fieldsParam}&per_page=${perPage}&page=${page}`;
    let resp;
    try {
      resp = await zohoCrmApiCall(tenantId, endpoint);
    } catch (err) {
      // 204 no content => no records
      if (/\b204\b/.test(err.message || '')) break;
      throw new Error(`Failed to fetch ${zohoModule} page ${page}: ${err.message}`);
    }
    const records = Array.isArray(resp?.data) ? resp.data : [];
    if (records.length === 0) break;
    summary.pages += 1;

    for (const rec of records) {
      summary.processed += 1;
      try {
        const result = await importOneRecord(tenantId, entityType, mapping, zohoModule, rec, source);
        if (result.outcome === 'created') summary.created += 1;
        else if (result.outcome === 'updated') summary.updated += 1;
        else if (result.outcome === 'failed') {
          summary.failed += 1;
          if (summary.errors.length < 50) {
            summary.errors.push({ id: rec.id || rec.Id || null, error: result.message || 'failed' });
          }
        } else summary.skipped += 1;
      } catch (err) {
        summary.failed += 1;
        if (summary.errors.length < 50) {
          summary.errors.push({ id: rec.id || rec.Id || null, error: err?.message || String(err) });
        }
        try {
          await writeLog({
            tenant_id: tenantId, entity_type: entityType, entity_id: null,
            zoho_module: zohoModule, zoho_record_id: rec.id || rec.Id || null,
            status: 'failed', direction: 'inbound', source, action: 'one_time_import',
            error_message: err?.message || String(err),
            request_payload: rec
          });
        } catch (logErr) {
          console.error('[ZohoCrmSync] one_time_import log write failed:', logErr);
        }
      }
    }

    if (!resp?.info?.more_records) break;
    page += 1;
  }

  return summary;
}

/**
 * Run a single Zoho record through the same one-time import pipeline used by
 * `importEntityFromZoho`. Used by the admin "Sync a single record" UI so a
 * specific record can be previewed (dry-run) or synced live before kicking
 * off a full bulk import.
 *
 * Returns the structured result from `importOneRecord` plus the resolved
 * `zoho_module`. Throws on configuration errors (no mapping configured,
 * mapping missing fields), or on a "record not found" / Zoho API failure.
 */
export async function importSingleZohoRecord(tenantId, entityType, zohoRecordId, options = {}) {
  if (!ENTITY_TABLE[entityType]) {
    throw new Error(`Unsupported entity type: ${entityType}`);
  }
  if (!zohoRecordId || typeof zohoRecordId !== 'string') {
    throw new Error('zohoRecordId is required');
  }
  const dryRun = options.dryRun === true;
  const source = dryRun ? 'one_time_import_single_preview' : 'one_time_import_single';
  const action = 'one_time_import_single';

  const { data: mapping, error: mapErr } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .maybeSingle();
  if (mapErr) throw mapErr;
  if (!mapping) {
    throw new Error(`No Zoho CRM sync mapping is configured for ${entityType} on this tenant`);
  }
  if (!mapping.zoho_module) {
    throw new Error('Mapping has no Zoho module configured');
  }
  if (!Array.isArray(mapping.field_mappings) || mapping.field_mappings.length === 0) {
    throw new Error('Mapping has no field mappings configured — nothing to import');
  }

  const zohoModule = mapping.zoho_module;
  const fields = new Set(['id', 'Modified_Time']);
  for (const m of mapping.field_mappings) {
    if (m?.zoho_field) fields.add(m.zoho_field);
  }
  if (mapping.unique_key_field) fields.add(mapping.unique_key_field);
  const fieldsParam = encodeURIComponent([...fields].join(','));

  const endpoint = `/${zohoModule}/${encodeURIComponent(zohoRecordId)}?fields=${fieldsParam}`;
  let resp;
  try {
    resp = await zohoCrmApiCall(tenantId, endpoint);
  } catch (err) {
    const msg = err?.message || String(err);
    if (/\b204\b/.test(msg) || /\b404\b/.test(msg)) {
      throw new Error(`Record ${zohoRecordId} not found in Zoho CRM module ${zohoModule}`);
    }
    throw new Error(`Failed to fetch Zoho record ${zohoRecordId}: ${msg}`);
  }
  const records = Array.isArray(resp?.data) ? resp.data : [];
  if (records.length === 0) {
    throw new Error(`Record ${zohoRecordId} not found in Zoho CRM module ${zohoModule}`);
  }
  const zohoRecord = records[0];

  const result = await importOneRecord(
    tenantId, entityType, mapping, zohoModule, zohoRecord, source,
    { dryRun, action }
  );
  return { ...result, zoho_module: zohoModule, dryRun };
}
