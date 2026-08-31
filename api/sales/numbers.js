import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';
import { requireSalesContext, SalesHttpError } from '../_lib/salesAccess.js';
import { allocateSalesNumber } from '../_lib/salesFoundation.js';

export function createSalesNumberHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      const actor = await requireSalesContext(
        await getContext(req), SALES_CAPABILITIES.MANAGE_QUOTES, dependencies,
      );
      return res.status(201).json(await allocateSalesNumber(
        db, actor.tenantId, actor, req.body?.kind || 'quote',
      ));
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Failed to allocate Sales identifier' : error.message });
    }
  };
}

export default createSalesNumberHandler();