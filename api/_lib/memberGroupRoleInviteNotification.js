import { sendEmail } from './emailService.js';

const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Best-effort plain-text preview of terms HTML for the email body. */
function termsPreview(html) {
  if (!html) return '';
  const text = String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|\u00A0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > 280 ? `${text.slice(0, 277)}…` : text;
}

function buildInviteUrl(tenantSlug, token) {
  const baseUrl = tenantSlug
    ? `https://${tenantSlug}.${APP_DOMAIN}`
    : `https://${APP_DOMAIN}`;
  return `${baseUrl}/group-role-invite/${token}`;
}

function buildEmailHtml({ tenantName, primaryColor, memberName, groupName, role, termsText, inviteUrl }) {
  const color = primaryColor || '#5C0085';
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
    <h2 style="color: ${escapeHtml(color)}; margin-bottom: 8px;">You've been invited to a role</h2>
    <p style="color: #555; margin-top: 0;">
      Hello${memberName ? ` ${escapeHtml(memberName)}` : ''},
    </p>
    <p style="color: #555;">
      ${tenantName ? `${escapeHtml(tenantName)} has` : 'You have been'} invited you to take on the role of
      <strong>${escapeHtml(role)}</strong> in <strong>${escapeHtml(groupName)}</strong>.
    </p>
    ${termsText ? `
    <div style="background: #f7f7f9; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 16px; margin: 16px 0;">
      <p style="margin: 0 0 4px; color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;">Terms of reference</p>
      <p style="margin: 0; color: #444;">${escapeHtml(termsText)}</p>
    </div>` : ''}
    <p style="color: #555;">Review the full terms of reference and respond using the button below.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 16px 0;">
      <tr>
        <td>
          <a href="${inviteUrl}" style="display: inline-block; background: ${escapeHtml(color)}; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">View invitation</a>
        </td>
      </tr>
    </table>
    <p style="color: #999; font-size: 12px; margin-top: 24px;">
      On the linked page you can accept or decline this invitation. If you weren't expecting this, you can safely ignore this email.
    </p>
  </div>`;
}

/**
 * Send (or resend) a member-group role invitation email. This is a tenant→member
 * email, so it resolves to the tenant's sending domain (NOT a system email).
 *
 * Inspects the sendEmail return value rather than assuming success (sendEmail
 * never throws — it returns { success: false, ... } on failure).
 *
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function sendRoleInviteEmail({
  toEmail,
  tenantId,
  tenantName,
  tenantSlug,
  primaryColor,
  memberName,
  groupName,
  role,
  termsHtml,
  token,
}) {
  if (!toEmail) return { success: false, error: 'No recipient email' };

  const inviteUrl = buildInviteUrl(tenantSlug, token);
  const termsText = termsPreview(termsHtml);
  const html = buildEmailHtml({
    tenantName,
    primaryColor,
    memberName,
    groupName,
    role,
    termsText,
    inviteUrl,
  });
  const subject = `Invitation: ${role} in ${groupName}`;

  const result = await sendEmail({ to: toEmail, subject, html, tenantId });
  if (!result?.success) {
    console.error('[RoleInviteNotify] Failed to email invite:', result?.error || 'unknown error');
    return { success: false, error: result?.error || 'Email failed to send' };
  }
  return { success: true };
}
