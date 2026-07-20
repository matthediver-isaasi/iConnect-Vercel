import { getSessionMember } from '../_lib/session.js';
import { getAccountingProvider } from '../_lib/accountingProvider.js';
import { supabase } from '../_lib/database.js';

// Serve the accounting invoice PDF for a Training Fund purchase. Mirrors
// api/booking-invoice/[bookingGroupRef].js: the caller must be the member who
// created the purchase or belong to the purchasing organisation.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const sessionMember = await getSessionMember(req);
  if (!sessionMember) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { purchaseId } = req.query;
  if (!purchaseId) {
    return res.status(400).json({ error: 'Purchase id required' });
  }

  try {
    const { data: purchase, error } = await supabase
      .from('training_fund_purchase')
      .select('id, organization_id, created_by, xero_invoice_id, xero_invoice_number, accounting_invoice_id, accounting_invoice_number')
      .eq('id', purchaseId)
      .eq('tenant_id', sessionMember.tenant_id)
      .maybeSingle();

    if (error) {
      console.error('[training-fund-invoice] Error fetching purchase:', error);
      return res.status(500).json({ error: 'Failed to fetch purchase' });
    }

    const invoiceId = purchase?.accounting_invoice_id || purchase?.xero_invoice_id;
    if (!purchase || !invoiceId) {
      return res.status(404).json({ error: 'Invoice not found for this purchase' });
    }

    const isCreator = purchase.created_by && purchase.created_by === sessionMember.id;
    const isSameOrg = sessionMember.organization_id && purchase.organization_id
      && sessionMember.organization_id === purchase.organization_id;
    if (!isCreator && !isSameOrg) {
      return res.status(403).json({ error: 'Not authorized to view this invoice' });
    }

    const appTenantId = sessionMember.tenant_id;
    const provider = await getAccountingProvider(appTenantId);
    const pdfBuffer = await provider.fetchInvoicePdf(invoiceId, appTenantId);

    const invoiceNumber = purchase.accounting_invoice_number || purchase.xero_invoice_number;
    const inline = req.query.inline === 'true';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    const disposition = inline ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename="invoice-${invoiceNumber || purchase.id}.pdf"`);

    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[training-fund-invoice] Error serving invoice PDF:', err);
    if (err.code === 'ACCOUNTING_PROVIDER_NONE' || err.code === 'ACCOUNTING_PROVIDER_NOT_CONFIGURED') {
      return res.status(503).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Failed to fetch invoice from accounting provider' });
  }
}
