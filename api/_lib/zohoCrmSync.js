import crypto from 'crypto';
import { supabase } from './database.js';
import {
  upsertZohoCrmRecord,
  updateZohoCrmRecordById,
  isZohoCrmConnected,
  zohoCrmApiCall
} from './zohoCrmClient.js';

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
  let query = supabase
    .from(table)
    .select('field_id, value, tenant_id, preference_field:field_id(id, label, name)')
    .eq(fk, entityId);
  let { data, error } = await query.eq('tenant_id', tenantId);
  if (error && /column .*tenant_id/i.test(error.message || '')) {
    const fallback = await supabase
      .from(table)
      .select('field_id, value, preference_field:field_id(id, label, name)')
      .eq(fk, entityId);
    data = fallback.data;
    error = fallback.error;
  }
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

function buildPayload(mappings, entity, customValues) {
  const payload = {};
  for (const m of mappings || []) {
    if (!m?.zoho_field) continue;
    const v = resolveMappedValue(m, entity, customValues);
    if (v === undefined || v === null || v === '') continue;
    payload[m.zoho_field] = v;
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
    const payload = buildPayload(mapping.field_mappings, entity, customValues);
    const canonicalPayload = buildCanonicalPayload(mapping.field_mappings, entity, customValues);

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

    let result;
    if (entity.zoho_crm_id && entity.zoho_crm_module === mapping.zoho_module) {
      result = await updateZohoCrmRecordById(tenantId, mapping.zoho_module, entity.zoho_crm_id, payload);
    } else {
      result = await upsertZohoCrmRecord(tenantId, mapping.zoho_module, payload, mapping.unique_key_field);
    }

    if (result.success) {
      await persistZohoIdOnEntity(tenantId, entityType, entityId, result.id, mapping.zoho_module);
      await recordSyncState(tenantId, entityType, entityId, 'outbound', payloadHash);
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
        zoho_module: mapping.zoho_module, zoho_record_id: result.id,
        status: 'success', action: result.action || action, source,
        payload_hash: payloadHash,
        request_payload: payload, response_payload: result.details || null
      });
    }

    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
      zoho_module: mapping.zoho_module, status: 'failed', action, source,
      payload_hash: payloadHash,
      error_message: result.error || 'Unknown failure',
      request_payload: payload, response_payload: result.details || result.raw || null
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
function buildReversePayload(mapping, zohoRecord) {
  const coreUpdates = {};
  const customUpdates = {};
  for (const m of mapping.field_mappings || []) {
    const zohoField = m?.zoho_field;
    const iconnectField = m?.iconnect_field;
    if (!zohoField || !iconnectField) continue;
    if (!Object.prototype.hasOwnProperty.call(zohoRecord, zohoField)) continue;
    const value = zohoRecord[zohoField];
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
  const { data } = await supabase
    .from(table)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('zoho_crm_id', zohoId)
    .eq('zoho_crm_module', zohoModule)
    .maybeSingle();
  return data || null;
}

async function findEntityByUniqueField(tenantId, entityType, fieldName, value) {
  if (!fieldName || value === undefined || value === null || value === '') return null;
  const table = ENTITY_TABLE[entityType];
  if (!table) return null;
  // Match on the iConnect column with the same name as the unique mapped field
  // resolved via the mapping (e.g. email → email).
  try {
    const { data } = await supabase
      .from(table)
      .select('*')
      .eq('tenant_id', tenantId)
      .eq(fieldName, value)
      .maybeSingle();
    return data || null;
  } catch {
    return null;
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

async function applyCustomFieldUpdates(tenantId, entityType, entityId, customUpdates) {
  const fk = PREF_VALUE_FK[entityType];
  const table = PREF_VALUE_TABLE[entityType];
  if (!fk || !table) return;
  for (const [fieldId, value] of Object.entries(customUpdates)) {
    const stored = value === undefined || value === null ? '' : String(value);
    try {
      await supabase
        .from(table)
        .upsert({
          tenant_id: tenantId,
          [fk]: entityId,
          field_id: fieldId,
          value: stored
        }, { onConflict: `${fk},field_id` });
    } catch (err) {
      console.error('[ZohoCrmSync] Failed to upsert custom value:', fieldId, err);
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

  const zohoId = zohoRecord?.id || zohoRecord?.Id || null;
  let entity = null;
  if (zohoId) {
    entity = await findEntityByZohoId(tenantId, entityType, zohoModule, zohoId);
  }
  if (!entity) {
    const localKey = resolveLocalKeyForZohoUnique(mapping);
    if (localKey) {
      const matchValue = zohoRecord[mapping.unique_key_field];
      entity = await findEntityByUniqueField(tenantId, entityType, localKey, matchValue);
      if (entity && zohoId) {
        await persistZohoIdOnEntity(tenantId, entityType, entity.id, zohoId, zohoModule);
      }
    }
  }

  if (!entity) {
    const policy = mapping.unmatched_policy || 'ignore';
    if (policy === 'queue') {
      return await writeLog({
        tenant_id: tenantId, entity_type: entityType, entity_id: null,
        zoho_module: zohoModule, zoho_record_id: zohoId,
        status: 'pending', direction: 'inbound', source, action: 'inbound',
        error_message: 'Queued: no matching iConnect record (policy=queue) — admin review required',
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
      error_message: 'No matching iConnect record (policy=ignore)',
      request_payload: zohoRecord
    });
  }

  const { coreUpdates, customUpdates } = buildReversePayload(mapping, zohoRecord);
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
      request_payload: zohoRecord,
      response_payload: { core: coreChanged, custom: customChanged }
    });
  } catch (err) {
    console.error('[ZohoCrmSync] Inbound write failed:', err);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: entity.id,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'failed', direction: 'inbound', source, action: 'inbound',
      payload_hash: payloadHash,
      conflict_resolution: conflictResolution,
      error_message: err?.message || String(err),
      request_payload: zohoRecord,
      response_payload: { core: coreChanged, custom: customChanged }
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
  const { coreUpdates, customUpdates } = buildReversePayload(mapping, zohoRecord);

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
      response_payload: { core: coreUpdates, custom: customUpdates, created_id: created.id }
    });
  } catch (err) {
    console.error('[ZohoCrmSync] Create-from-zoho failed:', err);
    return await writeLog({
      tenant_id: tenantId, entity_type: entityType, entity_id: null,
      zoho_module: zohoModule, zoho_record_id: zohoId,
      status: 'failed', direction: 'inbound', source, action: 'create',
      error_message: err?.message || String(err),
      request_payload: zohoRecord
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
