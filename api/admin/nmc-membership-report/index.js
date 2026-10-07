import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { NMC_TENANT, NMC_FEATURE } from '../../_lib/nmcMembershipReport.js';
import { loadNmcReport } from '../../_lib/nmcMembershipReportLoader.js';
import { nmcMembershipWorkbook } from '../../_lib/nmcMembershipWorkbook.js';

export function createNmcReportHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    let ctx;
    try { ctx = await (deps.getTenantContext || getTenantContext)(req); }
    catch { return res.status(401).json({ error: 'Authentication required' }); }
    if (!ctx?.isAuthenticated || !ctx.tenantId) return res.status(401).json({ error: 'Authentication required' });
    if (ctx.tenantMismatch || ctx.tenantId !== NMC_TENANT) return res.status(404).json({ error: 'Report not found' });
    try {
      if (!await (deps.hasAdminAccess || hasAdminAccess)(ctx)
        || (!ctx.tenantUserId && (!ctx.roleId
          || !await (deps.hasFeatureAccess || hasFeatureAccess)(ctx.roleId, 'admin.role-management', ctx.memberExcludedFeatures)
          || !await (deps.hasFeatureAccess || hasFeatureAccess)(ctx.roleId, NMC_FEATURE, ctx.memberExcludedFeatures)))) {
        return res.status(403).json({ error: 'Report administrator permission required' });
      }
      const query = req.query || {};
      if (Object.keys(query).some(key => key !== 'format') || !['json', 'xlsx'].includes(query.format || 'json')) {
        return res.status(400).json({ error: 'Only format=json or format=xlsx is supported; this is a current-date report' });
      }
      const db = deps.db === undefined ? supabase : deps.db;
      if (!db) return res.status(503).json({ error: 'Database not configured' });
      const reportDate = (deps.now ? deps.now() : new Date()).toISOString().slice(0, 10);
      const report = await (deps.loadReport || loadNmcReport)(db, reportDate);
      if (query.format === 'xlsx') {
        const buffer = nmcMembershipWorkbook(report);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="bnms-nmc-membership-${reportDate}.xlsx"`);
        return res.status(200).send(buffer);
      }
      const { rows, ...summary } = report;
      return res.status(200).json(summary);
    } catch {
      // Never log raw rows, database errors or PII on the report's error path.
      return res.status(500).json({ error: 'The complete report could not be loaded. No workbook was generated. Please retry or ask an administrator to check the report data.' });
    }
  };
}
export default createNmcReportHandler();
