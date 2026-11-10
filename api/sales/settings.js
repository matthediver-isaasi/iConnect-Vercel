import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { SALES_CAPABILITIES, validateSalesSettingsPatch } from '../../shared/salesContracts.js';
import { requireSalesContext, SalesHttpError } from '../_lib/salesAccess.js';
import { getSalesSettings, patchSalesSettings } from '../_lib/salesFoundation.js';
import { createHash, randomUUID } from 'node:crypto';

export function createSalesSettingsHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  return async function handler(req, res) {
    let actor;
    try {
      if (!['GET', 'PATCH'].includes(req.method)) {
        res.setHeader('Allow', 'GET, PATCH');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      const capability = req.method === 'GET'
        ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_SETTINGS;
      actor = await requireSalesContext(await getContext(req), capability, dependencies);
      if (req.method === 'GET') return res.status(200).json(await getSalesSettings(db, actor.tenantId));
      const validation = validateSalesSettingsPatch(req.body);
      if (!validation.ok) return res.status(400).json({ error: 'Invalid Sales settings', details: validation.errors });
      return res.status(200).json(await patchSalesSettings(db, actor.tenantId, actor, req.body));
    } catch (error) {
      if (error.code === 'SALES_SETTINGS_VERSION_CONFLICT' && actor) {
        // Attribution only: never log settings values, cookies, tokens or raw identities.
        // The observed version is diagnostic, not authority to retry a stale write.
        let observedVersion = null;
        try {
          const result = await db.from('sales_settings').select('version').eq('tenant_id', actor.tenantId).maybeSingle();
          if (!result.error && Number.isInteger(result.data?.version)) observedVersion = result.data.version;
        } catch { /* Diagnostics must not change the conflict response. */ }
        const fingerprint = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
        const event = {
          event: 'sales_settings_conflict', requestId: randomUUID(),
          tenant: fingerprint(actor.tenantId), actor: fingerprint(`${actor.actorType}:${actor.actorId}`),
          actorType: actor.actorType, expectedVersion: req.body.expectedVersion, observedVersion,
          fields: Object.keys(req.body).filter(key => key !== 'expectedVersion').sort(),
          route: '/api/sales/settings', method: 'PATCH',
        };
        try { (dependencies.logConflict || (event => console.warn(JSON.stringify(event))))(event); } catch { /* Non-fatal logging. */ }
      }
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Failed to handle Sales settings' : error.message });
    }
  };
}

export default createSalesSettingsHandler();