import { supabase } from '../_lib/database.js';
import { historicalInvoiceAccess, UUID_RE, accessError } from '../_lib/historicalInvoiceAccess.js';
import { getHistoricalInvoicePdf } from '../_lib/historicalInvoicePdf.js';

export function createHistoricalInvoiceHandler(dependencies = {}) {
  const db = dependencies.db === undefined ? supabase : dependencies.db;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { recordId, inline = 'false' } = req.query || {};
    if (typeof recordId !== 'string' || !UUID_RE.test(recordId) || !['true', 'false'].includes(inline)) {
      return res.status(400).json({ error: 'Invalid invoice request' });
    }
    try {
      const access = await historicalInvoiceAccess(req, dependencies);
      if (!access.canAccessInvoices) throw accessError(403, 'Invoice access permission required');
      let query = db.from('historical_member_invoice').select('*')
        .eq('tenant_id', access.tenantId).eq('id', recordId);
      if (!access.isAdmin) query = query.eq('member_id', access.memberId);
      const { data: row, error } = await query.maybeSingle();
      if (error) throw error;
      if (!row) throw accessError(404, 'Historical invoice not found');
      if (row.record_kind === 'overpayment') throw accessError(422, 'This overpayment has no invoice document reference');
      const { pdf, id, type } = await (dependencies.getPdf || getHistoricalInvoicePdf)(row);
      if (!row.xero_document_id) {
        const { error: cacheError } = await db.from('historical_member_invoice')
          .update({ xero_document_id: id, xero_document_type: type })
          .eq('tenant_id', access.tenantId).eq('id', row.id).is('xero_document_id', null);
        if (cacheError) throw accessError(503, 'Unable to cache the invoice reference. Please try again.');
      }
      const name = row.invoice_number.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${inline === 'true' ? 'inline' : 'attachment'}; filename="historical-${name}.pdf"`);
      return res.send(pdf);
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.status ? error.message : 'Unable to retrieve the historical PDF. Check the Xero connection or try again later.' });
    }
  };
}
export default createHistoricalInvoiceHandler();
