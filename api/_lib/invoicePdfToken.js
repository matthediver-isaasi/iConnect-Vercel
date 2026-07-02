import crypto from 'crypto';
import { supabase as defaultSupabase } from './database.js';

const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';

const VALID_TABLES = new Set([
  'organisation_membership_history',
  'member_membership_history',
]);

/**
 * Returns an existing (non-revoked) public PDF token for a membership history
 * row, or mints a new one. Idempotent so re-sending the renewal email reuses
 * the same URL.
 *
 * @returns {Promise<string|null>} the token string, or null on failure.
 */
export async function getOrCreateInvoicePdfToken({
  client = defaultSupabase,
  tenantId,
  historyTable,
  recordId,
}) {
  if (!client || !tenantId || !recordId) return null;
  if (!VALID_TABLES.has(historyTable)) {
    console.error('[invoicePdfToken] invalid historyTable:', historyTable);
    return null;
  }

  try {
    const { data: existing } = await client
      .from('membership_invoice_pdf_token')
      .select('token, revoked')
      .eq('tenant_id', tenantId)
      .eq('history_table', historyTable)
      .eq('history_row_id', recordId)
      .maybeSingle();
    if (existing && !existing.revoked) return existing.token;
    if (existing && existing.revoked) return null;
  } catch (err) {
    if (err?.code !== 'PGRST116') {
      console.error('[invoicePdfToken] lookup failed:', err.message);
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  try {
    const { error } = await client
      .from('membership_invoice_pdf_token')
      .insert({
        token,
        tenant_id: tenantId,
        history_table: historyTable,
        history_row_id: recordId,
      });
    if (error) {
      // Concurrent insert race — fetch the winner.
      if (error.code === '23505') {
        const { data: race } = await client
          .from('membership_invoice_pdf_token')
          .select('token, revoked')
          .eq('tenant_id', tenantId)
          .eq('history_table', historyTable)
          .eq('history_row_id', recordId)
          .maybeSingle();
        if (race && !race.revoked) return race.token;
        return null;
      }
      console.error('[invoicePdfToken] insert failed:', error.message);
      return null;
    }
  } catch (err) {
    console.error('[invoicePdfToken] insert error:', err.message);
    return null;
  }
  return token;
}

/**
 * Build the public View Invoice URL for a token. Uses the tenant slug as a
 * subdomain when known, mirroring the membership_fee_token email pattern.
 */
export function buildInvoicePdfUrl(token, tenantSlug = null) {
  if (!token) return null;
  const host = tenantSlug ? `${tenantSlug}.${APP_DOMAIN}` : APP_DOMAIN;
  return `https://${host}/api/public/membership-invoice-pdf/${token}`;
}
