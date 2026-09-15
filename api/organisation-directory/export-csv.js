import { supabase } from '../_lib/database.js';
import {
  getTenantContext,
  hasAdminAccess,
  hasFeatureAccess,
} from '../_lib/tenantContext.js';
import { makeFeatureAccessChecker, resolveMemberExclusions } from '../_lib/memberFeatureAccess.js';
import {
  createOrganisationDirectoryFilters,
  OrganisationDirectoryFilterError,
  readOrganisationDirectoryCsvSetting,
} from '../_lib/organisationDirectoryFilters.js';

function isEmbedRequest(req) {
  const referer = String(req.headers?.referer || req.headers?.referrer || '');
  return req.query?.embed === 'true' || req.headers?.['x-embed-context'] === 'true'
    || /\/embed(?:\/|[?#]|$)/i.test(referer);
}

export function createHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const featureCheck = dependencies.hasFeatureAccess || hasFeatureAccess;
  const exclusionsResolver = dependencies.resolveMemberExclusions || resolveMemberExclusions;
  const adminCheck = dependencies.hasAdminAccess || hasAdminAccess;
  const serviceFactory = dependencies.createOrganisationDirectoryFilters
    || createOrganisationDirectoryFilters;
  const readSetting = dependencies.readOrganisationDirectoryCsvSetting
    || readOrganisationDirectoryCsvSetting;
  const canView = async (context) => {
    if (context.tenantUserId) return true;
    if (!context.roleId || !await featureCheck(context.roleId, 'membership.organisation-directory')) return false;
    const exclusions = await exclusionsResolver({
      roleId: context.roleId,
      memberExcludedFeatures: context.memberExcludedFeatures,
    }, db);
    return makeFeatureAccessChecker(exclusions).canAccessFeature('membership.organisation-directory');
  };

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      const context = await getContext(req);
      if (context?.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (!context?.tenantId) return res.status(400).json({ error: 'Tenant context not found' });
      if (isEmbedRequest(req)) return res.status(403).json({ error: 'Embed access denied' });
      if (!await canView(context)) return res.status(403).json({ error: 'Directory access denied' });
      if (!await readSetting({ db, tenantId: context.tenantId })) {
        return res.status(403).json({ error: 'Organisation directory CSV download is disabled' });
      }

      const service = serviceFactory({
        db, context, isAdmin: await adminCheck(context),
      });
      const { csv } = await service.csv();
      // csv is complete before these headers are emitted: errors can always be
      // returned as JSON rather than an attachment with partial rows.
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="organisation-directory.csv"');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(csv);
    } catch (error) {
      const status = error instanceof OrganisationDirectoryFilterError ? error.status : 500;
      return res.status(status).json({
        error: status === 500 ? 'Failed to export organisation directory CSV' : error.message,
      });
    }
  };
}

export default createHandler();