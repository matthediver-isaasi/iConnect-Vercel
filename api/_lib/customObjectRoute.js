import { supabase } from './database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from './tenantContext.js';
import { isResourceExcluded } from './roleVisibility.js';
import { CustomObjectHttpError, createCustomObjectService } from './customObjectService.js';

const VIEW_SCHEMA_FEATURE = 'admin.data-studio';
const MANAGE_SCHEMA_FEATURE = 'data.custom-objects.manage-data-model';

function schemaAccessRequired(level, resource, method) {
  if ([
    'records',
    'export',
    'relationships',
    'entity-picker',
    'initial-relationship-candidates',
    'relationship-filter-options',
  ].includes(resource)) return null;
  if (level === 'resource' && resource === 'relationship-definitions') return method === 'GET' ? 'view' : 'manage';
  if (level === 'resource' && resource === 'relationship-definition-graph') return 'manage';
  if (
    method === 'GET'
    && (
      ['collection', 'object'].includes(level)
      || resource === 'fields'
    )
  ) return null;
  if (method === 'GET') return 'view';
  if (
    ['collection', 'object'].includes(level)
    || ['fields', 'relationship-definitions', 'relationship-definition-graph', 'permissions', 'field-permissions'].includes(resource)
  ) return 'manage';
  return null;
}

function supportsRecordGrantFallback(level, resource, method) {
  return method === 'GET' && (
    ['collection', 'object'].includes(level)
    || resource === 'fields'
  );
}

function methodNotAllowed(res, methods) {
  res.setHeader('Allow', methods);
  return res.status(405).json({ error: 'Method not allowed' });
}

export function createCustomObjectRouteHandler(level, dependencies = {}) {
  const getContext = dependencies.getTenantContext || getTenantContext;
  const adminCheck = dependencies.hasAdminAccess || hasAdminAccess;
  const featureCheck = dependencies.hasFeatureAccess || hasFeatureAccess;
  const db = dependencies.db || supabase;
  const serviceFactory = dependencies.createCustomObjectService || createCustomObjectService;
  return async function handler(req, res) {
    try {
      const context = await getContext(req);
      if (context?.tenantMismatch) throw new CustomObjectHttpError(409, 'Tenant context mismatch');
      if (!context?.isAuthenticated) throw new CustomObjectHttpError(401, 'Authentication required');
      if (!context?.tenantId) throw new CustomObjectHttpError(400, 'Tenant context not found');
      const objectId = req.query.objectId;
      const resource = req.query.resource;
      const resourceId = req.query.resourceId;
      const isAdmin = await adminCheck(context);
      const requiredAccess = schemaAccessRequired(level, resource, req.method);
      const resolveSchemaAccess = requiredAccess
        || supportsRecordGrantFallback(level, resource, req.method);
      // Schema access follows the role editor exactly. A portal member's broad
      // admin capability must not override an explicit schema exclusion.
      const override = Boolean(context.tenantUserId);
      let canViewSchema = override;
      let canManageSchema = override;
      if (resolveSchemaAccess && !override && context.roleId) {
        const memberExclusions = context.memberExcludedFeatures || [];
        canViewSchema = Boolean(await featureCheck(context.roleId, VIEW_SCHEMA_FEATURE))
          && !isResourceExcluded(memberExclusions, VIEW_SCHEMA_FEATURE);
        canManageSchema = Boolean(await featureCheck(context.roleId, MANAGE_SCHEMA_FEATURE))
          && !isResourceExcluded(memberExclusions, MANAGE_SCHEMA_FEATURE);
      }
      if (
        (requiredAccess === 'view' && !canViewSchema)
        || (requiredAccess === 'manage' && !canManageSchema)
      ) {
        throw new CustomObjectHttpError(403, 'Access denied');
      }
      const service = serviceFactory({
        db, context, isAdmin, canViewSchema, canManageSchema, now: dependencies.now,
      });
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
        if (objectId === 'core' && resource === 'relationship-definitions' && req.method === 'GET') {
          data = await service.listCoreRelationshipDefinitions(req.query.kind, req.query.recordId);
        } else if (objectId === 'core' && resource === 'relationships' && req.method === 'GET') {
          data = await service.listCoreRelationships(req.query.kind, req.query.recordId, req.query);
        } else if (objectId === 'core' && resource === 'entity-picker' && req.method === 'GET') {
          data = await service.coreEntityPicker(req.query.kind, req.query.recordId, req.query);
        } else if (objectId === 'core' && resource === 'relationships' && req.method === 'POST') {
          data = await service.createCoreRelationship(req.query.kind, req.query.recordId, req.body);
        } else if (resource === 'fields' && req.method === 'GET') data = await service.listFields(objectId, req.query);
        else if (resource === 'fields' && req.method === 'POST') data = await service.createField(objectId, req.body);
        else if (resource === 'records' && req.method === 'GET') data = await service.listRecords(objectId, req.query);
        else if (resource === 'export' && req.method === 'GET') data = await service.exportRecords(objectId, req.query);
        else if (resource === 'records' && req.method === 'POST') {
          data = req.body?.originating_relationship !== undefined
            || req.body?.originatingRelationship !== undefined
            || req.body?.initial_relationships !== undefined
            || req.body?.initialRelationships !== undefined
            || req.body?.relationships !== undefined
            ? await service.createRecordWithRelationships(objectId, req.body)
            : await service.createRecord(objectId, req.body);
        }
        else if (resource === 'relationship-definitions' && req.method === 'GET') data = await service.listRelationshipDefinitions(objectId, req.query);
        else if (resource === 'relationship-definitions' && req.method === 'POST') data = await service.createRelationshipDefinition(objectId, req.body);
        else if (resource === 'relationship-definition-graph' && req.method === 'GET') data = await service.relationshipDefinitionGraph(objectId);
        else if (resource === 'initial-relationship-candidates' && req.method === 'GET') data = await service.initialRelationshipCandidates(objectId, req.query);
        else if (resource === 'relationship-filter-options' && req.method === 'GET') data = await service.relationshipFilterOptions(objectId, req.query);
        else if (resource === 'entity-picker' && req.method === 'GET') data = await service.entityPicker(objectId, req.query);
        else if (resource === 'relationships' && req.method === 'GET') data = await service.listRelationships(objectId, req.query);
        else if (resource === 'relationships' && req.method === 'POST') data = await service.createRelationship(objectId, req.body);
        else if (resource === 'permissions' && req.method === 'GET') data = await service.listPermissions(objectId, req.query);
        else if (resource === 'permissions' && ['POST', 'PUT'].includes(req.method)) data = await service.upsertPermission(objectId, req.body);
        else if (resource === 'field-permissions' && req.method === 'GET') data = await service.listFieldPermissions(objectId, req.query);
        else if (resource === 'field-permissions' && ['POST', 'PUT'].includes(req.method)) data = await service.upsertFieldPermission(objectId, req.body);
        else if (resource === 'audit' && req.method === 'GET') data = await service.listAudit(objectId, req.query);
        else return methodNotAllowed(res, ['GET', 'POST', 'PUT']);
      } else if (level === 'item') {
        if (objectId === 'core' && resource === 'relationships' && req.method === 'DELETE') {
          data = await service.archiveCoreRelationship(req.query.kind, req.query.recordId, resourceId);
        } else if (resource === 'fields' && req.method === 'PATCH') data = await service.updateField(objectId, resourceId, req.body);
        else if (resource === 'fields' && req.method === 'DELETE') data = await service.updateField(objectId, resourceId, req.body, true);
        else if (resource === 'records' && req.method === 'GET') data = await service.getRecord(objectId, resourceId);
        else if (resource === 'records' && req.method === 'PATCH') data = await service.updateRecord(objectId, resourceId, req.body);
        else if (resource === 'records' && req.method === 'DELETE') data = await service.updateRecord(objectId, resourceId, req.body, true);
        else if (resource === 'relationship-definitions' && req.method === 'PATCH') data = await service.updateRelationshipDefinition(objectId, resourceId, req.body);
        else if (resource === 'relationship-definitions' && req.method === 'DELETE') data = await service.updateRelationshipDefinition(objectId, resourceId, req.body, true);
        else if (resource === 'relationships' && req.method === 'DELETE') data = await service.archiveRelationship(objectId, resourceId, req.body);
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