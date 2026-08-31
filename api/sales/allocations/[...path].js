import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { SALES_CAPABILITIES } from '../../../shared/salesContracts.js';
import { requireSalesContext, SalesHttpError } from '../../_lib/salesAccess.js';
import {
  getAllocation,
  listAllocations,
  moveAllocation,
  reconcileAllocationBooking,
  validateAllocationInput,
} from '../../_lib/salesCommercialAllocation.js';

function pathParts(req) {
  const path = req.query?.path;
  if (path) return Array.isArray(path) ? path : String(path).split('/').filter(Boolean);
  return [req.query?.id, req.query?.action].filter(Boolean);
}

export function createSalesAllocationsHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  return async function handler(req, res) {
    try {
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      const [id, action] = pathParts(req);
      const context = await getContext(req);
      const actor = await requireSalesContext(
        context,
        req.method === 'GET' ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_ALLOCATIONS,
        dependencies,
      );

      if (req.method === 'GET' && !id) {
        return res.status(200).json({
          items: await listAllocations(db, actor.tenantId, req.query || {}),
        });
      }
      if (req.method === 'GET' && id && !action) {
        return res.status(200).json(await getAllocation(db, actor.tenantId, id));
      }
      if (req.method === 'POST' && id && ['release', 'cancel', 'reconcile'].includes(action)) {
        const errors = validateAllocationInput(req.body, { reconcile: action === 'reconcile' });
        if (errors.length) return res.status(400).json({ error: 'Invalid allocation movement', details: errors });
        const result = action === 'reconcile'
          ? await reconcileAllocationBooking(db, actor.tenantId, actor, id, req.body)
          : await moveAllocation(db, actor.tenantId, actor, id, action === 'release' ? 'released' : 'cancelled', req.body);
        return res.status(200).json(result);
      }
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Failed to handle Sales allocation' : error.message });
    }
  };
}

export default createSalesAllocationsHandler();
