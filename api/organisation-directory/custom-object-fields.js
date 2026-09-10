import { supabase } from '../_lib/database.js';
import {
  getTenantContext,
  hasAdminAccess,
  hasFeatureAccess,
} from '../_lib/tenantContext.js';
import {
  createCustomObjectDirectory,
  CustomObjectDirectoryError,
} from '../_lib/customObjectDirectory.js';

export function createHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const featureCheck = dependencies.hasFeatureAccess || hasFeatureAccess;
  const adminCheck = dependencies.hasAdminAccess || hasAdminAccess;
  const serviceFactory = dependencies.createCustomObjectDirectory || createCustomObjectDirectory;
  const settingsCheck = dependencies.settingsCheck || (async (context, directoryId) => (
    Boolean(context.tenantUserId)
    || Boolean(context.roleId && await featureCheck(
      context.roleId,
      directoryId === 'main'
        ? 'membership.organisation-directory-settings'
        : 'admin.dynamic-directories',
    ))
  ));

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      const context = await getContext(req);
      if (context?.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      // Custom Object directory data is never a public/embed publication path.
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (!context?.tenantId) return res.status(400).json({ error: 'Tenant context not found' });
      const referer = String(req.headers?.referer || req.headers?.referrer || '');
      const embedRequest = req.query.embed === 'true'
        || req.headers?.['x-embed-context'] === 'true'
        || /\/embed(?:\/|[?#]|$)/i.test(referer);
      if (embedRequest) return res.status(403).json({ error: 'Embed access denied' });

      const isAdmin = await adminCheck(context);
      const directory = serviceFactory({
        db, context, featureCheck, settingsCheck, isAdmin,
      });
      const directoryId = req.query.directory_id || 'main';
      if (req.query.organization_id !== undefined) {
        if (!req.query.source_key) {
          return res.status(400).json({ error: 'source_key is required' });
        }
        return res.json(await directory.values({
          directoryId,
          organizationId: req.query.organization_id,
          sourceKey: req.query.source_key,
          cursor: req.query.cursor || null,
        }));
      }
      return res.json(await directory.metadata({
        directoryId,
        settings: req.query.settings === 'true',
      }));
    } catch (error) {
      const status = error instanceof CustomObjectDirectoryError ? error.status : 500;
      return res.status(status).json({
        error: status === 500 ? 'Failed to load Custom Object directory fields' : error.message,
      });
    }
  };
}

export default createHandler();