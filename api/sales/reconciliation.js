import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { requireSalesContext, SalesHttpError } from '../_lib/salesAccess.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';
import {
  loadSalesReconciliationData, parseSalesReconciliationQuery, scanSalesReconciliationData,
  salesReconciliationMetadata,
} from '../_lib/salesReconciliation.js';

export function createSalesReconciliationHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const load = dependencies.loadSalesReconciliationData || loadSalesReconciliationData;
  const scan = dependencies.scanSalesReconciliationData || scanSalesReconciliationData;
  return async function handler(req, res) {
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (!db && !dependencies.loadSalesReconciliationData) throw new SalesHttpError(503, 'Database not configured');
      const options = parseSalesReconciliationQuery(req.query || {});
      const actor = await requireSalesContext(await getContext(req), SALES_CAPABILITIES.VIEW_REPORTS, dependencies);
      const findings = scan(await load(db, actor.tenantId), { now: dependencies.now || Date.now() });
      const items = findings.slice(0, options.limit);
      return res.status(200).json({
        items, findings: items, total: findings.length, truncated: findings.length > items.length,
        metadata: salesReconciliationMetadata,
      });
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({
        error: status === 500 ? 'Failed to scan Sales reconciliation' : error.message,
        ...(error?.code ? { code: error.code } : {}),
      });
    }
  };
}

export default createSalesReconciliationHandler();