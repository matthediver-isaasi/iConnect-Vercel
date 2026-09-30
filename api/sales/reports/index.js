import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { requireSalesContext, SalesHttpError } from '../../_lib/salesAccess.js';
import { SALES_CAPABILITIES } from '../../../shared/salesContracts.js';
import {
  buildEventCommercial, buildOrganisationCommercial, buildSalesDashboard, buildSalesReport,
  loadSalesReportData, paginateSalesReport, parseSalesReportQuery, reportColumns, reportTotals,
  salesReportCsv, salesReportDefinitions, salesReportFacets, salesReportMetricMetadata,
} from '../../_lib/salesReports.js';

export function createSalesReportsHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const load = dependencies.loadSalesReportData || loadSalesReportData;
  const build = dependencies.buildSalesReport || buildSalesReport;
  return async function handler(req, res) {
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (!db && !dependencies.loadSalesReportData) throw new SalesHttpError(503, 'Database not configured');
      const filters = parseSalesReportQuery(req.query || {});
      const context = await getContext(req);
      const capability = filters.mode === 'dashboard' ? 'sales.dashboard' : SALES_CAPABILITIES.VIEW_REPORTS;
      const actor = await requireSalesContext(context, capability, dependencies);
      const data = await load(db, actor.tenantId, filters);
      const result = build(data, filters);
      const base = {
        definitions: salesReportDefinitions,
        metadata: {
          ...salesReportMetricMetadata,
          filters: { from: filters.from, to: filters.to },
          stableOrdering: 'id ascending',
        },
      };
      if (filters.mode === 'dashboard') {
        return res.status(200).json({ ...base, ...buildSalesDashboard(data, result) });
      }
      if (filters.mode === 'organisation' || filters.mode === 'organization') {
        if (filters.organisation.length !== 1) throw new SalesHttpError(400, 'organizationId is required');
        return res.status(200).json({
          ...base, ...buildOrganisationCommercial(data, result, filters.organisation[0]),
        });
      }
      if (filters.mode === 'event') {
        if (filters.event.length !== 1) throw new SalesHttpError(400, 'eventId is required');
        return res.status(200).json({ ...base, ...buildEventCommercial(data, result, filters.event[0]) });
      }
      const reportRows = filters.report === 'events'
        ? result.events.map((event) => {
          const commercial = buildEventCommercial(data, result, event.id);
          return {
            id: event.id,
            name: commercial.name || event.name,
            kind: commercial.kind,
            saleCount: event.saleCount,
            values: event.values,
            allocated: commercial.summary.allocated,
            named: commercial.summary.named,
            reserved: commercial.summary.reserved,
            unused: commercial.summary.unused,
            confirmedBookings: commercial.summary.confirmedBookings,
            trueAvailability: commercial.summary.trueAvailability,
          };
        })
        : result.details;
      if (filters.mode === 'export') {
        const csv = salesReportCsv(reportRows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="sales-${filters.report}.csv"`);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).send(csv);
      }
      const pagination = paginateSalesReport(reportRows, filters);
      return res.status(200).json({
        ...base, report: filters.requestedReport, rows: pagination.items, items: pagination.items,
        columns: reportColumns(reportRows), pagination: {
          page: pagination.page, pageSize: pagination.pageSize, total: pagination.total,
          pages: Math.max(1, Math.ceil(pagination.total / pagination.pageSize)),
        },
        total: pagination.total, totals: reportTotals(reportRows), facets: salesReportFacets(data),
      });
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({
        error: status === 500 ? 'Failed to generate Sales report' : error.message,
        ...(error?.code ? { code: error.code } : {}),
      });
    }
  };
}

export default createSalesReportsHandler();