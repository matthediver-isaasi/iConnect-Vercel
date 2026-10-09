import { supabase } from './database.js';
import { getTenantContext } from './tenantContext.js';
import { projectActor, projectFeature } from './salesProjects.js';

// Leave ordinary Projects behavior unchanged. Once a board participates in
// Sales, enforce the same Projects capabilities used by the shared editor on
// direct API calls too. Board membership never grants Sales permission.
export async function guardSalesLinkedProject(req, res, boardId, feature = 'projects.board-view', dependencies = {}) {
  const db = dependencies.db || supabase;
  const { data: link, error } = await db.from('sales_opportunity_project')
    .select('tenant_id').eq('board_id', boardId).maybeSingle();
  if (error) throw error;
  if (!link) return true;
  const context = await (dependencies.getTenantContext || getTenantContext)(req);
  const deny = (status, message) => { res.status(status).json({ error: message }); return false; };
  if (!context.isAuthenticated) return deny(401, 'Authentication required');
  if (context.tenantMismatch || context.tenantId !== link.tenant_id) return deny(403, 'Board not available in this tenant');
  if (!await projectFeature(context, 'projects.board-view', dependencies)
    || !await projectFeature(context, feature, dependencies)) return deny(403, 'Project permission required');
  const actor = await projectActor(db, context, dependencies);
  if (!actor.p_identity) return deny(403, 'Project identity required');
  const [{ data: board, error: boardError }, { data: member, error: memberError }] = await Promise.all([
    db.from('project_board').select('is_archived').eq('tenant_id', context.tenantId).eq('id', boardId).maybeSingle(),
    db.from('project_board_member').select('role').eq('board_id', boardId).eq('identity_id', actor.p_identity).maybeSingle(),
  ]);
  if (boardError || memberError) throw boardError || memberError;
  if (!board || !member) return deny(403, 'Board membership required');
  if (req.method !== 'GET' && ((board.is_archived && !dependencies.allowArchived) || member.role === 'viewer')) return deny(403, 'This board is read-only');
  return true;
}
