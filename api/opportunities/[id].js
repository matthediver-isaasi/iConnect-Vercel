import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { requireSalesContext } from '../_lib/salesAccess.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';
import {
  OpportunityHttpError, assertExpectedVersion, assertPrivateDocumentPath, validatePriority,
  validateStageChange,
} from '../_lib/opportunityRules.js';
import {
  actorFields, appendActivity, enrichOpportunities, loadOpportunityAccess, sendOpportunityError,
  validatePrincipal, validateTenantRecord,
} from '../_lib/opportunityService.js';

const CHILDREN = {
  'contact-roles': { table: 'opportunity_contact_role', mutable: true },
  collaborators: { table: 'opportunity_collaborator', mutable: true },
  notes: { table: 'opportunity_note', mutable: true },
  tasks: { table: 'opportunity_task', mutable: true },
  documents: { table: 'opportunity_document', mutable: true },
  history: { table: 'opportunity_stage_history', mutable: false },
  activity: { table: 'opportunity_activity', mutable: 'append' },
};

async function fullDetail(db, access) {
  const entries = await Promise.all(Object.entries(CHILDREN).map(async ([key, config]) => {
    const { data, error } = await db.from(config.table).select('*')
      .eq('tenant_id', access.opportunity.tenant_id)
      .eq('opportunity_id', access.opportunity.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return [key, data || []];
  }));
  const [opportunity] = await enrichOpportunities(db, access.opportunity.tenant_id, [access.opportunity]);
  const children = Object.fromEntries(entries);
  const contactIds = [...new Set((children['contact-roles'] || []).map((item) => item.member_id))];
  if (contactIds.length) {
    const { data: contacts, error } = await db.from('member')
      .select('id,first_name,last_name,email').eq('tenant_id', access.opportunity.tenant_id).in('id', contactIds);
    if (error) throw error;
    const byId = new Map((contacts || []).map((item) => [item.id, item]));
    children['contact-roles'] = children['contact-roles'].map((role) => {
      const contact = byId.get(role.member_id);
      return { ...role, contact: contact && {
        id: contact.id,
        name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email,
        email: contact.email,
      } };
    });
  }
  return { ...opportunity, permissions: access.permissions, ...children };
}

export function createOpportunityDetailHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  return async function handler(req, res) {
    try {
      if (!['GET', 'PATCH', 'POST', 'DELETE'].includes(req.method)) {
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (!db) throw new OpportunityHttpError(503, 'Database not configured');
      const context = await getContext(req);
      await requireSalesContext(context, req.method === 'GET'
        ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_OPPORTUNITIES, dependencies);
      const id = req.query.id;
      const access = await loadOpportunityAccess(
        db, context, id, dependencies.hasAdminAccess,
      );
      const resource = req.query.resource;

      if (req.method === 'GET') {
        if (!resource) return res.status(200).json(await fullDetail(db, access));
        if (resource === 'document-url') {
          const document = await validateTenantRecord(db, 'opportunity_document',
            context.tenantId, req.query.documentId, 'Document');
          if (document.opportunity_id !== id) throw new OpportunityHttpError(404, 'Document not found');
          assertPrivateDocumentPath(context.tenantId, id, document.bucket, document.storage_path);
          const { data, error } = await db.storage.from(document.bucket)
            .createSignedUrl(document.storage_path, 3600, { download: req.query.download === 'true' });
          if (error) throw error;
          return res.status(200).json({ signedUrl: data.signedUrl, expiresIn: 3600 });
        }
        const config = CHILDREN[resource];
        if (!config) throw new OpportunityHttpError(400, 'Unknown opportunity resource');
        const { data, error } = await db.from(config.table).select('*')
          .eq('tenant_id', context.tenantId).eq('opportunity_id', id)
          .order('created_at', { ascending: false });
        if (error) throw error;
        return res.status(200).json({ items: data || [] });
      }

      if (req.method === 'PATCH' && !resource) {
        if (!access.permissions.canEdit) throw new OpportunityHttpError(403, 'Opportunity edit access required');
        const body = req.body || {};
        assertExpectedVersion(access.opportunity, body.expectedVersion);
        if (body.owner && !access.permissions.canManage) {
          throw new OpportunityHttpError(403, 'Only the owner can change opportunity ownership');
        }
        if (body.action === 'move') {
          const stage = await validateTenantRecord(db, 'opportunity_stage', context.tenantId, body.stageId, 'Stage');
          const loss = validateStageChange(stage, body.lossReasonId);
          if (loss.lossReasonId) {
            const reason = await validateTenantRecord(db, 'opportunity_loss_reason',
              context.tenantId, loss.lossReasonId, 'Loss reason');
            if (!reason.is_active) throw new OpportunityHttpError(400, 'An active loss reason is required');
          }
          const { data, error } = await db.rpc('move_opportunity', {
            p_tenant_id: context.tenantId, p_opportunity_id: id, p_stage_id: stage.id,
            p_loss_reason_id: loss.lossReasonId, p_expected_version: body.expectedVersion,
            p_actor_kind: access.principal.kind, p_actor_id: access.principal.id,
          });
          if (error?.code === '40001') {
            throw new OpportunityHttpError(409, 'Opportunity was updated by another user', 'STALE_UPDATE');
          }
          if (error) throw error;
          return res.status(200).json(data?.[0]);
        }
        const allowed = {
          name: 'name', description: 'description', organizationId: 'organization_id',
          valueMinor: 'value_minor', currency: 'currency', expectedCloseDate: 'expected_close_date',
          source: 'source',
          priority: 'priority',
        };
        if (body.organizationId) await validateTenantRecord(db, 'organization',
          context.tenantId, body.organizationId, 'Organisation');
        if (body.owner) {
          await validatePrincipal(db, context.tenantId, body.owner);
          allowed.owner = null;
        }
        if ('priority' in body) validatePriority(body.priority);
        const patch = {};
        for (const [input, column] of Object.entries(allowed)) {
          if (column && input in body) patch[column] = body[input];
        }
        if (body.owner) Object.assign(patch, { owner_kind: body.owner.kind, owner_id: body.owner.id });
        patch.version = body.expectedVersion + 1;
        patch.updated_at = new Date().toISOString();
        const { data, error } = await db.from('opportunity').update(patch)
          .eq('tenant_id', context.tenantId).eq('id', id).eq('version', body.expectedVersion)
          .select('*').maybeSingle();
        if (error) throw error;
        if (!data) throw new OpportunityHttpError(409, 'Opportunity was updated by another user', 'STALE_UPDATE');
        await appendActivity(db, data, access.principal, 'opportunity.updated', 'Opportunity details updated');
        return res.status(200).json(data);
      }

      const config = CHILDREN[resource];
      if (!config || !config.mutable) throw new OpportunityHttpError(400, 'Resource is immutable or unknown');
      if (config.mutable === 'append' && req.method !== 'POST') {
        throw new OpportunityHttpError(400, 'Activity is append-only');
      }
      if (!access.permissions.canEdit) throw new OpportunityHttpError(403, 'Opportunity edit access required');
      if (resource === 'collaborators' && !access.permissions.canManage) {
        throw new OpportunityHttpError(403, 'Only the owner can manage collaborators');
      }
      const body = req.body || {};
      if (req.method === 'POST') {
        let row = { tenant_id: context.tenantId, opportunity_id: id };
        if (resource === 'collaborators') {
          await validatePrincipal(db, context.tenantId, body.principal);
          row = { ...row, principal_kind: body.principal.kind, principal_id: body.principal.id,
            ...actorFields(access.principal, 'added_by') };
        } else if (resource === 'contact-roles') {
          if (typeof body.role !== 'string' || !body.role.trim()) {
            throw new OpportunityHttpError(400, 'Contact role is required');
          }
          await validateTenantRecord(db, 'member', context.tenantId, body.memberId, 'Contact');
          row = { ...row, member_id: body.memberId, role: body.role.trim(), is_primary: Boolean(body.isPrimary) };
        } else if (resource === 'notes') {
          if (typeof body.body !== 'string' || !body.body.trim()) {
            throw new OpportunityHttpError(400, 'Note body is required');
          }
          row = { ...row, body: body.body, ...actorFields(access.principal, 'author') };
        } else if (resource === 'tasks') {
          if (typeof body.title !== 'string' || !body.title.trim()) {
            throw new OpportunityHttpError(400, 'Task title is required');
          }
          if (body.assignee) await validatePrincipal(db, context.tenantId, body.assignee);
          row = { ...row, title: body.title, description: body.description || null,
            due_at: body.dueAt || null, assignee_kind: body.assignee?.kind || null,
            assignee_id: body.assignee?.id || null, ...actorFields(access.principal, 'created_by') };
        } else if (resource === 'documents') {
          assertPrivateDocumentPath(context.tenantId, id, body.bucket, body.storagePath);
          row = { ...row, name: body.name, bucket: body.bucket, storage_path: body.storagePath,
            mime_type: body.mimeType || null, size_bytes: body.sizeBytes ?? null,
            ...actorFields(access.principal, 'uploaded_by') };
        } else if (resource === 'activity') {
          if (typeof body.summary !== 'string' || !body.summary.trim()) {
            throw new OpportunityHttpError(400, 'Activity summary is required');
          }
          if (body.memberId) await validateTenantRecord(db, 'member', context.tenantId, body.memberId, 'Contact');
          if (body.eventId) await validateTenantRecord(db, 'event', context.tenantId, body.eventId, 'Event');
          row = { ...row, organization_id: access.opportunity.organization_id,
            member_id: body.memberId || null, event_id: body.eventId || null,
            action: 'activity.logged', summary: body.summary,
            metadata: { activityType: body.activityType || 'note', ...(body.metadata || {}) },
            ...actorFields(access.principal, 'actor') };
        }
        const { data, error } = await db.from(config.table).insert(row).select('*').single();
        if (error) throw error;
        if (resource === 'activity') return res.status(201).json(data);
        await appendActivity(db, access.opportunity, access.principal, `${resource}.created`, `${resource} added`,
          {}, resource === 'contact-roles' ? { memberId: body.memberId } : {});
        return res.status(201).json(data);
      }
      if (!req.query.itemId) throw new OpportunityHttpError(400, 'itemId is required');
      if (req.method === 'DELETE') {
        const { data, error } = await db.from(config.table).delete()
          .eq('tenant_id', context.tenantId).eq('opportunity_id', id)
          .eq(resource === 'collaborators' ? 'principal_id' : 'id', req.query.itemId)
          .select('*').maybeSingle();
        if (error) throw error;
        if (!data) throw new OpportunityHttpError(404, 'Item not found');
        await appendActivity(db, access.opportunity, access.principal, `${resource}.removed`, `${resource} removed`);
        return res.status(200).json({ success: true });
      }
      if (!['notes', 'tasks'].includes(resource)) throw new OpportunityHttpError(400, 'Resource cannot be updated');
      const mapping = resource === 'notes'
        ? { body: 'body' }
        : { title: 'title', description: 'description', dueAt: 'due_at', completedAt: 'completed_at' };
      const patch = Object.fromEntries(Object.entries(mapping)
        .filter(([key]) => key in body).map(([key, column]) => [column, body[key]]));
      patch.updated_at = new Date().toISOString();
      const { data, error } = await db.from(config.table).update(patch)
        .eq('tenant_id', context.tenantId).eq('opportunity_id', id).eq('id', req.query.itemId)
        .select('*').maybeSingle();
      if (error) throw error;
      if (!data) throw new OpportunityHttpError(404, 'Item not found');
      await appendActivity(db, access.opportunity, access.principal, `${resource}.updated`, `${resource} updated`);
      return res.status(200).json(data);
    } catch (error) {
      return sendOpportunityError(res, error, 'Failed to handle opportunity');
    }
  };
}

export default createOpportunityDetailHandler();