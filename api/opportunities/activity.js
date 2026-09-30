import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { requireSalesContext } from '../_lib/salesAccess.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';
import {
  OpportunityHttpError, parsePagination, principalFromContext,
} from '../_lib/opportunityRules.js';
import { sendOpportunityError } from '../_lib/opportunityService.js';

export function intersectOpportunityIds(...groups) {
  const nonNullGroups = groups.filter(Boolean);
  if (!nonNullGroups.length) return null;
  return [...new Set(nonNullGroups[0])].filter((id) => nonNullGroups.every((group) => group.includes(id)));
}

// CRM integration feed used by Organisation and contact detail surfaces.
export function createOpportunityActivityHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const adminAccess = dependencies.hasAdminAccess || hasAdminAccess;
  return async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (!db) throw new OpportunityHttpError(503, 'Database not configured');
    const context = await getContext(req);
    await requireSalesContext(context, SALES_CAPABILITIES.VIEW, dependencies);
    if (!req.query.organizationId && !req.query.memberId) {
      throw new OpportunityHttpError(400, 'organizationId or memberId is required');
    }
    const pagination = parsePagination(req.query);
    const principal = principalFromContext(context);
    let visibleIds = null;
    let contactOpportunityIds = null;
    if (req.query.memberId) {
      // Contact CRM activity is activity on opportunities where this person is
      // a contact, not only rows whose optional activity.member_id happens to match.
      const { data: roles, error } = await db.from('opportunity_contact_role')
        .select('opportunity_id').eq('tenant_id', context.tenantId).eq('member_id', req.query.memberId);
      if (error) throw error;
      contactOpportunityIds = [...new Set((roles || []).map((item) => item.opportunity_id))];
      if (!contactOpportunityIds.length) {
        return res.status(200).json({ items: [], page: pagination.page, pageSize: pagination.pageSize, total: 0 });
      }
    }
    if (!(await adminAccess(context))) {
      const [{ data: owned, error: ownerError }, { data: collaborated, error: collabError }] = await Promise.all([
        db.from('opportunity').select('id').eq('tenant_id', context.tenantId)
          .eq('owner_kind', principal.kind).eq('owner_id', principal.id),
        db.from('opportunity_collaborator').select('opportunity_id')
          .eq('tenant_id', context.tenantId).eq('principal_kind', principal.kind)
          .eq('principal_id', principal.id),
      ]);
      if (ownerError) throw ownerError;
      if (collabError) throw collabError;
      visibleIds = [...new Set([
        ...(owned || []).map((item) => item.id),
        ...(collaborated || []).map((item) => item.opportunity_id),
      ])];
      visibleIds = intersectOpportunityIds(visibleIds, contactOpportunityIds);
      if (!visibleIds.length) {
        return res.status(200).json({ items: [], page: pagination.page, pageSize: pagination.pageSize, total: 0 });
      }
    }
    const opportunityIds = intersectOpportunityIds(visibleIds, contactOpportunityIds);
    let query = db.from('opportunity_activity').select('*', { count: 'exact' })
      .eq('tenant_id', context.tenantId);
    if (req.query.organizationId) query = query.eq('organization_id', req.query.organizationId);
    if (opportunityIds) query = query.in('opportunity_id', opportunityIds);
    const { data, error, count } = await query.order('created_at', { ascending: false })
      .range(pagination.from, pagination.to);
    if (error) throw error;
    return res.status(200).json({
      items: data || [], page: pagination.page, pageSize: pagination.pageSize, total: count || 0,
    });
  } catch (error) {
    return sendOpportunityError(res, error, 'Failed to load CRM opportunity activity');
  }
  };
}

export default createOpportunityActivityHandler();