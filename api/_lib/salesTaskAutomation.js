import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';
import { requireSalesContext } from './salesAccess.js';
import { projectFeature, projectUuid } from './salesProjects.js';
import { OpportunityHttpError } from './opportunityRules.js';

const fail = (status, message) => { throw new OpportunityHttpError(status, message); };
async function value(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// Called only after the shared endpoint has resolved the tenant, Sales permission,
// current principal and opportunity-level visibility. Never take these from body.
export async function salesTaskAutomationRequest(db, context, method, body, options) {
  const { opportunityId, access, actor, canViewProjects, dependencies } = options;
  let canManage = false;
  try {
    await requireSalesContext(context, SALES_CAPABILITIES.MANAGE_OPPORTUNITIES, dependencies);
    canManage = access.permissions.canEdit;
  } catch (error) { if (error.status !== 403) throw error; }
  const link = await value(db.from('sales_opportunity_project').select('board_id')
    .eq('tenant_id', context.tenantId).eq('opportunity_id', opportunityId).maybeSingle());
  let canConfigureBoard = false;
  if (link && canManage && canViewProjects && actor.p_identity
    && await projectFeature(context, 'projects.board-view.create-cards', dependencies)) {
    const [board, membership] = await Promise.all([
      value(db.from('project_board').select('id,is_archived').eq('tenant_id', context.tenantId)
        .eq('id', link.board_id).maybeSingle()),
      value(db.from('project_board_member').select('role').eq('board_id', link.board_id)
        .eq('identity_id', actor.p_identity).maybeSingle()),
    ]);
    canConfigureBoard = Boolean(board && !board.is_archived && ['owner', 'admin'].includes(membership?.role));
  }
  if (method === 'POST') {
    if (!canManage) fail(403, 'Opportunity edit access required');
    if (body.action === 'automation-configure') {
      // Clearing consent is allowed to a Sales editor; granting it also requires
      // board management + create-card permission. RPC repeats identity/list checks.
      if (body.listId !== null) {
        projectUuid(body.listId, 'Destination list');
        if (!canConfigureBoard) fail(403, 'Board owner or administrator with Create Cards permission required');
      }
      await value(db.rpc('configure_sales_task_automation', {
        p_tenant: context.tenantId, p_opportunity: opportunityId, p_list: body.listId,
        p_identity: actor.p_identity, p_kind: actor.p_kind, p_actor: actor.p_actor,
      }));
      return { success: true };
    }
    return value(db.rpc('process_sales_acceptance_tasks', {
      p_tenant: context.tenantId, p_opportunity: opportunityId,
    }));
  }
  const [configuration, requestsResult, lists] = await Promise.all([
    value(db.from('sales_task_automation_config').select('board_id,list_id')
      .eq('tenant_id', context.tenantId).eq('opportunity_id', opportunityId).maybeSingle()),
    db.from('sales_acceptance_task_request')
      .select('id,title,quantity,task_mode,status,last_error,task_id,board_id,created_at', { count: 'exact' })
      .eq('tenant_id', context.tenantId).eq('opportunity_id', opportunityId)
      .order('status', { ascending: false }).order('created_at', { ascending: false }).order('id')
      .limit(100),
    canConfigureBoard ? value(db.from('project_list').select('id,name')
      .eq('board_id', link.board_id).or('is_archived.is.null,is_archived.eq.false')
      .order('position').order('id')) : [],
  ]);
  if (requestsResult.error) throw requestsResult.error;
  return {
    taskMode: access.opportunity.task_mode || 'standard', boardId: link?.board_id || null,
    canManage, canConfigureBoard, configuration, lists,
    requests: requestsResult.data || [], total: requestsResult.count || 0,
  };
}
