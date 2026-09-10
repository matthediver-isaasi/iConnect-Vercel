import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { createMonthlyMembershipRecoveryService } from '../_lib/monthlyMembershipRecovery.js';
import { getTrustedBaseUrlForTenant } from '../_lib/publicBaseUrl.js';

export function createMonthlyRecoveryHandler({
  db = supabase,
  getContext = getTenantContext,
  isAdmin = hasAdminAccess,
  hasFinance = hasFeatureAccess,
  service = null,
  createService = createMonthlyMembershipRecoveryService,
  resolveTrustedBaseUrl = getTrustedBaseUrlForTenant,
} = {}) {
  return async function handler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const context = await getContext(req);
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (!context.tenantId || !await isAdmin(context)) {
        return res.status(403).json({ error: 'Tenant admin access required' });
      }
      if (context.roleId && !await hasFinance(context.roleId, 'commerce.monthly-finance-report')) {
        return res.status(403).json({ error: 'Monthly membership recovery requires finance permission' });
      }
      const recovery = service || createService({ db });
      if (req.method === 'GET') {
        const agreementId = req.query?.agreementId;
        const result = agreementId
          ? await recovery.preview(context.tenantId, agreementId)
          : await recovery.list(context.tenantId, req.query?.limit);
        return res.json(result);
      }
      const { agreementId, confirmed } = req.body || {};
      if (!agreementId) return res.status(400).json({ error: 'agreementId is required' });
      if (confirmed !== true) return res.status(400).json({ error: 'confirmed must be true' });
      // Admin recovery is server-driven. Never trust Origin/Host for links
      // emitted by form finalization, guarded emails, or completion workflows.
      const trustedBaseUrl = await resolveTrustedBaseUrl(null, db, context.tenantId);
      let parsedBaseUrl;
      try {
        parsedBaseUrl = new URL(trustedBaseUrl);
      } catch {
        parsedBaseUrl = null;
      }
      if (!parsedBaseUrl || parsedBaseUrl.protocol !== 'https:' || !parsedBaseUrl.hostname) {
        return res.status(503).json({ error: 'A trusted canonical tenant URL is required before monthly recovery can run' });
      }
      return res.json(await recovery.resume(
        context.tenantId,
        agreementId,
        confirmed,
        { trustedBaseUrl: parsedBaseUrl.origin },
      ));
    } catch (error) {
      console.error('[MonthlyMembershipRecovery]', {
        code: error.code || null,
        message: error.message,
      });
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Monthly membership recovery failed',
        ...(error.code ? { code: error.code } : {}),
      });
    }
  };
}

export default createMonthlyRecoveryHandler();