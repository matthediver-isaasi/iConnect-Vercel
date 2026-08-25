import { supabase } from './database.js';
import { getTenantContext, hasAdminAccess } from './tenantContext.js';
import { CustomObjectHttpError, createCustomObjectService } from './customObjectService.js';

function methodNotAllowed(res, methods) {
  res.setHeader('Allow', methods);
  return res.status(405).json({ error: 'Method not allowed' });
}

export function createCustomObjectRouteHandler(level, dependencies = {}) {
  const getContext = dependencies.getTenantContext || getTenantContext;
  const adminCheck = dependencies.hasAdminAccess || hasAdminAccess;
  const db = dependencies.db || supabase;
  const serviceFactory = dependencies.createCustomObjectService || createCustomObjectService;
  return async function handler(req, res) {
    try {
      const context = await getContext(req);
      if (context?.tenantMismatch) throw new CustomObjectHttpError(409, 'Tenant context mismatch');
      if (!context?.isAuthenticated) throw new CustomObjectHttpError(401, 'Authentication required');
      if (!context?.tenantId) throw new CustomObjectHttpError(400, 'Tenant context not found');
      const service = serviceFactory({
        db, context, isAdmin: await adminCheck(context), now: dependencies.now,
      });
      const objectId = req.query.objectId;
      const resource = req.query.resource;
      const resourceId = req.query.resourceId;
      let data;

      if (level === 'collection') {
        if (req.method === 'GET') data = await service.listObjects(req.query);
        else if (req.method === 'POST') data = await service.createObject(req.body);
        else return methodNotAllowed(res, ['GET', 'POST']);
      } else if (level === 'object') {
        if (req.method === 'GET') data = await service.getObject(objectId);
        else if (req.method === 'PATCH') data = await service.updateObject(objectId, req.body);
        else if (req.method === 'DELETE') data = await service.updateObject(objectId, req.body, true);
        else return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
      } else if (level === 'resource') {
        if (resource === 'fields' && req.method === 'GET') data = await service.listFields(objectId, req.query);
        else if (resource === 'fields' && req.method === 'POST') data = await service.createField(objectId, req.body);
        else if (resource === 'records' && req.method === 'GET') data = await service.listRecords(objectId, req.query);
        else if (resource === 'records' && req.method === 'POST') data = await service.createRecord(objectId, req.body);
        else if (resource === 'relationship-definitions' && req.method === 'GET') data = await service.listRelationshipDefinitions(objectId, req.query);
        else if (resource === 'relationship-definitions' && req.method === 'POST') data = await service.createRelationshipDefinition(objectId, req.body);
        else if (resource === 'relationships' && req.method === 'GET') data = await service.listRelationships(objectId, req.query);
        else if (resource === 'relationships' && req.method === 'POST') data = await service.createRelationship(objectId, req.body);
        else if (resource === 'permissions' && req.method === 'GET') data = await service.listPermissions(objectId, req.query);
        else if (resource === 'permissions' && ['POST', 'PUT'].includes(req.method)) data = await service.upsertPermission(objectId, req.body);
        else if (resource === 'audit' && req.method === 'GET') data = await service.listAudit(objectId, req.query);
        else return methodNotAllowed(res, ['GET', 'POST', 'PUT']);
      } else if (level === 'item') {
        if (resource === 'fields' && req.method === 'PATCH') data = await service.updateField(objectId, resourceId, req.body);
        else if (resource === 'fields' && req.method === 'DELETE') data = await service.updateField(objectId, resourceId, req.body, true);
        else if (resource === 'records' && req.method === 'GET') data = await service.getRecord(objectId, resourceId);
        else if (resource === 'records' && req.method === 'PATCH') data = await service.updateRecord(objectId, resourceId, req.body);
        else if (resource === 'records' && req.method === 'DELETE') data = await service.updateRecord(objectId, resourceId, req.body, true);
        else if (resource === 'relationship-definitions' && req.method === 'PATCH') data = await service.updateRelationshipDefinition(objectId, resourceId, req.body);
        else if (resource === 'relationship-definitions' && req.method === 'DELETE') data = await service.updateRelationshipDefinition(objectId, resourceId, req.body, true);
        else if (resource === 'relationships' && req.method === 'DELETE') data = await service.archiveRelationship(objectId, resourceId);
        else return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
      }
      return res.status(req.method === 'POST' ? 201 : 200).json(data);
    } catch (error) {
      const status = error instanceof CustomObjectHttpError ? error.status : 500;
      return res.status(status).json({
        error: status === 500 ? (error.message || 'Internal server error') : error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
  };
}