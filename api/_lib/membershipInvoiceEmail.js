import { supabase } from './database.js';
import { sendTenantEmail } from './tenantEmailService.js';
import { resolveTierRecipients } from './membershipRecipientResolver.js';
import { getOrCreateInvoicePdfToken, buildInvoicePdfUrl } from './invoicePdfToken.js';

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
  historyTable = 'organisation_membership_history',
  vatAmount,
  totalWithVat,
  onlineInvoiceUrl,
  tierConfig,
}) {
  if (!supabase) {
    console.error('[Invoice Email] Supabase not configured');
    return { success: false, error: 'Database not configured' };
  }

  if (!xeroInvoiceId) {
    console.log('[Invoice Email] No invoice id - skipping email');
    return { success: false, error: 'No invoice details available' };
  }

  // QBO may legitimately return no DocNumber when the company file has
  // "Custom transaction numbers" enabled. In that case we send the email
  // anyway, but omit the invoice-number row + drop the number from the
  // subject so we never surface QBO's internal id as a fake "invoice number".
  const hasInvoiceNumber = !!xeroInvoiceNumber;

  try {
    const resolved = await resolveTierRecipients({
      client: supabase,
      tenantId,
      organizationId,
      tierConfig,
    });
    const allRecipients = resolved.recipients;

    if (resolved.usedFallback) {
      console.warn(
        `[Invoice Email] Tier recipients resolved to no addresses for org ${organizationId}; ` +
        `using invoicing-email/primary-contact safety fallback (${allRecipients.join(', ') || 'none'}).`
      );
    }

    if (allRecipients.length === 0) {
      console.log(`[Invoice Email] No recipient emails found for org ${organizationId} - skipping`);
      return { success: false, error: 'No recipient email found' };
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('name, slug, logo_url, primary_color')
      .eq('id', tenantId)
      .single();

    // Fallback to public PDF token when no provider-hosted invoice link is
    // available (e.g. QBO with online invoicing disabled).
    let viewInvoiceUrl = onlineInvoiceUrl || null;
    if (!viewInvoiceUrl && historyRecordId) {
      const pdfToken = await getOrCreateInvoicePdfToken({
        client: supabase,
        tenantId,
        historyTable,
        recordId: historyRecordId,
      });
      if (pdfToken) {
        viewInvoiceUrl = buildInvoicePdfUrl(pdfToken, tenant?.slug || null);
      }
    }

    const tenantName = tenant?.name || 'Organisation';
    const primaryColor = tenant?.primary_color || '#5C0085';
    const currencySymbol = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' }[currency] || currency;

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
              ${hasInvoiceNumber ? `
              <tr>
                <td style="padding: 4px 0; color: #666;">Invoice Number</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 600;">${xeroInvoiceNumber}</td>
              </tr>
              ` : ''}
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
          ${viewInvoiceUrl ? `
          <p>You can view and download your invoice using the link below:</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${viewInvoiceUrl}" style="display: inline-block; background: ${primaryColor}; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">View Invoice</a>
          </div>
          ` : ''}
          <p style="color: #666; font-size: 13px;">If you have any questions about this invoice, please contact us.</p>
        </div>
        <p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">${tenantName}</p>
      </div>
    `;

    const subject = hasInvoiceNumber
      ? `Membership Invoice ${xeroInvoiceNumber} - ${membershipYear} - ${tenantName}`
      : `Membership Invoice - ${membershipYear} - ${tenantName}`;
    const sendResults = [];

    for (const toEmail of allRecipients) {
      try {
        const emailResult = await sendTenantEmail({
          tenantId,
          to: toEmail,
          subject,
          html: emailHtml,
        });
        sendResults.push({ email: toEmail, success: emailResult.success, error: emailResult.error });
      } catch (err) {
        sendResults.push({ email: toEmail, success: false, error: err.message });
      }
    }

    const successfulSends = sendResults.filter(r => r.success);
    const failedSends = sendResults.filter(r => !r.success);

    if (successfulSends.length === 0) {
      console.error('[Invoice Email] All sends failed:', failedSends);
      return { success: false, error: 'All email sends failed', sentTo: allRecipients };
    }

    const recipientList = allRecipients.join(', ');
    const invoiceLabel = hasInvoiceNumber ? xeroInvoiceNumber : '(no invoice number)';
    console.log(`[Invoice Email] Invoice email sent to ${recipientList} for ${organizationName} (${invoiceLabel})`);

    try {
      await supabase.from('organization_note').insert({
        organization_id: organizationId,
        member_id: null,
        content: `[Membership Invoice Email] Invoice ${invoiceLabel} notification sent to ${recipientList} for ${membershipYear}.`,
        attachments: [],
      });
    } catch {}

    return {
      success: true,
      sentTo: allRecipients,
      failed: failedSends.length > 0 ? failedSends : undefined,
    };
  } catch (error) {
    console.error('[Invoice Email] Error:', error);
    return { success: false, error: error.message };
  }
}
