import { supabase } from '../../_lib/database.js';
import { validateCrmWebhookSecret } from '../../_lib/zohoCrmClient.js';
import { applyInboundDeleteFromZoho, writeSyncLog } from '../../_lib/zohoCrmSync.js';

// Hard budget for the inbound delete pipeline. The delete path itself is
// just one find + one DELETE/UPDATE per id, but a malformed batch could
// still drag on — keep an outer bound well below Vercel's 60s function
// cap, identical in spirit to the upsert webhook's INBOUND_BUDGET_MS.
const INBOUND_DELETE_BUDGET_MS = Number(process.env.ZOHO_WEBHOOK_DELETE_BUDGET_MS) || 15000;

// Single-flight per tenant. Mirrors the upsert webhook so a Zoho Flow that
// fans out concurrent retries does not stack invocations on top of each
// other inside the same process. Best-effort across instances; the
// inbound-origin tracker plus tombstone suppression handle any small
// cross-process races safely.
const inFlightByTenant = new Map();

class InboundBudgetExceededError extends Error {
  constructor(ms) {
    super(`Inbound delete processing exceeded time budget (${ms}ms)`);
    this.name = 'InboundBudgetExceededError';
    this.budgetMs = ms;
  }
}

function withBudget(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new InboundBudgetExceededError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Same shape as the upsert webhook's `ID_PARAM_TO_MODULE` so a Zoho Flow
// that already POSTs `{ contactId }` / `{ orgId }` to the upsert endpoint
// can use an identical body for deletes.
const ID_PARAM_TO_MODULE = {
  contactId: 'Contacts',
  orgId: 'Accounts'
};

const ALLOWED_MODULES = new Set(['Contacts', 'Leads', 'Accounts']);

/**
 * Inbound DELETE webhook for Zoho CRM workflow rules and Zoho Flow.
 *
 * URL shape: POST /api/zoho-crm/webhook/delete?tenantId=<uuid>
 * Auth:      header `X-Zoho-Webhook-Secret: <per-tenant secret>` (also
 *            accepted via ?secret=… for setups that cannot send custom
 *            headers — same as the upsert webhook).
 *
 * Three accepted body shapes (mirroring the upsert webhook so a Zoho
 * setup can reuse the same configuration with a different URL):
 *
 *   1. `{ module: "Contacts" | "Leads" | "Accounts", id: "<zoho id>" }`
 *   2. `{ module: "...", ids: ["<id1>", "<id2>", ...] }`
 *   3. `{ contactId: "..." }`  (module inferred → Contacts)
 *      `{ orgId: "..." }`      (module inferred → Accounts)
 *
 * Per the task:
 *   - Always returns 200 for idempotent no-ops with a `reason` field.
 *   - Returns 4xx only for malformed/unauthorised requests.
 *   - Every call writes a `zoho_crm_sync_log` row with action `delete_inbound`.
 *   - The delete is suppressed from echoing back to Zoho via the existing
 *     inbound-origin tracker + targeted tombstone suppression in
 *     `applyInboundDeleteFromZoho`.
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

    // ---------- Resolve module + ids from the three accepted shapes ----------
    // 1. id-param shorthand: { contactId } / { orgId } (also accepted on query
    //    string for parity with the upsert webhook).
    const idCandidates = Object.keys(ID_PARAM_TO_MODULE)
      .map(k => {
        const raw = req.query[k] ?? body[k];
        if (raw === undefined || raw === null) return null;
        return { key: k, value: String(raw).trim(), module: ID_PARAM_TO_MODULE[k] };
      })
      .filter(Boolean);

    const invalidIds = idCandidates.filter(c => c.value === '');
    if (invalidIds.length > 0) {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: invalidIds[0].module,
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'delete_inbound',
        error_message: `Empty/invalid id supplied for ${invalidIds.map(c => c.key).join(', ')}`
      });
      return res.status(400).json({
        error: `Empty value for ${invalidIds.map(c => c.key).join(', ')}`,
        log_id: log?.id || null
      });
    }
    const validIdParams = idCandidates.filter(c => c.value);
    if (validIdParams.length > 1) {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: 'unknown',
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'delete_inbound',
        error_message: `Conflicting id params supplied: ${validIdParams.map(c => c.key).join(', ')}`
      });
      return res.status(400).json({
        error: 'Multiple id params supplied; only one of contactId/orgId allowed',
        log_id: log?.id || null
      });
    }

    const idParam = validIdParams[0] || null;
    const explicitModule = req.query.module || body.module || body.Module || null;

    // 2. explicit module conflict check (matches upsert webhook behaviour).
    if (idParam && explicitModule && explicitModule !== idParam.module) {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: explicitModule,
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'delete_inbound',
        error_message: `${idParam.key} implies module=${idParam.module} but module=${explicitModule} was supplied`
      });
      return res.status(400).json({
        error: `Conflicting module: ${idParam.key} implies ${idParam.module}, got ${explicitModule}`,
        log_id: log?.id || null
      });
    }

    const module = explicitModule || idParam?.module || null;
    if (!module) {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: 'unknown',
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'delete_inbound',
        error_message: 'Missing Zoho module and no contactId/orgId supplied'
      });
      return res.status(400).json({
        error: 'Missing Zoho module (set ?module=Contacts/Leads/Accounts, include in body, or supply contactId/orgId)',
        log_id: log?.id || null
      });
    }
    if (!ALLOWED_MODULES.has(module)) {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: module,
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'delete_inbound',
        error_message: `Unsupported Zoho module: ${module}`
      });
      return res.status(400).json({
        error: `Unsupported module "${module}" — must be one of Contacts, Leads, Accounts`,
        log_id: log?.id || null
      });
    }

    // 3. Collect ids: prefer { ids: [...] }, fall back to { id }, then idParam.
    let ids = [];
    if (Array.isArray(body.ids)) {
      ids = body.ids;
    } else if (body.id !== undefined && body.id !== null) {
      ids = [body.id];
    } else if (idParam) {
      ids = [idParam.value];
    }
    ids = ids
      .map(v => (v === undefined || v === null ? '' : String(v).trim()))
      .filter(Boolean);

    if (ids.length === 0) {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: module,
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'delete_inbound',
        error_message: 'No Zoho record id supplied (expected { id }, { ids: [...] }, or contactId/orgId)'
      });
      return res.status(400).json({
        error: 'No Zoho record id supplied',
        log_id: log?.id || null
      });
    }

    // Single-flight per tenant. Treat in-flight contention as an idempotent
    // no-op for this caller (the prior request will complete the work) and
    // return 200 with `skipped: 'in_flight'` so Zoho Flow does not retry on
    // a 4xx/5xx. The `skipped` log row makes it visible in the admin UI.
    if (inFlightByTenant.has(tenantId)) {
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: module,
        zoho_record_id: ids[0],
        status: 'skipped', direction: 'inbound', source: 'webhook', action: 'delete_inbound',
        error_message: 'Skipped: another inbound delete webhook is already in-flight for this tenant'
      });
      return res.status(200).json({
        success: true,
        skipped: 'in_flight',
        log_id: log?.id || null
      });
    }

    const work = (async () => {
      const results = [];
      for (const zohoId of ids) {
        try {
          const log = await applyInboundDeleteFromZoho(tenantId, module, zohoId, { source: 'webhook' });
          results.push({
            id: zohoId,
            status: log?.status || 'unknown',
            // The delete path stuffs `{ reason, policy, entity_id }` into
            // response_payload — surface `reason` at the top level so Zoho
            // Flow can branch on it without parsing the whole envelope.
            reason: log?.response_payload?.reason || null,
            policy: log?.response_payload?.policy || null,
            entity_id: log?.response_payload?.entity_id || null,
            log_id: log?.id || null
          });
        } catch (err) {
          console.error('[ZohoCRM Webhook Delete] Record error:', err);
          const failLog = await writeSyncLog({
            tenant_id: tenantId, entity_type: 'unknown', zoho_module: module,
            zoho_record_id: zohoId,
            status: 'failed', direction: 'inbound', source: 'webhook', action: 'delete_inbound',
            error_message: `Inbound delete threw: ${err?.message || String(err)}`
          });
          results.push({
            id: zohoId,
            status: 'failed',
            error: err?.message || String(err),
            log_id: failLog?.id || null
          });
        }
      }
      return { httpStatus: 200, body: { success: true, processed: results.length, results } };
    })();

    inFlightByTenant.set(tenantId, work);
    try {
      const result = await withBudget(work, INBOUND_DELETE_BUDGET_MS);
      return res.status(result.httpStatus).json(result.body);
    } catch (err) {
      if (err instanceof InboundBudgetExceededError) {
        const log = await writeSyncLog({
          tenant_id: tenantId, entity_type: 'unknown', zoho_module: module,
          zoho_record_id: ids[0] || null,
          status: 'failed', direction: 'inbound', source: 'webhook', action: 'delete_inbound',
          error_message: err.message
        });
        return res.status(504).json({ error: 'Inbound delete webhook timed out', details: err.message, log_id: log?.id || null });
      }
      const msg = err?.message || String(err);
      const log = await writeSyncLog({
        tenant_id: tenantId, entity_type: 'unknown', zoho_module: module,
        zoho_record_id: ids[0] || null,
        status: 'failed', direction: 'inbound', source: 'webhook', action: 'delete_inbound',
        error_message: `Inbound delete webhook failed: ${msg}`
      });
      return res.status(502).json({ error: 'Webhook processing failed', details: msg, log_id: log?.id || null });
    } finally {
      Promise.resolve(work).catch(() => {}).finally(() => {
        if (inFlightByTenant.get(tenantId) === work) {
          inFlightByTenant.delete(tenantId);
        }
      });
    }
  } catch (err) {
    console.error('[ZohoCRM Webhook Delete] Error:', err);
    return res.status(500).json({ error: 'Webhook processing failed', details: err.message });
  }
}
