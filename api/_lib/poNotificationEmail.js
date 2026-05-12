import { supabase } from './database.js';
import { sendEmail } from './emailService.js';

const PO_NOTIFICATION_SETTING_KEY = 'po_submission_notification_email';

async function getNotificationRecipient(tenantId) {
  if (!supabase || !tenantId) return null;
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', PO_NOTIFICATION_SETTING_KEY)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) {
      console.error('[poNotificationEmail] Failed to load setting:', error.message);
      return null;
    }
    const value = (data?.setting_value || '').trim();
    return value || null;
  } catch (err) {
    console.error('[poNotificationEmail] Error fetching setting:', err.message);
    return null;
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendPoSubmissionNotification({
  tenantId,
  bookingReference,
  eventName,
  purchaseOrderNumber,
  submitterName,
  submitterEmail,
  bookingType = 'event',
}) {
  try {
    if (!tenantId) return { success: false, skipped: true, reason: 'no tenantId' };

    const recipient = await getNotificationRecipient(tenantId);
    if (!recipient) {
      return { success: false, skipped: true, reason: 'no recipient configured' };
    }

    const safeRef = escapeHtml(bookingReference || 'N/A');
    const safeEvent = escapeHtml(eventName || 'Unknown event');
    const safePo = escapeHtml(purchaseOrderNumber || '');
    const safeName = escapeHtml(submitterName || '');
    const safeEmail = escapeHtml(submitterEmail || '');

    const submitterLine = safeName
      ? (safeEmail ? `${safeName} &lt;${safeEmail}&gt;` : safeName)
      : (safeEmail || 'Unknown');

    const subject = `Purchase Order submitted for booking ${bookingReference || ''}`.trim();

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
        <h2 style="margin: 0 0 12px;">Purchase Order submitted</h2>
        <p>A purchase order has been submitted for the following booking.</p>
        <table cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 12px 0;">
          <tr><td style="padding-right: 16px;"><strong>Booking reference:</strong></td><td>${safeRef}</td></tr>
          <tr><td style="padding-right: 16px;"><strong>Event:</strong></td><td>${safeEvent}</td></tr>
          <tr><td style="padding-right: 16px;"><strong>PO number:</strong></td><td>${safePo}</td></tr>
          <tr><td style="padding-right: 16px;"><strong>Submitted by:</strong></td><td>${submitterLine}</td></tr>
          <tr><td style="padding-right: 16px;"><strong>Booking type:</strong></td><td>${escapeHtml(bookingType)}</td></tr>
        </table>
        <p style="color: #555; font-size: 13px;">This is an automated notification.</p>
      </div>
    `;

    const result = await sendEmail({
      to: recipient,
      subject,
      html,
      tenantId,
    });

    if (!result.success) {
      console.error('[poNotificationEmail] sendEmail failed:', result.error);
    } else {
      console.log(`[poNotificationEmail] Notification sent to ${recipient} for booking ${bookingReference}`);
    }
    return result;
  } catch (err) {
    console.error('[poNotificationEmail] Unexpected error:', err.message);
    return { success: false, error: err.message };
  }
}
