import { createClient } from '@supabase/supabase-js';
import { getAccountingProvider } from '../../_lib/accountingProvider.js';

// Simple in-memory per-token rate limit. Vercel functions are short-lived so
// this is best-effort throttling against scrapers within a single warm
// instance, not a hard guarantee.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateBuckets = new Map();

function rateLimited(token) {
  const now = Date.now();
  const bucket = rateBuckets.get(token) || [];
  const fresh = bucket.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(token, fresh);
    return true;
  }
  fresh.push(now);
  rateBuckets.set(token, fresh);
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.DEST_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.DEST_SUPABASE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token is required' });
  }

  if (rateLimited(token)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const { data: tokenRow, error: tokenErr } = await supabase
      .from('membership_invoice_pdf_token')
      .select('id, tenant_id, history_table, history_row_id, revoked, expires_at')
      .eq('token', token)
      .maybeSingle();

    if (tokenErr || !tokenRow) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (tokenRow.revoked) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const { data: record, error: recordErr } = await supabase
      .from(tokenRow.history_table)
      .select('id, tenant_id, accounting_invoice_id, accounting_invoice_number, xero_invoice_id, xero_invoice_number')
      .eq('id', tokenRow.history_row_id)
      .eq('tenant_id', tokenRow.tenant_id)
      .maybeSingle();

    if (recordErr || !record) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoiceId = record.accounting_invoice_id || record.xero_invoice_id;
    if (!invoiceId) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const provider = await getAccountingProvider(tokenRow.tenant_id);
    const pdfBuffer = await provider.fetchInvoicePdf(invoiceId, tokenRow.tenant_id);

    // Audit + access tracking (non-fatal).
    try {
      await supabase.rpc('exec_sql', {
        sql_text: `UPDATE membership_invoice_pdf_token SET access_count = access_count + 1, last_accessed_at = NOW(), updated_at = NOW() WHERE id = '${tokenRow.id}'::uuid;`,
      });
    } catch {}

    const invoiceNumber = record.accounting_invoice_number || record.xero_invoice_number;
    console.log(`[public/membership-invoice-pdf] Served PDF for ${tokenRow.history_table}/${tokenRow.history_row_id} (invoice ${invoiceNumber || invoiceId}) via token`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Content-Disposition', `inline; filename="membership-invoice-${invoiceNumber || tokenRow.history_row_id}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[public/membership-invoice-pdf] Error serving PDF:', err);
    return res.status(500).json({ error: 'Failed to fetch invoice' });
  }
}
