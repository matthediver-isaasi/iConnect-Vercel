import { supabase } from '../_lib/database.js';
import { sendEmail } from '../_lib/emailService.js';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendBriefNotification({ tenantId, briefId, eventType, performedById, metadata = {} }) {
  if (!supabase) {
    console.log('[BriefNotify] No database configured, skipping notification');
    return;
  }

  try {
    const { data: settings } = await supabase
      .from('article_brief_settings')
      .select('notify_reviewer, notify_writer, stages')
      .eq('tenant_id', tenantId)
      .single();

    if (!settings) {
      console.log('[BriefNotify] No settings found for tenant, skipping notification');
      return;
    }

    const { data: brief } = await supabase
      .from('article_brief')
      .select('id, title, status, assigned_writer_id, review_owner_id')
      .eq('id', briefId)
      .eq('tenant_id', tenantId)
      .single();

    if (!brief) {
      console.log('[BriefNotify] Brief not found, skipping notification');
      return;
    }

    const stages = settings.stages || [];
    const getStageLabel = (key) => {
      const stage = stages.find(s => s.key === key);
      return stage ? stage.label : key;
    };

    const notifications = [];

    if (settings.notify_writer && brief.assigned_writer_id) {
      const shouldNotifyWriter =
        eventType === 'writer_assigned' ||
        eventType === 'status_changed_to_changes_requested' ||
        eventType === 'comment_added' ||
        eventType === 'brief_updated';

      if (shouldNotifyWriter) {
        notifications.push({
          recipientId: brief.assigned_writer_id,
          type: 'writer',
        });
      }
    }

    if (settings.notify_reviewer && brief.review_owner_id) {
      const shouldNotifyReviewer =
        eventType === 'version_uploaded' ||
        eventType === 'status_changed_to_review' ||
        eventType === 'brief_updated';

      if (shouldNotifyReviewer) {
        notifications.push({
          recipientId: brief.review_owner_id,
          type: 'reviewer',
        });
      }
    }

    if (notifications.length === 0) {
      console.log(`[BriefNotify] No notifications to send for event: ${eventType}`);
      return;
    }

    const recipientIds = notifications.map(n => n.recipientId).filter(Boolean);
    const { data: members } = await supabase
      .from('member')
      .select('id, email, full_name')
      .in('id', recipientIds);

    if (!members || members.length === 0) {
      console.log('[BriefNotify] No member emails found, skipping');
      return;
    }

    const memberMap = {};
    for (const m of members) {
      memberMap[m.id] = m;
    }

    for (const notification of notifications) {
      const member = memberMap[notification.recipientId];
      if (!member || !member.email) continue;

      if (member.id === performedById) continue;

      const { subject, html } = buildEmailContent({
        eventType,
        briefTitle: brief.title,
        recipientName: member.full_name || 'there',
        recipientType: notification.type,
        metadata,
        getStageLabel,
      });

      try {
        await sendEmail({
          to: member.email,
          subject,
          html,
          tenantId,
          skipFooter: false,
        });
        console.log(`[BriefNotify] Sent ${eventType} email to ${member.email}`);
      } catch (emailErr) {
        console.error(`[BriefNotify] Failed to send email to ${member.email}:`, emailErr);
      }
    }
  } catch (err) {
    console.error('[BriefNotify] Error sending notification:', err);
  }
}

function buildEmailContent({ eventType, briefTitle, recipientName, recipientType, metadata, getStageLabel }) {
  const safeBriefTitle = escapeHtml(briefTitle);
  const safeRecipientName = escapeHtml(recipientName);

  let subject = '';
  let bodyText = '';

  switch (eventType) {
    case 'writer_assigned':
      subject = `You've been assigned to: ${safeBriefTitle}`;
      bodyText = `You have been assigned as the writer for the brief "<strong>${safeBriefTitle}</strong>".`;
      break;

    case 'status_changed_to_changes_requested':
      subject = `Changes requested: ${safeBriefTitle}`;
      bodyText = `The brief "<strong>${safeBriefTitle}</strong>" has been moved to "<strong>${escapeHtml(getStageLabel(metadata.new_status || 'changes_requested'))}</strong>". Please review the feedback and submit a revised version.`;
      break;

    case 'comment_added':
      subject = `New comment on: ${safeBriefTitle}`;
      bodyText = `A new comment has been added to the brief "<strong>${safeBriefTitle}</strong>".`;
      if (metadata.comment_preview) {
        bodyText += `<br/><br/><em>"${escapeHtml(metadata.comment_preview)}"</em>`;
      }
      break;

    case 'version_uploaded':
      subject = `New version submitted: ${safeBriefTitle}`;
      bodyText = `A new version (v${escapeHtml(String(metadata.version_number || '?'))}) has been uploaded for the brief "<strong>${safeBriefTitle}</strong>". Please review the submission.`;
      break;

    case 'status_changed_to_review':
      subject = `Brief submitted for review: ${safeBriefTitle}`;
      bodyText = `The brief "<strong>${safeBriefTitle}</strong>" has been submitted for review and is now in the "<strong>${escapeHtml(getStageLabel(metadata.new_status || 'under_review'))}</strong>" stage.`;
      break;

    case 'brief_updated':
      subject = `Brief updated: ${safeBriefTitle}`;
      bodyText = `The brief "<strong>${safeBriefTitle}</strong>" has been updated.`;
      if (metadata.changed_fields && metadata.changed_fields.length > 0) {
        const fieldLabels = metadata.changed_fields.map(f => escapeHtml(f));
        bodyText += `<br/><br/>Updated fields: ${fieldLabels.join(', ')}.`;
      }
      bodyText += `<br/><br/>Please log in to review the latest changes.`;
      break;

    default:
      subject = `Brief update: ${safeBriefTitle}`;
      bodyText = `There has been an update to the brief "<strong>${safeBriefTitle}</strong>".`;
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #333; margin-bottom: 16px;">${subject}</h2>
      <p style="color: #555; font-size: 15px; line-height: 1.6;">
        Hi ${safeRecipientName},
      </p>
      <p style="color: #555; font-size: 15px; line-height: 1.6;">
        ${bodyText}
      </p>
      <p style="color: #888; font-size: 13px; margin-top: 24px;">
        This is an automated notification from the brief management system.
      </p>
    </div>
  `;

  return { subject, html };
}

export default async function handler(req, res) {
  return res.status(404).json({ error: 'Not found' });
}
