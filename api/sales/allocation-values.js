import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { requireSalesContext, SalesHttpError } from '../_lib/salesAccess.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function createAllocationValuesHandler(deps = {}) {
  const db = deps.db || supabase;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
      const context = await (deps.getTenantContext || getTenantContext)(req);
      const actor = await requireSalesContext(context, req.method === 'POST'
        ? SALES_CAPABILITIES.MANAGE_ALLOCATIONS : SALES_CAPABILITIES.VIEW, deps);
      if (!context.tenantUserId) throw new SalesHttpError(403, 'Only tenant administrators can assign ticket values');
      const id = req.method === 'GET' ? req.query?.id : req.body?.allocationId;
      if (!uuid(id)) throw new SalesHttpError(400, 'Valid allocation ID required');
      const allocation = await db.from('sales_commercial_allocation')
        .select('id,quote_line_id,proposal_value_snapshot,allocated_places')
        .eq('tenant_id', actor.tenantId).eq('id', id).maybeSingle();
      if (allocation.error) throw allocation.error;
      if (!allocation.data) throw new SalesHttpError(404, 'Allocation not found');
      let snapshot = allocation.data.proposal_value_snapshot;
      if (req.method === 'POST') {
        const { netMinor, reason, idempotencyKey } = req.body;
        if (!Number.isSafeInteger(netMinor) || netMinor < 0 || typeof reason !== 'string'
          || !reason.trim() || reason.trim().length > 2000 || !uuid(idempotencyKey)) {
          throw new SalesHttpError(400, 'Enter a valid total net amount, reason and request key');
        }
        const result = await db.rpc('resolve_sales_allocation_value', {
          p_tenant_id: actor.tenantId, p_allocation_id: id, p_actor_id: actor.actorId,
          p_net_minor: netMinor, p_reason: reason.trim(), p_idempotency_key: idempotencyKey,
        });
        if (result.error) throw result.error;
        snapshot = result.data;
      } else if (snapshot?.status === 'pending') {
        const result = await db.from('sales_allocation_value_resolution').select('snapshot')
          .eq('tenant_id', actor.tenantId).eq('allocation_id', id).maybeSingle();
        if (result.error) throw result.error;
        snapshot = result.data?.snapshot || snapshot;
      }
      return res.json({
        status: !snapshot ? 'historical' : snapshot.status === 'pending' ? 'pending' : 'allocated',
        currency: snapshot?.currency || null,
        netMinor: snapshot?.netMinor ?? null, taxMinor: snapshot?.taxMinor ?? null,
        lineNetMinor: snapshot?.lineNetMinor ?? null, lineTaxMinor: snapshot?.lineTaxMinor ?? null,
        places: allocation.data.allocated_places,
      });
    } catch (error) {
      return res.status(error.status || (['23514', '23505'].includes(error.code) ? 409 : error.code === '22023' ? 400 : 500))
        .json({ error: error.message || 'Unable to allocate ticket value' });
    }
  };
}
export default createAllocationValuesHandler();
