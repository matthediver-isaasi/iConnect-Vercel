import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { authorizeFormSubmissionAccess } from '../_lib/formSubmissionDeleteAccess.js';
import { getAccountingProviderByName } from '../_lib/accountingProvider.js';
import { formSubmissionInvoice, formInvoiceFilename } from '../../shared/formSubmissionInvoice.js';

export function createFormSubmissionInvoiceHandler({
  db = supabase, getContext = getTenantContext, getProvider = getAccountingProviderByName,
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!db) return res.status(503).json({ error: 'Invoice service is unavailable. Please try again later.' });
    try {
      const context = await getContext(req);
      if (context.tenantMismatch) return res.status(409).json({ error: 'Your account has changed. Reload this page and try again.' });
      const denied = await authorizeFormSubmissionAccess(db, context);
      if (denied) return res.status(denied.status).json({ error: denied.error });
      const id = req.query?.submissionId;
      if (typeof id !== 'string' || !id.trim() || id.length > 200) {
        return res.status(400).json({ error: 'Submission id required' });
      }
      const { data: submission, error } = await db.from('form_submission')
        .select('id,payment_provider,payment_meta').eq('tenant_id', context.tenantId).eq('id', id).maybeSingle();
      if (error) return res.status(503).json({ error: 'Unable to load the submission invoice. Please try again.' });
      const invoice = formSubmissionInvoice(submission);
      if (!invoice?.linked) return res.status(404).json({ error: 'An issued invoice document is not available for this submission yet.' });
      const order = submission.payment_meta?.invoice_order;
      // New orders pin the connection and company too. Fail closed on replaced
      // connections rather than retrieving an invoice from a different account.
      if (order?.connectionId || order?.companyId) {
        const companyColumn = invoice.provider === 'xero' ? 'tenant_id' : 'realm_id';
        const binding = await db.from(invoice.provider === 'xero' ? 'xero_token' : 'quickbooks_token')
          .select(`id,${companyColumn}`).eq('app_tenant_id', context.tenantId)
          .eq('id', order.connectionId).maybeSingle();
        if (binding.error || !binding.data || !order.companyId
          || String(binding.data[companyColumn]) !== String(order.companyId)) {
          return res.status(409).json({ error: 'The original accounting connection is unavailable. Please contact an administrator.' });
        }
      }
      const provider = getProvider(invoice.provider);
      const pdf = await provider.fetchInvoicePdf(invoice.invoiceId, context.tenantId,
        order?.companyId ? { companyId: order.companyId } : undefined);
      if (!Buffer.isBuffer(pdf) || pdf.length < 5 || pdf.subarray(0, 5).toString() !== '%PDF-') {
        throw new Error('Invalid invoice PDF');
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', pdf.length);
      res.setHeader('Content-Disposition', `${req.query.inline === 'true' ? 'inline' : 'attachment'}; filename="${formInvoiceFilename(invoice.number, id)}"`);
      return res.send(pdf);
    } catch {
      // Never return upstream payloads (which may include credentials), nor
      // label a provider error body as a PDF.
      return res.status(502).json({ error: 'Unable to retrieve the invoice PDF. Please try again later or contact an administrator.' });
    }
  };
}

export default createFormSubmissionInvoiceHandler();
