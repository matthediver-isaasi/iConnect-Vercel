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
import { resolveOpportunityTaskChoice } from '../_lib/salesProjects.js';

// Clear, non-internal messages for the atomic create-with-board RPC.
function projectCreateError(error) {
  if (error instanceof OpportunityHttpError) return error;
  const messages = {
    '23505': [409, 'That project board is already linked to another opportunity. Choose another board and try again.'],
    '42501': [403, 'That project board is not available to link. Only live boards you own or administer can be linked.'],
    '22023': [400, 'Invalid task choice'],
  };
  const known = messages[error?.code];
  if (known) return new OpportunityHttpError(known[0], known[1]);
  if (error?.code === '23514') return new OpportunityHttpError(409, error.message);
  // Schema not yet installed: fail clearly rather than with a generic error.
  if (['PGRST202', '42883'].includes(error?.code)) {
    return new OpportunityHttpError(503, 'Project boards cannot be set up during creation yet. Choose standard tasks or try again later.');
  }
  return error;
}

export function createOpportunitiesHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const checkAdminAccess = dependencies.hasAdminAccess || hasAdminAccess;
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
        const admin = await checkAdminAccess(context);
        const activeOnly = req.query.active === 'true';
        let query = db.from('opportunity').select(
          activeOnly ? '*,active_stage:opportunity_stage!inner(id)' : '*', { count: 'exact' })
          .eq('tenant_id', context.tenantId);
        query = req.query.archived === 'true'
          ? query.not('archived_at', 'is', null) : query.is('archived_at', null);
        // Apply before counting/paging, not to an already paginated client list.
        if (activeOnly) query = query.eq('active_stage.is_active', true)
          .eq('active_stage.is_won', false).eq('active_stage.is_lost', false);

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
        const { data, error, count } = await query.order('updated_at', { ascending: false }).order('id', { ascending: true })
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
      const projectChoice = await resolveOpportunityTaskChoice(db, context, body, dependencies);
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
      if (projectChoice) {
        // Opportunity, board and link are created in one transaction: any
        // board failure leaves no opportunity behind.
        const { tenant_id: _tenant, created_by_kind: _kind, created_by_id: _id, ...details } = row;
        const { data, error } = await db.rpc('create_sales_opportunity_with_project', {
          ...projectChoice, p_opportunity: details,
        });
        if (error) throw projectCreateError(error);
        return res.status(201).json(data);
      }
      const { data, error } = await db.from('opportunity').insert(row).select('*').single();
      if (error) throw error;
      return res.status(201).json(data);
    } catch (error) {
      return sendOpportunityError(res, error, 'Failed to handle opportunities');
    }
  };
}

export default createOpportunitiesHandler();