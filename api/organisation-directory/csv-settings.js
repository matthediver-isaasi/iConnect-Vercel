import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { makeFeatureAccessChecker, resolveMemberExclusions } from '../_lib/memberFeatureAccess.js';
import {
  OrganisationDirectoryFilterError,
  readOrganisationDirectoryCsvSetting,
  saveOrganisationDirectoryCsvSetting,
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
  const settingsCheck = dependencies.settingsCheck || (async () => true);
  const readSetting = dependencies.readOrganisationDirectoryCsvSetting
    || readOrganisationDirectoryCsvSetting;
  const saveSetting = dependencies.saveOrganisationDirectoryCsvSetting
    || saveOrganisationDirectoryCsvSetting;
  const canManage = async (context) => {
    // Match /filters?settings=true exactly: tenant users still pass the
    // surrounding settings gate, then bypass only the role feature lookup.
    if (!await settingsCheck(context)) return false;
    if (context.tenantUserId) return true;
    if (!context.roleId
      || !await featureCheck(context.roleId, 'membership.organisation-directory-settings')) return false;
    const exclusions = await exclusionsResolver({
      roleId: context.roleId,
      memberExcludedFeatures: context.memberExcludedFeatures,
    }, db);
    return makeFeatureAccessChecker(exclusions)
      .canAccessFeature('membership.organisation-directory-settings');
  };

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    if (!['GET', 'PUT'].includes(req.method)) {
      res.setHeader('Allow', 'GET, PUT');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      const context = await getContext(req);
      if (context?.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (!context?.tenantId) return res.status(400).json({ error: 'Tenant context not found' });
      if (isEmbedRequest(req)) return res.status(403).json({ error: 'Embed access denied' });
      if (!await canManage(context)) return res.status(403).json({ error: 'Directory settings access denied' });

      if (req.method === 'GET') {
        return res.json({ allowCsvDownload: await readSetting({ db, tenantId: context.tenantId }) });
      }
      return res.json({
        allowCsvDownload: await saveSetting({
          db, tenantId: context.tenantId, allowCsvDownload: req.body?.allowCsvDownload,
        }),
      });
    } catch (error) {
      const status = error instanceof OrganisationDirectoryFilterError ? error.status : 500;
      return res.status(status).json({
        error: status === 500 ? 'Failed to update organisation directory CSV settings' : error.message,
      });
    }
  };
}

export default createHandler();