import { supabase } from '../_lib/database.js';
import { historicalInvoiceAccess, UUID_RE, accessError } from '../_lib/historicalInvoiceAccess.js';
import { loadMemberActivityInvoices } from '../_lib/memberActivityInvoices.js';

export function createHistoricalInvoicesHandler(dependencies = {}) {
  const db = dependencies.db === undefined ? supabase : dependencies.db;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { memberId, page = '0', includeMembership = 'false' } = req.query || {};
    if (typeof memberId !== 'string' || !UUID_RE.test(memberId) ||
        typeof page !== 'string' || !/^\d{1,6}$/.test(page) || !['true', 'false'].includes(includeMembership)) {
      return res.status(400).json({ error: 'A valid memberId and page are required' });
    }
    try {
      const access = await historicalInvoiceAccess(req, dependencies);
      if (!access.isAdmin && memberId !== access.memberId) throw accessError(403, 'Not authorized to view these invoices');
      const offset = Number(page) * 50;
      if (includeMembership === 'true') {
        const records = await loadMemberActivityInvoices(db, {
          tenantId: access.tenantId, memberId, canAccessInvoices: access.canAccessInvoices,
        });
        return res.json({ records: records.slice(offset, offset + 50), total: records.length,
          canAccessInvoices: access.canAccessInvoices });
      }
      const { data, error, count } = await db.from('historical_member_invoice')
        .select('id,invoice_number,invoice_date,amount_minor,currency,description,record_kind,status,accounting_status,accounting_payment_status,accounting_status_checked_at,accounting_status_error', { count: 'exact' })
        .eq('tenant_id', access.tenantId).eq('member_id', memberId)
        .order('invoice_date', { ascending: false }).order('id', { ascending: false })
        .range(offset, offset + 49);
      if (error) throw error;
      return res.json({
        records: data.map(({ accounting_status_error, ...row }) => ({
          ...row,
          accounting_status_refresh_pending: Boolean(accounting_status_error),
          can_download: access.canAccessInvoices && row.record_kind !== 'overpayment',
        })),
        total: count, canAccessInvoices: access.canAccessInvoices,
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to load historical invoices' });
    }
  };
}
export default createHistoricalInvoicesHandler();
