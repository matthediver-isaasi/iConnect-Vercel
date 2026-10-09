import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { requireSalesContext, SalesHttpError } from '../_lib/salesAccess.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';

export function createOpportunityContactsHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const contextFor = dependencies.getTenantContext || getTenantContext;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const actor = await requireSalesContext(await contextFor(req),
        SALES_CAPABILITIES.MANAGE_OPPORTUNITIES, dependencies);
      const { organizationId, offset = '0' } = req.query || {};
      if (typeof organizationId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)
        || !/^\d+$/.test(String(offset)) || !Number.isSafeInteger(Number(offset))) {
        throw new SalesHttpError(400, 'A valid organisation and offset are required');
      }
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      const organization = await db.from('organization').select('id')
        .eq('tenant_id', actor.tenantId).eq('id', organizationId).maybeSingle();
      if (organization.error) throw organization.error;
      if (!organization.data) throw new SalesHttpError(404, 'Organisation not found');
      const start = Number(offset);
      const { data, error } = await db.from('member')
        .select('id,first_name,last_name,email,organization_id')
        .eq('tenant_id', actor.tenantId).eq('organization_id', organizationId)
        .or('email.is.null,email.not.ilike.deleted_%@deleted.local')
        .order('last_name', { ascending: true }).order('first_name', { ascending: true })
        .order('id', { ascending: true }).range(start, start + 99);
      if (error) throw error;
      return res.status(200).json({ items: data || [], nextOffset: data?.length === 100 ? start + 100 : null });
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Could not load organisation contacts' : error.message });
    }
  };
}

export default createOpportunityContactsHandler();
