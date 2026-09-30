import { supabase } from '../_lib/database.js';
import {
  getTenantContext,
  hasAdminAccess,
  hasFeatureAccess,
} from '../_lib/tenantContext.js';
import {
  makeFeatureAccessChecker,
  resolveMemberExclusions,
} from '../_lib/memberFeatureAccess.js';
import {
  createOrganisationDirectoryFilters,
  OrganisationDirectoryFilterError,
  saveOrganisationDirectoryFilterOverrides,
} from '../_lib/organisationDirectoryFilters.js';

export function createHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const featureCheck = dependencies.hasFeatureAccess || hasFeatureAccess;
  const adminCheck = dependencies.hasAdminAccess || hasAdminAccess;
  const exclusionsResolver = dependencies.resolveMemberExclusions || resolveMemberExclusions;
  const serviceFactory = dependencies.createOrganisationDirectoryFilters
    || createOrganisationDirectoryFilters;
  const memberCanAccess = async (context, feature) => {
    if (context.tenantUserId) return true;
    if (!context.roleId || !await featureCheck(context.roleId, feature)) return false;
    const exclusions = await exclusionsResolver({
      roleId: context.roleId,
      memberExcludedFeatures: context.memberExcludedFeatures,
    }, db);
    return makeFeatureAccessChecker(exclusions).canAccessFeature(feature);
  };
  const settingsCheck = dependencies.settingsCheck || (async () => true);

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    try {
      const context = await getContext(req);
      if (context?.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (!context?.tenantId) return res.status(400).json({ error: 'Tenant context not found' });
      const referer = String(req.headers?.referer || req.headers?.referrer || '');
      if (req.query?.embed === 'true' || req.headers?.['x-embed-context'] === 'true'
          || /\/embed(?:\/|[?#]|$)/i.test(referer)) {
        return res.status(403).json({ error: 'Embed access denied' });
      }
      const settings = req.query?.settings === 'true';
      const canView = await memberCanAccess(
        context, 'membership.organisation-directory',
      );
      const canManage = settings
        && await settingsCheck(context)
        && await memberCanAccess(
          context, 'membership.organisation-directory-settings',
        );
      if (settings && !canManage) return res.status(403).json({ error: 'Directory settings access denied' });
      if (!settings && !canView) return res.status(403).json({ error: 'Directory access denied' });
      const isAdmin = await adminCheck(context);
      const service = serviceFactory({ db, context, isAdmin });

      if (req.method === 'GET') {
        return res.json(await service.metadata({ settings }));
      }
      if (req.method === 'PUT' && settings) {
        const metadata = await service.metadata({ settings: true });
        const overrides = await saveOrganisationDirectoryFilterOverrides({
          db,
          tenantId: context.tenantId,
          changes: req.body?.changes,
          writableKeys: new Set(metadata.fields.map((field) => field.key)),
        });
        return res.json({ overrides });
      }
      if (req.method === 'POST' && !settings) {
        return res.json(req.body?.action === 'options'
          ? await service.options(req.body)
          : await service.search(req.body));
      }
      res.setHeader('Allow', settings ? 'GET, PUT' : 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
      const status = error instanceof OrganisationDirectoryFilterError ? error.status : 500;
      if (status === 500) {
        console.error('[organisation-directory-filters]', {
          code: error?.diagnosticCode || 'DIRECTORY_INTERNAL_ERROR',
          context: error?.diagnosticContext || 'request',
          ...(error?.dbCode ? { dbCode: error.dbCode } : {}),
        });
      }
      return res.status(status).json({
        error: status === 500 ? 'Failed to load organisation directory filters' : error.message,
      });
    }
  };
}

export default createHandler();