import { supabase } from '../_lib/database.js';
import { validateCrmWebhookSecret } from '../_lib/zohoCrmClient.js';
import { applyInboundFromZoho } from '../_lib/zohoCrmSync.js';

/**
 * Inbound webhook for Zoho CRM workflow rules.
 *
 * URL shape: POST /api/zoho-crm/webhook?tenantId=<uuid>
 * Auth: header `X-Zoho-Webhook-Secret: <per-tenant secret>` (also accepted via
 *       ?secret= query for Zoho workflow setups that cannot send custom headers).
 *
 * Accepts either a single record payload or an array under `data`. The Zoho
 * module name must be supplied either in the `module` query param or as a
 * top-level `module` field in the body, since Zoho workflow webhook payloads
 * do not carry the module name themselves.
 */
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
    const module = req.query.module || body.module || body.Module;
    if (!module) {
      return res.status(400).json({ error: 'Missing Zoho module (set ?module=Contacts/Leads/Accounts or include in body)' });
    }

    let records = [];
    if (Array.isArray(body)) records = body;
    else if (Array.isArray(body.data)) records = body.data;
    else if (body.id || body.Id) records = [body];
    else if (body.record) records = [body.record];

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
