import { supabase } from '../../_lib/database.js';
import { applyInvoicePoUpdate, summariseInvoice, ensurePendingPoTokenTable, poInvoiceGuard } from '../../_lib/pendingPoInvoice.js';
import { sendPoSubmissionNotification } from '../../_lib/poNotificationEmail.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token required' });
  }

  await ensurePendingPoTokenTable();

  const { data: tokenRow, error: tokenErr } = await supabase
    .from('pending_po_token')
    .select('id, tenant_id, invoice_key, status, expires_at, po_number, submitted_at')
    .eq('token', token)
    .maybeSingle();

  if (tokenErr || !tokenRow) {
    return res.status(404).json({ error: 'This link is invalid or has been removed.' });
  }

  if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This link has expired.' });
  }

  const { data: tenant } = await supabase
    .from('tenant')
    .select('id, name, slug, primary_color, logo_url')
    .eq('id', tokenRow.tenant_id)
    .single();

  let summary;
  try {
    summary = await summariseInvoice(supabase, tokenRow.tenant_id, tokenRow.invoice_key);
  } catch (error) {
    return res.status(500).json({ error: `Invoice lookup failed: ${error.message}` });
  }
  const guard = poInvoiceGuard(summary);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

  if (req.method === 'GET') {
    if (!summary) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    return res.json({
      status: tokenRow.status,
      submittedPoNumber: tokenRow.po_number,
      submittedAt: tokenRow.submitted_at,
      invoice: summary,
      tenant: tenant ? {
        name: tenant.name,
        slug: tenant.slug,
        primaryColor: tenant.primary_color,
        logoUrl: tenant.logo_url,
      } : null,
    });
  }

  if (req.method === 'POST') {
    const { action, poNumber } = req.body || {};
    if (action !== 'submit_po') {
      return res.status(400).json({ error: 'Unknown action' });
    }
    if (!poNumber || !poNumber.trim()) {
      return res.status(400).json({ error: 'Please enter a purchase order number.' });
    }
    if (tokenRow.status === 'submitted') {
      return res.status(400).json({ error: 'A purchase order number has already been submitted via this link.' });
    }
    if (!summary) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    if (summary.existingPoNumber) {
      return res.status(409).json({ error: 'A purchase order number has already been recorded for this invoice.' });
    }

    const result = await applyInvoicePoUpdate({
      client: supabase,
      tenantId: tokenRow.tenant_id,
      invoiceKey: tokenRow.invoice_key,
      purchaseOrderNumber: poNumber,
      contextLabel: `PendingPO public token ${tokenRow.id}`,
    });

    if (!result.ok) {
      console.error(
        `[PendingPO public] PO submission failed tokenId=${tokenRow.id} tenantId=${tokenRow.tenant_id} invoiceKey=${tokenRow.invoice_key}: ${result.error}`,
      );
      return res.status(result.status || 500).json({ error: result.error });
    }

    const trimmedPO = result.purchase_order_number;
    await supabase
      .from('pending_po_token')
      .update({
        status: 'submitted',
        po_number: trimmedPO,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', tokenRow.id);

    try {
      const submitterName = summary.bookerNameDisplay || (summary.bookerNames && summary.bookerNames[0]) || '';
      const submitterEmail = (summary.bookerEmails && summary.bookerEmails[0]) || '';
      const fallbackName = submitterName || (submitterEmail ? '' : 'Submitted via public PO link');
      await sendPoSubmissionNotification({
        tenantId: tokenRow.tenant_id,
        bookingReference: summary.invoiceNumber || tokenRow.invoice_key,
        eventName: summary.sourceName || '',
        purchaseOrderNumber: trimmedPO,
        submitterName: fallbackName,
        submitterEmail,
        bookingType: 'public_po_link',
      });
    } catch (notifyErr) {
      console.error('[PendingPO public] PO notification email failed:', notifyErr.message);
    }

    return res.json({
      success: true,
      purchase_order_number: trimmedPO,
      bookingsUpdated: result.bookingsUpdated,
      transactionsUpdated: result.transactionsUpdated,
      xeroUpdated: result.xeroUpdated,
      xeroError: result.xeroError,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
