import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { requireSalesContext, SalesHttpError } from '../../_lib/salesAccess.js';
import { SALES_CAPABILITIES } from '../../../shared/salesContracts.js';
import { listCatalogueTaxOptions, getDefaultProductTaxCode } from '../../_lib/salesCatalogueTaxOptions.js';

export function createCatalogueTaxOptionsHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const context = await (dependencies.getTenantContext || getTenantContext)(req);
      let actor;
      try { actor = await requireSalesContext(context, SALES_CAPABILITIES.MANAGE_CATALOGUE_PRICES, dependencies); }
      catch (error) {
        if (error.status !== 403) throw error;
        actor = await requireSalesContext(context, SALES_CAPABILITIES.MANAGE_QUOTES, dependencies);
      }
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      const options = await listCatalogueTaxOptions(db, actor.tenantId, dependencies);
      return res.status(200).json({ ...options, ...await getDefaultProductTaxCode(db, actor.tenantId, options) });
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({
        error: status === 500 ? 'Could not load synced VAT/tax codes. Please try again.' : error.message,
      });
    }
  };
}
export default createCatalogueTaxOptionsHandler();
