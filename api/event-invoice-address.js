import { supabase } from './_lib/database.js';
import { getTenantContext } from './_lib/tenantContext.js';
import { eventAddressContext } from './_lib/eventInvoiceAddressPolicy.js';

export default async function handler(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await (dependencies.getTenantContext || getTenantContext)(req);
    if (!context?.isAuthenticated || !context.memberId) return res.status(401).json({ error: 'Member authentication required' });
    if (context.tenantMismatch || !context.tenantId
      || (req.headers?.['x-tenant-id'] && req.headers['x-tenant-id'] !== context.tenantId)) {
      return res.status(403).json({ error: 'Tenant context mismatch' });
    }
    const result = await eventAddressContext({ db: dependencies.db || supabase, tenantId: context.tenantId,
      memberId: context.memberId, eventId: req.body?.eventId, source: req.body?.source, lookup: dependencies.lookup });
    return res.json({ applicable: result.applicable, required: result.required,
      personalAddress: result.personalAddress || null, organizationAddress: result.organizationAddress || null,
      organizationLabel: result.organizationLabel || null });
  } catch (error) {
    return res.status(error.statusCode || 503).json({ error: error.message, code: 'EVENT_INVOICE_POLICY_UNAVAILABLE' });
  }
}
