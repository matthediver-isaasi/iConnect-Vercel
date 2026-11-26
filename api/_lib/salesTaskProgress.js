import { SalesHttpError, requireSalesContext } from './salesAccess.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';
import { projectActor, projectFeature } from './salesProjects.js';

// Independent from financial and expected-close filters, and never reads raw
// task collections through PostgREST. The database returns cohort-wide totals.
export async function loadSalesTaskProgress(db, context, filters, dependencies = {}) {
  await requireSalesContext(context, SALES_CAPABILITIES.VIEW, dependencies);
  const actor = await projectActor(db, context, dependencies);
  const canViewProjects = await projectFeature(context, 'projects.board-view', dependencies);
  const { data, error } = await db.rpc('sales_opportunity_task_progress', {
    ...actor, p_projects: canViewProjects,
    p_page: filters.taskProgressPage, p_size: filters.taskProgressPageSize,
  });
  if (error) {
    if (['PGRST202', '42883', '42703'].includes(error.code)) {
      throw new SalesHttpError(503, 'Opportunity task progress requires the database update. Please try again later.');
    }
    throw new SalesHttpError(503, 'Opportunity task progress is unavailable. Please retry.');
  }
  if (!data) throw new SalesHttpError(503, 'Opportunity task progress is unavailable. Please retry.');
  return data;
}
