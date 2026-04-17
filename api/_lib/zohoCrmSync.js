import { supabase } from './database.js';
import {
  upsertZohoCrmRecord,
  updateZohoCrmRecordById,
  isZohoCrmConnected
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
  // Some preference value tables carry tenant_id, some don't. Try the strict
  // filter first; if the column is missing fall back to the unfiltered query
  // (the entity itself is already tenant-scoped, so cross-tenant pref rows
  // are not reachable anyway).
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
  // Core field on entity row
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

async function writeLog(row) {
  try {
    const { data, error } = await supabase
      .from('zoho_crm_sync_log')
      .insert(row)
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

/**
 * Run a sync attempt to push the given entity to Zoho CRM. Always resolves; never throws.
 * Returns the inserted log row (or null).
 */
export async function syncEntityToZohoCrm(tenantId, entityType, entityId, options = {}) {
  if (!tenantId || !entityType || !entityId) {
    console.warn('[ZohoCrmSync] Missing params, skipping');
    return null;
  }
  const action = options.action || 'sync';

  try {
    // Load mapping
    const { data: mapping, error: mappingErr } = await supabase
      .from('zoho_crm_sync_mapping')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('entity_type', entityType)
      .maybeSingle();
    if (mappingErr) throw mappingErr;
    if (!mapping || !mapping.is_enabled) {
      return null; // Nothing configured / disabled => silently skip
    }

    // Verify Zoho CRM is connected
    const connected = await isZohoCrmConnected(tenantId);
    if (!connected) {
      return await writeLog({
        tenant_id: tenantId,
        entity_type: entityType,
        entity_id: entityId,
        zoho_module: mapping.zoho_module,
        status: 'failed',
        action,
        error_message: 'Zoho CRM is not connected for this tenant'
      });
    }

    const entity = await loadEntity(tenantId, entityType, entityId);
    if (!entity) {
      return await writeLog({
        tenant_id: tenantId,
        entity_type: entityType,
        entity_id: entityId,
        zoho_module: mapping.zoho_module,
        status: 'failed',
        action,
        error_message: 'Entity not found'
      });
    }

    const customValues = await loadCustomFieldValues(tenantId, entityType, entityId);
    const payload = buildPayload(mapping.field_mappings, entity, customValues);

    if (Object.keys(payload).length === 0) {
      return await writeLog({
        tenant_id: tenantId,
        entity_type: entityType,
        entity_id: entityId,
        zoho_module: mapping.zoho_module,
        status: 'skipped',
        action,
        error_message: 'No mapped fields had a value to sync'
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
      return await writeLog({
        tenant_id: tenantId,
        entity_type: entityType,
        entity_id: entityId,
        zoho_module: mapping.zoho_module,
        zoho_record_id: result.id,
        status: 'success',
        action: result.action || action,
        request_payload: payload,
        response_payload: result.details || null
      });
    }

    return await writeLog({
      tenant_id: tenantId,
      entity_type: entityType,
      entity_id: entityId,
      zoho_module: mapping.zoho_module,
      status: 'failed',
      action,
      error_message: result.error || 'Unknown failure',
      request_payload: payload,
      response_payload: result.details || result.raw || null
    });
  } catch (err) {
    console.error('[ZohoCrmSync] Sync failed:', err);
    return await writeLog({
      tenant_id: tenantId,
      entity_type: entityType,
      entity_id: entityId,
      status: 'failed',
      action,
      error_message: err?.message || String(err)
    });
  }
}

/**
 * Fire-and-forget wrapper used from request handlers. Never blocks or throws.
 */
export function triggerZohoCrmSync(tenantId, entityType, entityId, options = {}) {
  if (!tenantId || !entityType || !entityId) return;
  if (entityType !== 'member' && entityType !== 'organization') return;
  Promise.resolve()
    .then(() => syncEntityToZohoCrm(tenantId, entityType, entityId, options))
    .catch(err => console.error('[ZohoCrmSync] Background sync error:', err));
}

/**
 * Retry a previously logged sync attempt by id, scoped to the caller's tenant
 * to prevent cross-tenant access.
 */
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
  return await syncEntityToZohoCrm(log.tenant_id, log.entity_type, log.entity_id, { action: 'retry' });
}
