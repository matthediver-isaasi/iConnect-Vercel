import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import {
  SALES_CAPABILITIES, validateSalesAccountingConfigurationPatch, validateSalesInvoiceCommand,
} from '../../../shared/salesContracts.js';
import { requireSalesContext, SalesHttpError } from '../../_lib/salesAccess.js';
import {
  createSalesInvoice, getSalesAccountingConfiguration, getSalesInvoices,
  refreshSalesInvoiceStatus, saveSalesAccountingConfiguration,
} from '../../_lib/salesAccounting.js';
import { getSalesSchedules, dispatchSalesSchedule, deliverSalesSchedule } from '../../_lib/salesInvoiceSchedule.js';

export const salesAccountingPathParts = (req) => {
  // Serverless requests may omit catch-all query params. The URL also keeps
  // caller-supplied ?path= values from changing the requested operation.
  if (req.url) {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const prefix = '/api/sales/accounting';
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        return pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
      }
    } catch {
      throw new SalesHttpError(400, 'Invalid Sales accounting path');
    }
  }
  const path = req.query?.path;
  return Array.isArray(path) ? path : String(path || '').split('/').filter(Boolean);
};
export function createSalesAccountingHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const contextFor = dependencies.getTenantContext || getTenantContext;
  return async (req, res) => {
    try {
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      const [saleId, pathAction, provider] = salesAccountingPathParts(req);
      const action = pathAction || new URL(req.url || '/', 'http://localhost').searchParams.get('action') || req.query?.action;
      const context = await contextFor(req);
      const configuration = saleId === 'configuration';
      const capability = !configuration && req.method === 'GET' && action !== 'refresh'
        ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_ACCOUNTING;
      const actor = await requireSalesContext(context, capability, dependencies);
      if (configuration) {
        const scopedSaleId = new URL(req.url || '/', 'http://localhost').searchParams.get('saleId') || req.query?.saleId;
        if (scopedSaleId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scopedSaleId)) {
          throw new SalesHttpError(400, 'Invalid sale ID');
        }
        const scopedDependencies = { ...dependencies, saleId: scopedSaleId || null };
        // The independent Manage Accounting capability above is authoritative
        // for portal members as well as dashboard tenant administrators.
        if (req.method === 'GET') {
          return res.status(200).json(await getSalesAccountingConfiguration(db, actor.tenantId, scopedDependencies));
        }
        if (req.method === 'PATCH') {
          const validation = validateSalesAccountingConfigurationPatch(req.body || {});
          if (!validation.ok) return res.status(400).json({ error: 'Invalid accounting configuration', details: validation.errors });
          return res.status(200).json(await saveSalesAccountingConfiguration(
            db, actor.tenantId, req.body, scopedDependencies,
          ));
        }
        res.setHeader('Allow', 'GET, PATCH');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (!saleId) throw new SalesHttpError(400, 'saleId is required');
      if (req.method === 'GET' && action === 'schedules') {
        return res.status(200).json({ schedules: await getSalesSchedules(db, actor.tenantId, saleId) });
      }
      if (req.method === 'POST' && ['retry-schedule', 'refresh-schedule'].includes(action)) {
        const schedules = await (dependencies.getSalesSchedules || getSalesSchedules)(db, actor.tenantId, saleId);
        const schedule = schedules.find(row => row.id === req.body?.scheduleId);
        if (!schedule) throw new SalesHttpError(404, 'Invoice schedule not found for this sale');
        // Persist actor intent before any provider request, dispatch claim, or
        // email claim. An unavailable/lost audit response must not start effects.
        const { error: auditError } = await db.from('sales_audit_event').insert({
          tenant_id: actor.tenantId, actor_id: actor.actorId, actor_type: actor.actorType,
          action: action === 'refresh-schedule' ? 'invoice_schedule.refresh_attempt' : 'invoice_schedule.retry_attempt',
          entity_type: 'sales_invoice_schedule', entity_id: schedule.id,
          after_data: { saleId, scheduleStatus: schedule.status, deliveryStatus: schedule.delivery_status,
            accountingRequestId: schedule.accounting_request_id || null,
            providerCustomerId: req.body?.providerCustomerId || null,
            confirmCustomerMatch: req.body?.confirmCustomerMatch === true },
        });
        if (auditError) throw auditError;
        if (action === 'refresh-schedule') {
          return res.status(200).json(await (dependencies.refreshSalesInvoiceStatus || refreshSalesInvoiceStatus)(db, actor.tenantId, saleId, schedule.provider,
            { ...dependencies, scheduleId: schedule.id, schedule }));
        }
        if (schedule.status === 'invoiced') {
          if (schedule.delivery_status !== 'rejected') throw new SalesHttpError(409, 'Only definitely rejected delivery can be retried; unknown outcomes require review');
          if (schedule.next_attempt_at && Date.parse(schedule.next_attempt_at) > Date.now()) {
            const cooling = new SalesHttpError(409, `Delivery retry is delayed until ${schedule.next_attempt_at}; the retry cooldown cannot be bypassed`);
            cooling.code = 'SCHEDULE_DELIVERY_COOLDOWN';
            cooling.details = { retryAt: schedule.next_attempt_at };
            throw cooling;
          }
          const delivered = await (dependencies.deliverSalesSchedule || deliverSalesSchedule)(db, schedule, dependencies);
          if (delivered.skipped) {
            const busy = new SalesHttpError(409, 'Delivery was not claimed: another worker may own it or delivery has already finished. Reload this group before retrying');
            busy.code = 'SCHEDULE_DELIVERY_NOT_CLAIMED';
            throw busy;
          }
          return res.status(200).json(delivered);
        }
        return res.status(200).json({ schedule: await (dependencies.dispatchSalesSchedule || dispatchSalesSchedule)(db, actor.tenantId, schedule.id,
          { providerCustomerId: req.body?.providerCustomerId, confirmCustomerMatch: req.body?.confirmCustomerMatch,
            retry: true, actorId: actor.actorId, actorType: actor.actorType }, dependencies) });
      }
      if (req.method === 'GET' && (!action || action === 'invoices')) {
        return res.status(200).json(await getSalesInvoices(db, actor.tenantId, saleId));
      }
      if (req.method === 'POST' && action === 'invoice') {
        const validation = validateSalesInvoiceCommand(req.body || {});
        if (!validation.ok) return res.status(400).json({ error: 'Invalid sales invoice request', details: validation.errors });
        const result = await createSalesInvoice(db, actor.tenantId, actor, saleId, req.body || {}, dependencies);
        return res.status(result.existing ? 200 : 201).json(result);
      }
      if (req.method === 'POST' && action === 'refresh' && provider) {
        if (!['xero', 'quickbooks'].includes(provider)) throw new SalesHttpError(400, 'Invalid accounting provider');
        return res.status(200).json(await refreshSalesInvoiceStatus(db, actor.tenantId, saleId, provider, dependencies));
      }
      res.setHeader('Allow', 'GET, POST, PATCH');
      return res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      const body = { error: status === 500 ? 'Failed to handle Sales accounting' : error.message };
      if (error.code) body.code = error.code;
      if (error.details) body.details = error.details;
      return res.status(status).json(body);
    }
  };
}
export default createSalesAccountingHandler();