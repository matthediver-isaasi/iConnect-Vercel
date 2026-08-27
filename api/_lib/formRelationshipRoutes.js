import { supabase } from './database.js';
import { getTenantContext, hasAdminAccess } from './tenantContext.js';
import { resolveTenantFromRequest } from './tenantResolver.js';
import { resolveFormAccess, sendFormAccessDenied } from './formAccessPolicy.js';
import { isFormScheduleAvailable } from './formAvailability.js';
import {
  FormRelationshipError,
  createFormRelationshipService,
} from './formRelationshipOptions.js';

function failure(res, error) {
  const status = error instanceof FormRelationshipError ? error.status : 500;
  return res.status(status).json({
    error: status === 500 ? 'Failed to resolve form relationships' : error.message,
  });
}

export function createFormRelationshipDiscoveryHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const contextResolver = dependencies.getTenantContext || getTenantContext;
  const adminCheck = dependencies.hasAdminAccess || hasAdminAccess;
  const serviceFactory = dependencies.createService || createFormRelationshipService;
  return async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const context = await contextResolver(req);
      if (context?.tenantMismatch) throw new FormRelationshipError(409, 'Tenant context mismatch');
      if (!context?.isAuthenticated || !context?.tenantId) {
        throw new FormRelationshipError(401, 'Authentication required');
      }
      if (!await adminCheck(context)) throw new FormRelationshipError(403, 'Admin access required');
      const service = serviceFactory({ db, tenantId: context.tenantId });
      return res.status(200).json(await service.eligibleDefinitions(req.query.formId));
    } catch (error) {
      return failure(res, error);
    }
  };
}

export function createPublicFormRelationshipOptionsHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const tenantResolver = dependencies.resolveTenantFromRequest || resolveTenantFromRequest;
  const accessResolver = dependencies.resolveFormAccess || resolveFormAccess;
  const serviceFactory = dependencies.createService || createFormRelationshipService;
  return async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const tenant = await tenantResolver(req);
      if (!tenant?.id) throw new FormRelationshipError(404, 'Tenant not found');
      const service = serviceFactory({ db, tenantId: tenant.id });
      const form = await service.loadForm({ slug: req.query.slug, activeOnly: true });
      if (!isFormScheduleAvailable(form)) throw new FormRelationshipError(404, 'Form not found');
      const access = await accessResolver({
        supabase: db,
        req,
        tenantId: tenant.id,
        policy: form.access_policy,
      });
      if (!access.allowed) return sendFormAccessDenied(res, access);
      return res.status(200).json(await service.relationshipOptions({
        slug: req.query.slug,
        fieldId: req.query.fieldId,
        organizationId: req.query.organizationId,
        query: req.query,
        activeOnly: true,
      }));
    } catch (error) {
      return failure(res, error);
    }
  };
}