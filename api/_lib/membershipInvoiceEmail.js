import { supabase } from './database.js';
import { sendTenantEmail } from './tenantEmailService.js';
import crypto from 'crypto';

const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';

async function ensureInvoiceDownloadTokenTable() {
  try {
    const { error } = await supabase
      .from('membership_invoice_download_token')
      .select('id')
      .limit(1);

    if (!error) return;

    if (error.code === '42P01') {
      await supabase.rpc('exec_sql', {
        sql_text: `
          CREATE TABLE IF NOT EXISTS membership_invoice_download_token (
            id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
            token TEXT NOT NULL UNIQUE,
            tenant_id UUID NOT NULL,
            organization_id UUID NOT NULL,
            history_record_id UUID NOT NULL,
            xero_invoice_id TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_invoice_dl_token ON membership_invoice_download_token(token);
        `
      });
    }
  } catch (err) {
    console.error('[Invoice Email] Error ensuring download token table:', err.message);
  }
}

export async function sendMembershipInvoiceEmail({
  tenantId,
  organizationId,
  organizationName,
  membershipYear,
  finalCost,
  currency,
  tierLabel,
  xeroInvoiceNumber,
  xeroInvoiceId,
  historyRecordId,
  vatAmount,
  totalWithVat,
}) {
  if (!supabase) {
    console.error('[Invoice Email] Supabase not configured');
    return { success: false, error: 'Database not configured' };
  }

  if (!xeroInvoiceId || !xeroInvoiceNumber) {
    console.log('[Invoice Email] No Xero invoice details - skipping email');
    return { success: false, error: 'No invoice details available' };
  }

  try {
    let toEmail = null;
    const { data: orgData } = await supabase
      .from('organization')
      .select('invoicing_email')
      .eq('id', organizationId)
      .single();

    toEmail = orgData?.invoicing_email;

    if (!toEmail) {
      const { data: primaryContact } = await supabase
        .from('member')
        .select('email')
        .eq('organization_id', organizationId)
        .eq('is_primary_contact', true)
        .limit(1)
        .maybeSingle();

      toEmail = primaryContact?.email;
    }

    if (!toEmail) {
      console.log(`[Invoice Email] No invoicing email or primary contact for org ${organizationId} - skipping`);
      return { success: false, error: 'No recipient email found' };
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('name, slug, logo_url, primary_color')
      .eq('id', tenantId)
      .single();

    const tenantName = tenant?.name || 'Organisation';
    const tenantSlug = tenant?.slug;
    const primaryColor = tenant?.primary_color || '#5C0085';
    const currencySymbol = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' }[currency] || currency;

    let downloadUrl = null;
    try {
      await ensureInvoiceDownloadTokenTable();

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

      const { error: tokenErr } = await supabase
        .from('membership_invoice_download_token')
        .insert({
          token,
          tenant_id: tenantId,
          organization_id: organizationId,
          history_record_id: historyRecordId,
          xero_invoice_id: xeroInvoiceId,
          expires_at: expiresAt.toISOString(),
        });

      if (!tokenErr) {
        const baseUrl = tenantSlug
          ? `https://${tenantSlug}.${APP_DOMAIN}`
          : `https://${APP_DOMAIN}`;
        downloadUrl = `${baseUrl}/api/public/membership-invoice-download/${token}`;
      } else {
        console.error('[Invoice Email] Error creating download token:', tokenErr.message);
      }
    } catch (dlErr) {
      console.error('[Invoice Email] Error setting up download link (non-fatal):', dlErr.message);
    }

    const displayTotal = totalWithVat && totalWithVat > finalCost ? totalWithVat : finalCost;
    const hasVat = vatAmount && vatAmount > 0;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${tenant?.logo_url ? `<div style="text-align: center; padding: 20px 0;"><img src="${tenant.logo_url}" alt="${tenantName}" style="max-height: 60px;" /></div>` : ''}
        <div style="padding: 20px; border: 1px solid #e5e5e5; border-radius: 8px;">
          <h2 style="color: ${primaryColor}; margin-top: 0;">Membership Invoice - ${membershipYear}</h2>
          <p>Dear ${organizationName},</p>
          <p>Your membership invoice for the period <strong>${membershipYear}</strong> has been generated.</p>
          <div style="background: #f9f9f9; padding: 16px; border-radius: 6px; margin: 16px 0;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 4px 0; color: #666;">Invoice Number</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 600;">${xeroInvoiceNumber}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #666;">Membership Year</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 600;">${membershipYear}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #666;">Tier</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 600;">${tierLabel || 'Standard'}</td>
              </tr>
              ${hasVat ? `
              <tr>
                <td style="padding: 4px 0; color: #666;">Net Amount</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 600;">${currencySymbol}${parseFloat(finalCost).toFixed(2)}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #666;">VAT</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 600;">${currencySymbol}${parseFloat(vatAmount).toFixed(2)}</td>
              </tr>
              ` : ''}
              <tr>
                <td colspan="2" style="padding: 8px 0 4px 0; border-top: 1px solid #ddd;"></td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #333; font-weight: 600;">Total${hasVat ? ' (incl. VAT)' : ''}</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 700; font-size: 18px;">${currencySymbol}${parseFloat(displayTotal).toFixed(2)}</td>
              </tr>
            </table>
          </div>
          ${downloadUrl ? `
          <p>You can download a copy of your invoice using the link below:</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${downloadUrl}" style="display: inline-block; background: ${primaryColor}; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">Download Invoice PDF</a>
          </div>
          <p style="color: #999; font-size: 12px;">This download link expires in 90 days.</p>
          ` : ''}
          <p style="color: #666; font-size: 13px;">If you have any questions about this invoice, please contact us.</p>
        </div>
        <p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">${tenantName}</p>
      </div>
    `;

    const emailResult = await sendTenantEmail({
      tenantId,
      to: toEmail,
      subject: `Membership Invoice ${xeroInvoiceNumber} - ${membershipYear} - ${tenantName}`,
      html: emailHtml,
    });

    if (!emailResult.success) {
      console.error('[Invoice Email] Email send failed:', emailResult.error);
      return { success: false, error: emailResult.error, sentTo: toEmail };
    }

    console.log(`[Invoice Email] Invoice email sent to ${toEmail} for ${organizationName} (${xeroInvoiceNumber})`);

    try {
      await supabase.from('organization_note').insert({
        organization_id: organizationId,
        member_id: null,
        content: `[Membership Invoice Email] Invoice ${xeroInvoiceNumber} notification sent to ${toEmail} for ${membershipYear}.`,
        attachments: [],
      });
    } catch {}

    return { success: true, sentTo: toEmail };
  } catch (error) {
    console.error('[Invoice Email] Error:', error);
    return { success: false, error: error.message };
  }
}
