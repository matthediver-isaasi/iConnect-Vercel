import { supabase } from '../../../_lib/database.js';
import { resolveTenantFromRequest } from '../../../_lib/tenantResolver.js';
import { SalesHttpError } from '../../../_lib/salesAccess.js';
import { getPublicAllocationInvitationContext } from '../../../_lib/allocationInvitation.js';

export function createAllocationContextHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const resolveTenant = dependencies.resolveTenantFromRequest || resolveTenantFromRequest;
  const getInvitationContext = dependencies.getPublicAllocationInvitationContext || getPublicAllocationInvitationContext;
  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      const token = req.query?.token;
      if (!token || Array.isArray(token)) throw new SalesHttpError(404, 'Allocation invitation not found');
      const context = await getInvitationContext(db, token);
      const tenant = await resolveTenant(req);
      if (!tenant || tenant.id !== context.tenantId) {
        throw new SalesHttpError(404, 'Allocation invitation not found');
      }
      // tenantId is used solely for tenant validation and is not part of the
      // browser handoff contract.
      delete context.tenantId;
      return res.status(200).json(context);
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Failed to resolve allocation invitation' : error.message });
    }
  };
}

export default createAllocationContextHandler();