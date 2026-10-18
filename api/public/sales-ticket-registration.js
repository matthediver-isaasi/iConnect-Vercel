import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { SalesHttpError } from '../_lib/salesAccess.js';
import { resolveCustomerFulfilment, customerFulfilmentContext, registerCustomerDelegate, fulfilmentResult } from '../_lib/salesCustomerFulfilment.js';
import { hashAllocationInviteToken } from '../_lib/allocationInvitation.js';

export function createSalesTicketRegistrationHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const input = req.body || {};
      if (!['context', 'register'].includes(input.action)) throw new SalesHttpError(400, 'Invalid action');
      const tenant = await (dependencies.resolveTenantFromRequest || resolveTenantFromRequest)(req);
      if (!tenant?.id) throw new SalesHttpError(404, 'Registration link is unavailable');
      const row = await resolveCustomerFulfilment(db, tenant.id, input.token);
      const limited = await fulfilmentResult(db.rpc('consume_sales_quote_public_rate_limit', {
        p_token_hash_hex: hashAllocationInviteToken(input.token),
        p_client_key: 'sales-customer-fulfilment', p_limit: 120, p_window_seconds: 60,
      }));
      if (limited) throw new SalesHttpError(429, 'Too many requests; please try again shortly');
      const output = input.action === 'context'
        ? await customerFulfilmentContext(db, row)
        : await registerCustomerDelegate(db, row, input.token, input);
      return res.status(200).json(output);
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Ticket registration is unavailable' : error.message,
        ...(error.code === 'invalid_token' ? { code: 'invalid_token' } : {}) });
    }
  };
}
export default createSalesTicketRegistrationHandler();
