import { supabase } from '../_lib/database.js';
import { validateCrmWebhookSecret, zohoCrmApiCall } from '../_lib/zohoCrmClient.js';
import { applyInboundFromZoho, writeSyncLog } from '../_lib/zohoCrmSync.js';

/**
 * Inbound webhook for Zoho CRM workflow rules and Zoho Flow.
 *
 * URL shape: POST /api/zoho-crm/webhook?tenantId=<uuid>
 * Auth: header `X-Zoho-Webhook-Secret: <per-tenant secret>` (also accepted via
 *       ?secret= query for Zoho workflow setups that cannot send custom headers).
 *
 * Two modes are supported:
 *
 * 1. Inline record(s): the body contains a full record (as a single object,
 *    `{ data: [...] }`, or `{ record: {...} }`). The `module` query/body param
 *    is required so we know which Zoho module to map against. This is the
 *    behaviour used by Zoho CRM Workflow Rules.
 *
 * 2. Fetch-by-id: the body has no record fields and the request specifies
 *    `contactId` or `orgId` (query or body). The module is inferred
 *    (`contactId` → Contacts, `orgId` → Accounts) and the full record is
 *    fetched from Zoho via the CRM API before being run through the existing
 *    inbound pipeline. This is the behaviour used by Zoho Flow when configured
 *    to forward only an id.
 */

const ID_PARAM_TO_MODULE = {
  contactId: 'Contacts',
  orgId: 'Accounts'
};

function pickIdParam(req, body) {
  // Returns the first present, non-empty id param, normalising to canonical
  // Zoho module. Empty/whitespace ids are rejected by the caller before this.
  for (const key of Object.keys(ID_PARAM_TO_MODULE)) {
    const raw = req.query[key] ?? body[key];
    if (raw === undefined || raw === null) continue;
    const v = String(raw).trim();
    if (v) return { key, value: v, module: ID_PARAM_TO_MODULE[key] };
  }
  return null;
}

function hasInlineRecord(body) {
  if (!body || typeof body !== 'object') return false;
  if (Array.isArray(body)) return body.length > 0;
  if (Array.isArray(body.data) && body.data.length > 0) return true;
  if (body.record && typeof body.record === 'object') return true;
  if (body.id || body.Id) return true;
  // A body containing only routing fields like { module: 'Contacts' } or
  // { contactId: '...' } is NOT an inline record.
  const recordIsh = Object.keys(body).filter(
    k => !['module', 'Module', 'contactId', 'orgId', 'tenantId', 'tenant_id', 'secret'].includes(k)
  );
  return recordIsh.length > 0 && recordIsh.some(k => k !== 'data' && k !== 'record');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const tenantId = req.query.tenantId || req.query.tenant_id;
    if (!tenantId) return res.status(400).json({ error: 'Missing tenantId' });

    const providedSecret =
      req.headers['x-zoho-webhook-secret'] ||
      req.headers['x-webhook-secret'] ||
      req.query.secret ||
      null;
    const ok = await validateCrmWebhookSecret(tenantId, providedSecret);
    if (!ok) return res.status(401).json({ error: 'Invalid or missing webhook secret' });

    const { data: tenant } = await supabase
      .from('tenant')
      .select('id')
      .eq('id', tenantId)
      .maybeSingle();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const body = req.body || {};

    // Detect id-based fetch mode. Treat empty/whitespace-only id values as
    // invalid (not as "absent") so we can flag them distinctly.
    const idCandidates = Object.keys(ID_PARAM_TO_MODULE)
      .map(k => {
        const raw = req.query[k] ?? body[k];
        if (raw === undefined || raw === null) return null;
        return { key: k, raw, value: String(raw).trim(), module: ID_PARAM_TO_MODULE[k] };
      })
      .filter(Boolean);

    const invalidIds = idCandidates.filter(c => c.value === '');
    if (invalidIds.length > 0) {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: invalidIds[0].module,
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'inbound',
        error_message: `Empty/invalid id supplied for ${invalidIds.map(c => c.key).join(', ')}`
      });
      return res.status(400).json({
        error: `Empty value for ${invalidIds.map(c => c.key).join(', ')}`,
        log_id: log?.id || null
      });
    }

    const presentIds = idCandidates.map(c => c.key);
    if (presentIds.length > 1) {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: 'unknown',
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'inbound',
        error_message: `Conflicting id params supplied: ${presentIds.join(', ')}`
      });
      return res.status(400).json({
        error: 'Multiple id params supplied; only one of contactId/orgId allowed',
        log_id: log?.id || null
      });
    }

    const idParam = pickIdParam(req, body);
    const moduleParam = req.query.module || body.module || body.Module || null;

    // If both an id param and an explicit module are supplied, they must agree.
    if (idParam && moduleParam && moduleParam !== idParam.module) {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: moduleParam,
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'inbound',
        error_message: `${idParam.key} implies module=${idParam.module} but module=${moduleParam} was supplied`
      });
      return res.status(400).json({
        error: `Conflicting module: ${idParam.key} implies ${idParam.module}, got ${moduleParam}`,
        log_id: log?.id || null
      });
    }

    const module = moduleParam || idParam?.module || null;
    const inlineRecord = hasInlineRecord(body);

    if (!module) {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: 'unknown',
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'inbound',
        error_message: 'Missing Zoho module and no contactId/orgId supplied'
      });
      return res.status(400).json({
        error: 'Missing Zoho module (set ?module=Contacts/Leads/Accounts, include in body, or supply contactId/orgId)',
        log_id: log?.id || null
      });
    }

    // Build the records list. If we have an inline record use it as-is
    // (backward compatible). Otherwise, fetch the record by id from Zoho.
    let records = [];
    if (inlineRecord) {
      if (Array.isArray(body)) records = body;
      else if (Array.isArray(body.data)) records = body.data;
      else if (body.record) records = [body.record];
      else records = [body];
    } else if (idParam) {
      try {
        const resp = await zohoCrmApiCall(tenantId, `/${idParam.module}/${encodeURIComponent(idParam.value)}`);
        const fetched = Array.isArray(resp?.data) ? resp.data[0] : null;
        if (!fetched) {
          const log = await writeSyncLog({
            tenant_id: tenantId, entity_type: 'unknown', zoho_module: idParam.module,
            zoho_record_id: idParam.value,
            status: 'failed', direction: 'inbound', source: 'webhook', action: 'inbound',
            error_message: `Zoho returned no record for ${idParam.module}/${idParam.value}`
          });
          return res.status(404).json({
            error: `No ${idParam.module} record found in Zoho for id ${idParam.value}`,
            log_id: log?.id || null
          });
        }
        records = [fetched];
      } catch (err) {
        const msg = err?.message || String(err);
        const status = /\b404\b/.test(msg)
          ? 404
          : /\b401\b|INVALID_TOKEN|reconnect/i.test(msg)
            ? 401
            : /\b400\b|INVALID_DATA|invalid.?id|INVALID_REQUEST/i.test(msg)
              ? 400
              : 502;
        const log = await writeSyncLog({
          tenant_id: tenantId, entity_type: 'unknown', zoho_module: idParam.module,
          zoho_record_id: idParam.value,
          status: 'failed', direction: 'inbound', source: 'webhook', action: 'inbound',
          error_message: `Failed to fetch ${idParam.module}/${idParam.value} from Zoho: ${msg}`
        });
        return res.status(status).json({
          error: 'Failed to fetch record from Zoho',
          details: msg,
          log_id: log?.id || null
        });
      }
    } else {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: module,
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'inbound',
        error_message: 'No records in payload and no contactId/orgId supplied'
      });
      return res.status(400).json({
        error: 'No records found in payload (and no contactId/orgId supplied)',
        log_id: log?.id || null
      });
    }

    if (records.length === 0) {
      return res.status(400).json({ error: 'No records found in payload' });
    }

    const results = [];
    for (const rec of records) {
      try {
        const log = await applyInboundFromZoho(tenantId, module, rec, { source: 'webhook' });
        results.push({ id: rec.id || rec.Id || null, status: log?.status || 'unknown', log_id: log?.id || null });
      } catch (err) {
        console.error('[ZohoCRM Webhook] Record error:', err);
        results.push({ id: rec.id || rec.Id || null, status: 'failed', error: err.message });
      }
    }

    return res.status(200).json({ success: true, processed: results.length, results });
  } catch (err) {
    console.error('[ZohoCRM Webhook] Error:', err);
    return res.status(500).json({ error: 'Webhook processing failed', details: err.message });
  }
}
