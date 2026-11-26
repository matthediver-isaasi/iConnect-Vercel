import { hasAdminAccess, hasFeatureAccess } from './tenantContext.js';
import { isResourceExcluded } from './roleVisibility.js';
import { requireSalesContext } from './salesAccess.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';
import { OpportunityHttpError, principalFromContext, parsePagination } from './opportunityRules.js';
import { loadOpportunityAccess, enrichOpportunities } from './opportunityService.js';
import { salesTaskAutomationRequest } from './salesTaskAutomation.js';

const fail = (status, message) => { throw new OpportunityHttpError(status, message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function projectUuid(value, label) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, `${label} must be a valid ID`);
  return value;
}
async function result(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
export async function projectFeature(context, feature, dependencies = {}) {
  if (context.tenantUserId) return true;
  return Boolean(context.roleId && !isResourceExcluded(context.memberExcludedFeatures || [], feature)
    && await (dependencies.hasFeatureAccess || hasFeatureAccess)(context.roleId, feature));
}
export async function projectActor(db, context, dependencies = {}) {
  const principal = principalFromContext(context);
  // Resolve the active principal, not the original administrator's session
  // identity when masquerading. Do not grant board access from Sales admin.
  const row = await result(db.from(principal.kind === 'member' ? 'member' : 'tenant_user')
    .select('identity_id').eq('tenant_id', context.tenantId).eq('id', principal.id).maybeSingle());
  return {
    p_tenant: context.tenantId, p_kind: principal.kind, p_actor: principal.id,
    p_admin: Boolean(await (dependencies.hasAdminAccess || hasAdminAccess)(context)),
    p_identity: uuid.test(row?.identity_id || '') ? row.identity_id : null,
  };
}
export function projectTaskOptions(query) {
  const pagination = parsePagination(query);
  const options = { page: pagination.page, pageSize: pagination.pageSize };
  for (const [key, values, fallback] of [
    ['source', ['standard', 'project'], 'project'], ['scope', ['my', 'all'], 'my'],
    ['status', ['all', 'completed', 'outstanding'], 'all'],
    ['sort', ['due', 'priority', 'opportunity'], 'due'],
  ]) {
    options[key] = query[key] || fallback;
    if (!values.includes(options[key])) fail(400, `Invalid ${key}`);
  }
  if (query.opportunityId) options.opportunityId = projectUuid(query.opportunityId, 'Opportunity');
  if (query.listName) {
    if (typeof query.listName !== 'string' || query.listName.length > 240) fail(400, 'Invalid task status');
    options.listName = query.listName;
  }
  if (query.overdue !== undefined && !['true', 'false'].includes(query.overdue)) fail(400, 'Invalid overdue filter');
  options.overdue = query.overdue === 'true';
  for (const key of ['dueFrom', 'dueTo']) {
    if (!query[key]) continue;
    const value = query[key];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(400, 'Invalid due date');
    options[key] = value;
  }
  if (options.dueFrom && options.dueTo && options.dueFrom > options.dueTo) fail(400, 'Due date range is reversed');
  return options;
}
export async function boardOpportunity(db, context, boardId, dependencies = {}) {
  projectUuid(boardId, 'Board');
  // An ordinary project board must still render for a non-Sales user.
  try { await requireSalesContext(context, SALES_CAPABILITIES.VIEW, dependencies); }
  catch (error) { if (error.status === 403) return { opportunity: null }; throw error; }
  if (!await projectFeature(context, 'projects.board-view', dependencies)) return { opportunity: null };
  const actor = await projectActor(db, context, dependencies);
  if (!actor.p_identity) return { opportunity: null };
  const board = await result(db.from('project_board').select('id').eq('tenant_id', context.tenantId)
    .eq('id', boardId).maybeSingle());
  if (!board) return { opportunity: null };
  const member = await result(db.from('project_board_member').select('role')
    .eq('board_id', boardId).eq('identity_id', actor.p_identity).maybeSingle());
  if (!member) return { opportunity: null };
  const link = await result(db.from('sales_opportunity_project').select('opportunity_id')
    .eq('tenant_id', context.tenantId).eq('board_id', boardId).maybeSingle());
  if (!link) return { opportunity: null };
  let access;
  try { access = await loadOpportunityAccess(db, context, link.opportunity_id, dependencies.hasAdminAccess); }
  catch (error) { if ([403, 404].includes(error.status)) return { opportunity: null }; throw error; }
  let canEdit = false;
  try {
    await requireSalesContext(context, SALES_CAPABILITIES.MANAGE_OPPORTUNITIES, dependencies);
    canEdit = access.permissions.canEdit;
  } catch (error) { if (error.status !== 403) throw error; }
  const [enriched] = await enrichOpportunities(db, context.tenantId, [access.opportunity]);
  const [stages, lossReasons] = await Promise.all([
    result(db.from('opportunity_stage').select('id,name,is_active,is_won,is_lost')
      .eq('tenant_id', context.tenantId).eq('is_active', true).order('position')),
    result(db.from('opportunity_loss_reason').select('id,name,is_active')
      .eq('tenant_id', context.tenantId).eq('is_active', true).order('position')),
  ]);
  // Explicit projection: never leak accounting/private child collections.
  const keys = ['id', 'name', 'organization', 'value_minor', 'currency', 'owner',
    'stage', 'stage_id', 'expected_close_date', 'version', 'task_mode'];
  return { opportunity: { ...Object.fromEntries(keys.map(key => [key, enriched[key]])),
    permissions: { canEdit } }, stages, lossReasons };
}

export const TASK_SETTINGS_LOCKED = 'Task settings are fixed when the opportunity is created';
// A legacy opportunity is in project mode, has no linked board, and has never
// had one attached. The permanent attachment record (not the link, which a
// board deletion cascades away) decides this, so the exception is used once.
async function everAttached(db, context, opportunityId) {
  const { data, error } = await db.from('sales_opportunity_board_attachment').select('opportunity_id')
    .eq('tenant_id', context.tenantId).eq('opportunity_id', opportunityId).maybeSingle();
  if (error) {
    // Fail closed until the attachment record exists in the database.
    if (['42P01', 'PGRST205'].includes(error.code)) return null;
    throw error;
  }
  return Boolean(data);
}
async function legacyUnlinked(db, context, opportunity, link) {
  if (opportunity.task_mode !== 'project' || link) return false;
  return await everAttached(db, context, opportunity.id) === false;
}
async function listEligibleBoards(db, context, actor, query) {
  const { page, pageSize } = parsePagination(query);
  if (query.search && (typeof query.search !== 'string' || query.search.length > 200)) fail(400, 'Search is too long');
  return result(db.rpc('list_sales_project_boards', { p_tenant: context.tenantId,
    p_identity: actor.p_identity, p_search: query.search || '', p_page: page, p_size: pageSize }));
}

export const OPPORTUNITY_TASK_CHOICES = ['standard', 'create', 'link'];
// Validates the New opportunity task choice and the caller's Projects access.
// Returns the RPC arguments for the atomic create, or null for standard tasks.
export async function resolveOpportunityTaskChoice(db, context, body, dependencies = {}) {
  const choice = body.taskChoice === undefined || body.taskChoice === null ? 'standard' : body.taskChoice;
  if (!OPPORTUNITY_TASK_CHOICES.includes(choice)) fail(400, 'Invalid task choice');
  if (choice === 'standard') return null;
  const boardId = choice === 'link' ? projectUuid(body.boardId, 'Board') : null;
  const actor = await projectActor(db, context, dependencies);
  if (!actor.p_identity || !await projectFeature(context, 'projects.board-view', dependencies)) {
    fail(403, 'Project board access is required');
  }
  if (choice === 'create' && !await projectFeature(context, 'projects.boards.create', dependencies)) {
    fail(403, 'Create Boards permission is required');
  }
  return { p_tenant: actor.p_tenant, p_kind: actor.p_kind, p_actor: actor.p_actor,
    p_identity: actor.p_identity, p_action: choice, p_board: boardId };
}

export async function salesProjectRequest(db, context, method, query, body, dependencies = {}) {
  if (method === 'GET' && query.boardId) return boardOpportunity(db, context, query.boardId, dependencies);
  await requireSalesContext(context, method === 'GET' ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_OPPORTUNITIES, dependencies);
  const actor = await projectActor(db, context, dependencies);
  const canViewProjects = await projectFeature(context, 'projects.board-view', dependencies);
  if (method === 'GET' && query.view === 'tasks') {
    const options = projectTaskOptions(query);
    if (options.source === 'project' && (!canViewProjects || !actor.p_identity)) fail(403, 'Project board access is required');
    return result(db.rpc('list_sales_project_tasks', { ...actor, p_options: options }));
  }
  if (method === 'GET' && query.view === 'create-options') {
    // Used by the New opportunity dialog before an opportunity exists.
    await requireSalesContext(context, SALES_CAPABILITIES.MANAGE_OPPORTUNITIES, dependencies);
    const canLinkBoard = Boolean(canViewProjects && actor.p_identity);
    return { canLinkBoard, canCreateBoard: canLinkBoard
      && await projectFeature(context, 'projects.boards.create', dependencies) };
  }
  if (method === 'GET' && query.view === 'boards' && !query.opportunityId) {
    // Eligible-board picker for a new opportunity; same eligibility rules.
    await requireSalesContext(context, SALES_CAPABILITIES.MANAGE_OPPORTUNITIES, dependencies);
    if (!canViewProjects || !actor.p_identity) fail(403, 'Project board access is required');
    return listEligibleBoards(db, context, actor, query);
  }
  const opportunityId = projectUuid(method === 'GET' ? query.opportunityId : body.opportunityId, 'Opportunity');
  const access = await loadOpportunityAccess(db, context, opportunityId, dependencies.hasAdminAccess);
  if ((method === 'GET' && query.view === 'automation')
    || (method === 'POST' && ['automation-configure', 'automation-retry'].includes(body.action))) {
    return salesTaskAutomationRequest(db, context, method, body, {
      opportunityId, access, actor, canViewProjects, dependencies,
    });
  }
  if (method === 'GET' && query.view === 'boards') {
    await requireSalesContext(context, SALES_CAPABILITIES.MANAGE_OPPORTUNITIES, dependencies);
    if (!access.permissions.canEdit || !canViewProjects || !actor.p_identity) fail(403, 'Opportunity and board management access required');
    return listEligibleBoards(db, context, actor, query);
  }
  if (method === 'POST') {
    if (!access.permissions.canEdit) fail(403, 'Opportunity edit access required');
    if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) fail(400, 'expectedVersion is required');
    if (!['mode', 'create', 'link', 'unlink'].includes(body.action)) fail(400, 'Invalid project action');
    if (body.action === 'mode' && !['standard', 'project'].includes(body.taskMode)) fail(400, 'Invalid task mode');
    if (body.action === 'link') projectUuid(body.boardId, 'Board');
    // Task settings are fixed at creation. Only a legacy project-mode
    // opportunity with no linked board may create or link a board once.
    const currentLink = await result(db.from('sales_opportunity_project').select('board_id')
      .eq('tenant_id', context.tenantId).eq('opportunity_id', opportunityId).maybeSingle());
    if (!['create', 'link'].includes(body.action) || !await legacyUnlinked(db, context, access.opportunity, currentLink)) {
      fail(409, TASK_SETTINGS_LOCKED);
    }
    if (['create', 'link'].includes(body.action) && (!canViewProjects || !actor.p_identity)) fail(403, 'Project board access is required');
    if (body.action === 'create' && !await projectFeature(context, 'projects.boards.create', dependencies)) fail(403, 'Create Boards permission is required');
    return result(db.rpc('change_sales_project', {
      ...actor, p_opportunity: opportunityId, p_expected_version: body.expectedVersion,
      p_action: body.action, p_mode: body.action === 'mode' ? body.taskMode : null,
      p_board: body.action === 'link' ? body.boardId : null,
    }));
  }
  const link = await result(db.from('sales_opportunity_project').select('board_id')
    .eq('tenant_id', context.tenantId).eq('opportunity_id', opportunityId).maybeSingle());
  let board = null;
  if (link && canViewProjects && actor.p_identity) {
    const member = await result(db.from('project_board_member').select('role')
      .eq('board_id', link.board_id).eq('identity_id', actor.p_identity).maybeSingle());
    if (member) {
      const record = await result(db.from('project_board').select('id,name,is_archived')
        .eq('tenant_id', context.tenantId).eq('id', link.board_id).maybeSingle());
      if (record) board = { ...record, user_role: member.role };
    }
  }
  let canManage = false;
  try {
    await requireSalesContext(context, SALES_CAPABILITIES.MANAGE_OPPORTUNITIES, dependencies);
    canManage = access.permissions.canEdit;
  } catch (error) { if (error.status !== 403) throw error; }
  const summary = board && access.opportunity.task_mode === 'project' && !board.is_archived
    ? (await result(db.rpc('list_sales_project_tasks', { ...actor, p_options: {
      source: 'project', scope: 'all', opportunityId, page: 1, pageSize: 1,
    } }))).summary : { total: 0, outstanding: 0, completed: 0, overdue: 0 };
  return {
    taskMode: access.opportunity.task_mode || 'standard', expectedVersion: access.opportunity.version,
    // Legacy project-mode opportunity with no board: may create/link once.
    needsBoard: await legacyUnlinked(db, context, access.opportunity, link),
    board, boardUnavailable: Boolean(link && !board),
    permissions: { canManage, canCreateBoard: canManage && canViewProjects && Boolean(actor.p_identity)
      && await projectFeature(context, 'projects.boards.create', dependencies),
    canViewBoard: Boolean(board && canViewProjects) }, summary,
  };
}
