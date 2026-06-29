import { supabase } from '../_lib/database.js';
import { sendEmail } from '../_lib/emailService.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Returns the set of members in a tenant who should receive support notifications:
 * - Members whose role does NOT exclude 'support.management'
 * - Members whose role does NOT exclude 'admin.role-management' (tenant admins)
 * Both sets are included; duplicates are de-duped by member id.
 * Returns an array of { id, email, first_name, last_name }.
 */
export async function resolveSupportRecipients(tenantId) {
  if (!supabase || !tenantId) return [];

  try {
    const { data: roles, error: rolesErr } = await supabase
      .from('role')
      .select('id, excluded_features')
      .eq('tenant_id', tenantId);

    if (rolesErr || !roles) {
      console.error('[SupportNotify] Error fetching roles:', rolesErr);
      return [];
    }

    // Roles that grant support management or tenant admin access
    const eligibleRoleIds = roles
      .filter(r => {
        const excluded = r.excluded_features || [];
        const hasSupportAccess = !isResourceExcluded(excluded, 'support.management');
        const hasAdminAccess = !isResourceExcluded(excluded, 'admin.role-management');
        return hasSupportAccess || hasAdminAccess;
      })
      .map(r => r.id);

    if (eligibleRoleIds.length === 0) {
      console.log('[SupportNotify] No eligible roles found in tenant', tenantId);
      return [];
    }

    const { data: members, error: membersErr } = await supabase
      .from('member')
      .select('id, email, first_name, last_name')
      .eq('tenant_id', tenantId)
      .in('role_id', eligibleRoleIds)
      .not('email', 'is', null);

    if (membersErr) {
      console.error('[SupportNotify] Error fetching support/admin members:', membersErr);
      return [];
    }

    // De-duplicate by id (a member could match both criteria if union query returns dupes)
    const seen = new Set();
    return (members || []).filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  } catch (err) {
    console.error('[SupportNotify] resolveSupportRecipients error:', err);
    return [];
  }
}

/**
 * Resolve the member who submitted a ticket (by submitter_email within the tenant).
 * Returns { id, email, first_name, last_name } or null.
 */
async function resolveTicketSubmitter(tenantId, ticket) {
  if (!supabase) return null;
  if (!ticket?.submitter_email) return null;
  try {
    const { data: member } = await supabase
      .from('member')
      .select('id, email, first_name, last_name')
      .eq('tenant_id', tenantId)
      .ilike('email', ticket.submitter_email)
      .maybeSingle();
    return member || null;
  } catch (err) {
    console.error('[SupportNotify] resolveTicketSubmitter error:', err);
    return null;
  }
}

/**
 * Create inbox items and send emails for a support ticket event.
 * Failures are logged but do not throw (non-blocking, fire-and-forget safe).
 *
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.ticketId
 * @param {string} opts.eventType  'new_ticket' | 'user_reply' | 'admin_reply'
 * @param {string|null} opts.performedByMemberId  Exclude this member from the fan-out
 * @param {object} opts.metadata  Extra data stored in the inbox item and used in emails
 */
export async function sendSupportNotification({ tenantId, ticketId, eventType, performedByMemberId = null, metadata = {} }) {
  if (!supabase || !tenantId || !ticketId) return;

  const failedDeliveries = [];

  try {
    const { data: ticket, error: ticketErr } = await supabase
      .from('support_ticket')
      .select('id, subject, description, type, severity, status, submitter_name, submitter_email')
      .eq('id', ticketId)
      .maybeSingle();

    if (ticketErr || !ticket) {
      console.warn('[SupportNotify] Ticket not found, skipping notification:', ticketId, ticketErr?.message);
      return;
    }

    let recipients = [];

    if (eventType === 'admin_reply') {
      // Notify the ticket submitter only
      const submitter = await resolveTicketSubmitter(tenantId, ticket);
      if (submitter) {
        recipients = [submitter];
      } else if (ticket.submitter_email) {
        // Submitter is not a registered member — send email only, no inbox row
        const emailOnly = [{
          id: null,
          email: ticket.submitter_email,
          first_name: ticket.submitter_name || '',
          last_name: '',
        }];
        const failures = await fanOutNotifications({ tenantId, ticket, eventType, recipients: emailOnly, performedByMemberId, metadata });
        if (failures.length > 0) {
          console.error(`[SupportNotify] ${failures.length} email failure(s) for admin_reply on ticket ${ticketId}:`, failures);
        }
        return;
      }
    } else {
      // new_ticket or user_reply: notify support-management + admin members
      recipients = await resolveSupportRecipients(tenantId);
    }

    if (recipients.length === 0) {
      console.log(`[SupportNotify] No recipients for ${eventType} on ticket ${ticketId}`);
      return;
    }

    const failures = await fanOutNotifications({ tenantId, ticket, eventType, recipients, performedByMemberId, metadata });
    if (failures.length > 0) {
      console.error(`[SupportNotify] ${failures.length} delivery failure(s) for ${eventType} on ticket ${ticketId}:`, failures);
    } else {
      console.log(`[SupportNotify] ${eventType} notifications sent for ticket ${ticketId} to ${recipients.length} potential recipient(s)`);
    }
  } catch (err) {
    console.error('[SupportNotify] sendSupportNotification error:', err);
  }
}

/**
 * Fan out inbox items + emails to a list of recipients.
 * Returns an array of { email, reason } for any failed deliveries.
 */
async function fanOutNotifications({ tenantId, ticket, eventType, recipients, performedByMemberId, metadata }) {
  const appUrl = (process.env.VITE_APP_URL || process.env.APP_URL || '').replace(/\/$/, '');
  const failures = [];

  for (const recipient of recipients) {
    // Don't notify the person who triggered the event
    if (recipient.id && performedByMemberId && recipient.id === performedByMemberId) {
      continue;
    }
    if (!recipient.email) continue;

    // Create in-app inbox item (only for registered members)
    if (recipient.id) {
      const { error: inboxErr } = await supabase
        .from('support_inbox_item')
        .insert({
          tenant_id: tenantId,
          ticket_id: ticket.id,
          recipient_member_id: recipient.id,
          event_type: eventType,
          metadata: {
            ticket_subject: ticket.subject,
            ticket_type: ticket.type,
            ticket_severity: ticket.severity,
            submitter_name: ticket.submitter_name,
            ...metadata,
          },
        });

      if (inboxErr) {
        console.error(`[SupportNotify] Failed to create inbox item for member ${recipient.id}:`, inboxErr.message);
        failures.push({ email: recipient.email, reason: `inbox insert: ${inboxErr.message}` });
        // Continue — still attempt email delivery even if inbox write failed
      }
    }

    // Send email — MUST inspect return value (sendEmail never throws)
    const { subject, html } = buildEmailContent({ eventType, ticket, recipient, appUrl, metadata });
    const emailResult = await sendEmail({
      to: recipient.email,
      subject,
      html,
      tenantId,
      skipFooter: false,
    });

    if (!emailResult.success) {
      const reason = emailResult.error || emailResult.status || 'unknown';
      console.error(`[SupportNotify] Email failed for ${recipient.email}: ${reason}`);
      failures.push({ email: recipient.email, reason: `email: ${reason}` });
    } else {
      console.log(`[SupportNotify] Sent ${eventType} email to ${recipient.email}`);
    }
  }

  return failures;
}

function buildEmailContent({ eventType, ticket, recipient, appUrl, metadata }) {
  const safeSubject = escapeHtml(ticket.subject || 'Support Ticket');
  const safeType = escapeHtml(ticket.type || 'general');
  const safeSeverity = escapeHtml(ticket.severity || '');
  const safeSubmitter = escapeHtml(ticket.submitter_name || ticket.submitter_email || 'A member');
  const safeRecipient = escapeHtml(
    [recipient.first_name, recipient.last_name].filter(Boolean).join(' ') || 'there'
  );
  const descriptionExcerpt = escapeHtml((ticket.description || '').substring(0, 300));
  const replyExcerpt = metadata.reply_excerpt
    ? escapeHtml(String(metadata.reply_excerpt).substring(0, 300))
    : null;
  const ticketId = escapeHtml(ticket.id || '');

  // Build page-specific deep-links
  const managementPageUrl = appUrl ? `${appUrl}/support-management` : '';
  const submitterPageUrl = appUrl ? `${appUrl}/support` : '';

  let emailSubject = '';
  let intro = '';
  let bodyDetail = '';
  let ctaUrl = '';
  let ctaLabel = '';

  switch (eventType) {
    case 'new_ticket':
      emailSubject = `New support ticket: ${ticket.subject}`;
      intro = `A new support ticket has been submitted by <strong>${safeSubmitter}</strong>.`;
      bodyDetail = descriptionExcerpt
        ? `<blockquote style="color:#555;font-size:14px;border-left:3px solid #e2e8f0;padding-left:12px;margin:16px 0;">${descriptionExcerpt}</blockquote>`
        : '';
      ctaUrl = managementPageUrl;
      ctaLabel = 'View in Support Management';
      break;
    case 'user_reply':
      emailSubject = `New reply on support ticket: ${ticket.subject}`;
      intro = `<strong>${safeSubmitter}</strong> has added a reply to support ticket <em>${safeSubject}</em>.`;
      bodyDetail = replyExcerpt
        ? `<blockquote style="color:#555;font-size:14px;border-left:3px solid #e2e8f0;padding-left:12px;margin:16px 0;">${replyExcerpt}</blockquote>`
        : '';
      ctaUrl = managementPageUrl;
      ctaLabel = 'View in Support Management';
      break;
    case 'admin_reply':
      emailSubject = `Update on your support ticket: ${ticket.subject}`;
      intro = `There is a new response on your support ticket <em>${safeSubject}</em>.`;
      bodyDetail = replyExcerpt
        ? `<blockquote style="color:#555;font-size:14px;border-left:3px solid #e2e8f0;padding-left:12px;margin:16px 0;">${replyExcerpt}</blockquote>`
        : '';
      ctaUrl = submitterPageUrl;
      ctaLabel = 'View your support tickets';
      break;
    default:
      emailSubject = `Support ticket update: ${ticket.subject}`;
      intro = `There has been an update on a support ticket.`;
      ctaUrl = managementPageUrl || submitterPageUrl;
      ctaLabel = 'View support';
  }

  const ticketMeta = [
    safeType && `<strong>Type:</strong> ${safeType}`,
    safeSeverity && `<strong>Severity:</strong> ${safeSeverity}`,
    eventType !== 'admin_reply' && `<strong>From:</strong> ${safeSubmitter}`,
    ticketId && `<strong>Ticket ID:</strong> <code style="font-size:12px;">${ticketId}</code>`,
  ]
    .filter(Boolean)
    .join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  const linkSection = ctaUrl
    ? `<p style="margin-top:24px;"><a href="${ctaUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:14px;">${ctaLabel}</a></p>`
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#1e293b;margin-bottom:4px;">${escapeHtml(emailSubject)}</h2>
      <p style="color:#64748b;font-size:13px;margin-bottom:20px;">${ticketMeta}</p>
      <p style="color:#334155;font-size:15px;line-height:1.6;">Hi ${safeRecipient},</p>
      <p style="color:#334155;font-size:15px;line-height:1.6;">${intro}</p>
      ${bodyDetail}
      ${linkSection}
      <p style="color:#94a3b8;font-size:12px;margin-top:32px;">This is an automated notification from the support system.</p>
    </div>
  `;

  return { subject: emailSubject, html };
}

export default async function handler(req, res) {
  return res.status(404).json({ error: 'Not found' });
}
