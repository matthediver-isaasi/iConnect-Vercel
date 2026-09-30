import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { SALES_CAPABILITIES, validateSalesSettingsPatch } from '../../shared/salesContracts.js';
import { requireSalesContext, SalesHttpError } from '../_lib/salesAccess.js';
import { getSalesSettings, patchSalesSettings } from '../_lib/salesFoundation.js';

export function createSalesSettingsHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  return async function handler(req, res) {
    try {
      if (!['GET', 'PATCH'].includes(req.method)) {
        res.setHeader('Allow', 'GET, PATCH');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      const capability = req.method === 'GET'
        ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_SETTINGS;
      const actor = await requireSalesContext(await getContext(req), capability, dependencies);
      if (req.method === 'GET') return res.status(200).json(await getSalesSettings(db, actor.tenantId));
      const validation = validateSalesSettingsPatch(req.body);
      if (!validation.ok) return res.status(400).json({ error: 'Invalid Sales settings', details: validation.errors });
      return res.status(200).json(await patchSalesSettings(db, actor.tenantId, actor, req.body));
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Failed to handle Sales settings' : error.message });
    }
  };
}

export default createSalesSettingsHandler();