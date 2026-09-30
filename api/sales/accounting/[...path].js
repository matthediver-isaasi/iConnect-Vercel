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

const parts = (req) => {
  const path = req.query?.path;
  return Array.isArray(path) ? path : String(path || '').split('/').filter(Boolean);
};
export function createSalesAccountingHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const contextFor = dependencies.getTenantContext || getTenantContext;
  return async (req, res) => {
    try {
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      const [saleId, action, provider] = parts(req);
      const context = await contextFor(req);
      const configuration = saleId === 'configuration';
      const capability = !configuration && req.method === 'GET' && action !== 'refresh'
        ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_ACCOUNTING;
      const actor = await requireSalesContext(context, capability, dependencies);
      if (configuration) {
        if (actor.actorType !== 'tenant_user') throw new SalesHttpError(403, 'Tenant user accounting access required');
        if (req.method === 'GET') {
          return res.status(200).json(await getSalesAccountingConfiguration(db, actor.tenantId, dependencies));
        }
        if (req.method === 'PATCH') {
          const validation = validateSalesAccountingConfigurationPatch(req.body || {});
          if (!validation.ok) return res.status(400).json({ error: 'Invalid accounting configuration', details: validation.errors });
          return res.status(200).json(await saveSalesAccountingConfiguration(
            db, actor.tenantId, req.body, dependencies,
          ));
        }
        res.setHeader('Allow', 'GET, PATCH');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (!saleId) throw new SalesHttpError(400, 'saleId is required');
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