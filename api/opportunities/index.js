import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { requireSalesContext } from '../_lib/salesAccess.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';
import {
  OpportunityHttpError, principalFromContext, parsePagination, validatePriority, validateStageChange,
} from '../_lib/opportunityRules.js';
import {
  actorFields, enrichOpportunities, sendOpportunityError, validatePrincipal, validateTenantRecord,
} from '../_lib/opportunityService.js';

export function createOpportunitiesHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  return async function handler(req, res) {
    try {
      if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (!db) throw new OpportunityHttpError(503, 'Database not configured');
      const context = await getContext(req);
      await requireSalesContext(context, req.method === 'GET'
        ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_OPPORTUNITIES, dependencies);
      const principal = principalFromContext(context);

      if (req.method === 'GET') {
        const pagination = parsePagination(req.query);
        const admin = await hasAdminAccess(context);
        let query = db.from('opportunity').select('*', { count: 'exact' })
          .eq('tenant_id', context.tenantId);

        const mine = req.query.mine === 'true';
        if (!admin || mine) {
          const { data: links, error } = await db.from('opportunity_collaborator')
            .select('opportunity_id').eq('tenant_id', context.tenantId)
            .eq('principal_kind', principal.kind).eq('principal_id', principal.id);
          if (error) throw error;
          const ids = (links || []).map((item) => item.opportunity_id);
          const clauses = [`and(owner_kind.eq.${principal.kind},owner_id.eq.${principal.id})`];
          if (ids.length) clauses.push(`id.in.(${ids.join(',')})`);
          query = query.or(clauses.join(','));
        }
        if (req.query.stageId) query = query.eq('stage_id', req.query.stageId);
        if (req.query.organizationId) query = query.eq('organization_id', req.query.organizationId);
        const contactMemberId = req.query.contactMemberId || req.query.memberId;
        if (contactMemberId) {
          const { data: roles, error } = await db.from('opportunity_contact_role')
            .select('opportunity_id').eq('tenant_id', context.tenantId)
            .eq('member_id', contactMemberId);
          if (error) throw error;
          const contactIds = (roles || []).map((item) => item.opportunity_id);
          if (!contactIds.length) {
            return res.status(200).json({
              items: [], page: pagination.page, pageSize: pagination.pageSize, total: 0,
            });
          }
          query = query.in('id', contactIds);
        }
        if (req.query.ownerId) query = query.eq('owner_id', req.query.ownerId);
        if (req.query.search) {
          const search = String(req.query.search).replace(/[%_,()]/g, '');
          if (search) query = query.ilike('name', `%${search}%`);
        }
        const { data, error, count } = await query.order('updated_at', { ascending: false })
          .range(pagination.from, pagination.to);
        if (error) throw error;
        return res.status(200).json({
          items: await enrichOpportunities(db, context.tenantId, data || []),
          page: pagination.page, pageSize: pagination.pageSize, total: count || 0,
        });
      }

      const body = req.body || {};
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new OpportunityHttpError(400, 'name is required');
      }
      await validateTenantRecord(db, 'organization', context.tenantId, body.organizationId, 'Organisation');
      if (body.contactId) {
        const contact = await validateTenantRecord(db, 'member', context.tenantId, body.contactId, 'Contact');
        if (contact.organization_id !== body.organizationId) {
          throw new OpportunityHttpError(400, 'Contact must belong to the selected organisation');
        }
      }
      const stage = await validateTenantRecord(db, 'opportunity_stage', context.tenantId, body.stageId, 'Stage');
      const loss = validateStageChange(stage, body.lossReasonId);
      if (loss.lossReasonId) {
        const reason = await validateTenantRecord(db, 'opportunity_loss_reason', context.tenantId,
          loss.lossReasonId, 'Loss reason');
        if (!reason.is_active) throw new OpportunityHttpError(400, 'An active loss reason is required');
      }
      const owner = body.owner || principal;
      await validatePrincipal(db, context.tenantId, owner);
      const priority = body.priority === undefined ? 'medium' : validatePriority(body.priority);
      const row = {
        tenant_id: context.tenantId,
        organization_id: body.organizationId,
        stage_id: body.stageId,
        loss_reason_id: loss.lossReasonId,
        primary_contact_id: body.contactId || null,
        owner_kind: owner.kind,
        owner_id: owner.id,
        name: body.name.trim(),
        description: body.description || null,
        value_minor: body.valueMinor ?? null,
        currency: body.currency || 'GBP',
        expected_close_date: body.expectedCloseDate || null,
        source: body.source || null,
        priority,
        ...actorFields(principal, 'created_by'),
      };
      const { data, error } = await db.from('opportunity').insert(row).select('*').single();
      if (error) throw error;
      return res.status(201).json(data);
    } catch (error) {
      return sendOpportunityError(res, error, 'Failed to handle opportunities');
    }
  };
}

export default createOpportunitiesHandler();