import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { gocardlessForTenant } from '../_lib/gocardless.js';
import { getTrustedBaseUrlForTenant } from '../_lib/publicBaseUrl.js';
import {
  loadReplacementContext, replacementResponse, refreshReplacement, startReplacement, replacementReleased,
} from '../_lib/gocardlessMandateReplacement.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Service unavailable' });
  try {
    // Never accept a browser-selected member, provider environment or mandate.
    const member = await getSessionMember(req);
    if (!member?.id || !member.tenant_id) return res.status(401).json({ error: 'Please sign in to your membership account' });
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id || tenant.id !== member.tenant_id) return res.status(403).json({ error: 'This membership belongs to another site' });
    const gc = await gocardlessForTenant(member.tenant_id);
    if (!gc.isConfigured()) return res.json({ eligible: false, canStart: false, canResume: false });
    const context = await loadReplacementContext({ db: supabase, member, gc });
    // Keep availability truthful while automatic collection handover is gated.
    const released = await replacementReleased(supabase, gc.getGocardlessEnvironment());
    context.canStart = context.canStart && released;
    if (context.eligible && !released) context.reason = 'Please contact your membership team. Mandate replacement is awaiting collection-handover verification.';
    if (req.method === 'GET') return res.json(replacementResponse(context));
    const baseUrl = await getTrustedBaseUrlForTenant(req, supabase, member.tenant_id);
    // Cookie-authenticated mutations must originate at the tenant's trusted site.
    if (req.headers?.origin && new URL(req.headers.origin).origin !== new URL(baseUrl).origin) {
      return res.status(403).json({ error: 'Invalid request origin' });
    }
    if (req.body?.action === 'start') {
      if (context.canStart) return res.json(await startReplacement({ db: supabase, member, gc, context, baseUrl }));
      // Authorization is prepared but withheld until collection handover is
      // released. Do not invite members to authorize an unusable candidate.
      return res.status(409).json({
        ...replacementResponse({ ...context, canStart: false }),
        error: 'Please contact your membership team. Secure mandate replacement is awaiting collection-handover verification.',
      });
    }
    if (req.body?.action === 'refresh') {
      context.operation = await refreshReplacement({ db: supabase, gc, operation: context.operation });
      return res.json(replacementResponse(context));
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('[MandateReplacement]', error.cause?.code || error.name);
    return res.status(503).json({ error: 'We could not confirm mandate replacement status. Please refresh to reconcile the existing operation; do not start another payment arrangement.' });
  }
}
