import crypto from 'crypto';
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

function formatExpiry(guestExpiresAt) {
  if (!guestExpiresAt) return 'Permanent (no expiry)';
  const d = new Date(guestExpiresAt);
  if (Number.isNaN(d.getTime())) return 'Permanent (no expiry)';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Read the `role_ids` array configured on the tenant's guest_access setting.
 * Backward compatible: returns [] when the field is absent or unparseable.
 */
async function resolveAlertRoleIds(client, tenantId) {
  const { data: settingRow } = await client
    .from('system_settings')
    .select('setting_value')
    .eq('tenant_id', tenantId)
    .eq('setting_key', 'guest_access')
    .maybeSingle();

  if (!settingRow?.setting_value) return [];
  try {
    const parsed = JSON.parse(settingRow.setting_value);
    return Array.isArray(parsed.role_ids) ? parsed.role_ids.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Resolve recipient emails for the guest-signup alert: every member in the
 * tenant holding one of the configured alert roles. De-duplicated, lowercased.
 */
async function resolveRecipientEmails(client, tenantId, roleIds) {
  if (!roleIds.length) return [];
  const { data, error } = await client
    .from('member')
    .select('email')
    .eq('tenant_id', tenantId)
    .in('role_id', roleIds);
  if (error) {
    console.error('[GuestSignupNotify] Failed to resolve recipients:', error.message);
    return [];
  }
  const out = new Set();
  for (const m of data || []) {
    const e = (m.email || '').trim().toLowerCase();
    if (e) out.add(e);
  }
  return [...out];
}

function buildEmailHtml({ tenantName, primaryColor, guestName, guestEmail, organizationName, expiryLabel, approveUrl, denyUrl }) {
  const color = primaryColor || '#5C0085';
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
    <h2 style="color: ${escapeHtml(color)}; margin-bottom: 8px;">New guest signup awaiting approval</h2>
    <p style="color: #555; margin-top: 0;">
      A new guest has signed up${tenantName ? ` for ${escapeHtml(tenantName)}` : ''} and is waiting for approval before they can log in.
    </p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <td style="padding: 6px 0; color: #888; width: 160px;">Name</td>
        <td style="padding: 6px 0; font-weight: 600;">${escapeHtml(guestName) || '(not provided)'}</td>
      </tr>
      <tr>
        <td style="padding: 6px 0; color: #888;">Email</td>
        <td style="padding: 6px 0; font-weight: 600;">${escapeHtml(guestEmail) || '(not provided)'}</td>
      </tr>
      <tr>
        <td style="padding: 6px 0; color: #888;">Organisation</td>
        <td style="padding: 6px 0; font-weight: 600;">${escapeHtml(organizationName) || '(not provided)'}</td>
      </tr>
      <tr>
        <td style="padding: 6px 0; color: #888;">Guest access until</td>
        <td style="padding: 6px 0; font-weight: 600;">${escapeHtml(expiryLabel)}</td>
      </tr>
    </table>
    <p style="color: #555;">Choose an action below. Each link can only be used once.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 16px 0;">
      <tr>
        <td style="padding-right: 12px;">
          <a href="${approveUrl}" style="display: inline-block; background: ${escapeHtml(color)}; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Approve access</a>
        </td>
        <td>
          <a href="${denyUrl}" style="display: inline-block; background: #f1f1f1; color: #333; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; border: 1px solid #ddd;">Deny access</a>
        </td>
      </tr>
    </table>
    <p style="color: #999; font-size: 12px; margin-top: 24px;">
      Approving enables this guest's login. Denying leaves their login disabled. You can change a guest's access at any time from the Team page.
    </p>
  </div>`;
}

/**
 * Mint a guest-approval token and email Approve/Deny links to every member
 * holding one of the tenant's configured guest-signup alert roles.
 *
 * Non-fatal by design: any failure is logged and swallowed so it never blocks
 * the signup/member-creation flow. Returns a small summary for logging/tests.
 */
export async function notifyGuestSignup({
  client,
  tenantId,
  member,
  organizationId,
  organizationName,
  guestExpiresAt,
}) {
  try {
    if (!client || !tenantId || !member?.id) {
      return { sent: 0, reason: 'missing-context' };
    }

    const roleIds = await resolveAlertRoleIds(client, tenantId);
    if (!roleIds.length) {
      return { sent: 0, reason: 'no-roles-configured' };
    }

    const recipients = await resolveRecipientEmails(client, tenantId, roleIds);
    if (!recipients.length) {
      return { sent: 0, reason: 'no-recipients' };
    }

    // Resolve organisation name if the caller didn't supply one.
    let resolvedOrgName = organizationName || null;
    const orgIdForLookup = organizationId || member.organization_id || null;
    if (!resolvedOrgName && orgIdForLookup) {
      const { data: orgRow } = await client
        .from('organization')
        .select('name')
        .eq('id', orgIdForLookup)
        .maybeSingle();
      resolvedOrgName = orgRow?.name || null;
    }

    // Mint a single-use token tied to this member + tenant.
    const token = crypto.randomBytes(32).toString('hex');
    const guestName = `${member.first_name || ''} ${member.last_name || ''}`.trim();

    const { error: insertError } = await client
      .from('guest_approval_token')
      .insert({
        token,
        tenant_id: tenantId,
        member_id: member.id,
        organization_id: organizationId || member.organization_id || null,
        guest_name: guestName || null,
        guest_email: member.email || null,
        organization_name: resolvedOrgName || null,
        guest_expires_at: guestExpiresAt || null,
        status: 'pending',
      });

    if (insertError) {
      console.error('[GuestSignupNotify] Failed to create approval token:', insertError.message);
      return { sent: 0, reason: 'token-insert-failed' };
    }

    const { data: tenant } = await client
      .from('tenant')
      .select('name, slug, primary_color')
      .eq('id', tenantId)
      .maybeSingle();

    const tenantSlug = tenant?.slug;
    const baseUrl = tenantSlug
      ? `https://${tenantSlug}.${APP_DOMAIN}`
      : `https://${APP_DOMAIN}`;
    const approveUrl = `${baseUrl}/guest-approval/${token}?action=approve`;
    const denyUrl = `${baseUrl}/guest-approval/${token}?action=deny`;

    const expiryLabel = formatExpiry(guestExpiresAt);
    const html = buildEmailHtml({
      tenantName: tenant?.name,
      primaryColor: tenant?.primary_color,
      guestName,
      guestEmail: member.email,
      organizationName: resolvedOrgName,
      expiryLabel,
      approveUrl,
      denyUrl,
    });

    const subject = `New guest signup awaiting approval${guestName ? `: ${guestName}` : ''}`;

    let sent = 0;
    for (const to of recipients) {
      const result = await sendEmail({
        to,
        subject,
        html,
        tenantId,
      });
      if (result?.success) {
        sent += 1;
      } else {
        console.error(`[GuestSignupNotify] Failed to email ${to}:`, result?.error || 'unknown error');
      }
    }

    console.log(`[GuestSignupNotify] Sent ${sent}/${recipients.length} guest-signup alerts for member ${member.id}`);
    return { sent, recipients: recipients.length };
  } catch (err) {
    console.error('[GuestSignupNotify] Unexpected error:', err);
    return { sent: 0, reason: 'error' };
  }
}
