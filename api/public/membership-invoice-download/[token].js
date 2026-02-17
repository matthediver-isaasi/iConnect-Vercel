import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const { data: dlToken, error: tokenError } = await supabase
      .from('membership_invoice_download_token')
      .select('*')
      .eq('token', token)
      .single();

    if (tokenError || !dlToken) {
      return res.status(404).json({ error: 'Download link not found or has expired' });
    }

    if (new Date(dlToken.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This download link has expired' });
    }

    if (!dlToken.xero_invoice_id) {
      return res.status(404).json({ error: 'No invoice associated with this link' });
    }

    const { data: record } = await supabase
      .from('organisation_membership_history')
      .select('xero_invoice_id, xero_invoice_number, membership_year')
      .eq('id', dlToken.history_record_id)
      .eq('tenant_id', dlToken.tenant_id)
      .maybeSingle();

    const invoiceId = record?.xero_invoice_id || dlToken.xero_invoice_id;
    const invoiceNumber = record?.xero_invoice_number || 'invoice';

    const { fetchXeroInvoicePdf } = await import('../../_lib/xero.js');
    const pdfBuffer = await fetchXeroInvoicePdf(invoiceId, dlToken.tenant_id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="membership-invoice-${invoiceNumber}.pdf"`);

    return res.send(pdfBuffer);
  } catch (error) {
    console.error('[Invoice Download] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch invoice' });
  }
}
