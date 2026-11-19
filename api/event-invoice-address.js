import { supabase } from './_lib/database.js';
import { getTenantContext } from './_lib/tenantContext.js';
import { eventAddressContext } from './_lib/eventInvoiceAddressPolicy.js';
import { unifiedBookingReady, unifiedBookingChoices } from './_lib/unifiedBookingContract.js';
import { resolveTenantFromRequest } from './_lib/tenantResolver.js';

export default async function handler(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await (dependencies.getTenantContext || getTenantContext)(req);
    if (req.body?.unified === true) {
      const db = dependencies.db || supabase;
      const tenant = context?.tenantId ? { id: context.tenantId } : await (dependencies.resolveTenantFromRequest || resolveTenantFromRequest)(req);
      if (!tenant?.id || context?.tenantMismatch) return res.status(403).json({ error: 'Tenant context mismatch' });
      if (!await unifiedBookingReady(db)) return res.json({ version: 1, enabled: false });
      const source = req.body?.source;
      if (!['simple', 'complex'].includes(source)) return res.status(400).json({ error: 'Invalid event source' });
      const event = await db.from(source === 'simple' ? 'event' : 'complex_event').select('id')
        .eq('tenant_id', tenant.id).eq('id', req.body.eventId).maybeSingle();
      if (event.error || !event.data) return res.status(404).json({ error: 'Event not found' });
      const choices = await unifiedBookingChoices(db, tenant.id, context?.isAuthenticated ? context.memberId : null);
      return res.json({ version: 2, enabled: true, personalAddress: choices.personalAddress,
        incomplete: choices.incomplete || false, choices: choices.choices.map(({ bindings, ...choice }) => choice) });
    }
    if (!context?.isAuthenticated || !context.memberId) return res.status(401).json({ error: 'Member authentication required' });
    if (context.tenantMismatch || !context.tenantId
      || (req.headers?.['x-tenant-id'] && req.headers['x-tenant-id'] !== context.tenantId)) {
      return res.status(403).json({ error: 'Tenant context mismatch' });
    }
    const result = await eventAddressContext({ db: dependencies.db || supabase, tenantId: context.tenantId,
      memberId: context.memberId, eventId: req.body?.eventId, source: req.body?.source, lookup: dependencies.lookup });
    return res.json({ applicable: result.applicable, required: result.required,
      deferred: result.deferred === true, message: result.message || null,
      personalAddress: result.personalAddress || null, organizationAddress: result.organizationAddress || null,
      organizationLabel: result.organizationLabel || null });
  } catch (error) {
    return res.status(error.statusCode || 503).json({ error: error.message, code: 'EVENT_INVOICE_POLICY_UNAVAILABLE' });
  }
}
