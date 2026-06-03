import { supabase } from '../_lib/database.js';
import { getCallerEmsAccess, requireGroupAccess } from '../_lib/memberGroupEmsAccess.js';
import {
  getCampaign,
  generateTrackingToken,
  rewriteLinksForTracking,
  getTenantBaseUrl,
  applyDynamicSlotValues,
} from '../_lib/campaignService.js';
import { sendEmail } from '../_lib/emailService.js';
import { getHostFromRequest } from '../_lib/tenantResolver.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 5; // tighter cap than the tenant test-send (25)

function normalizeRecipients(input) {
  const raw = Array.isArray(input) ? input : (typeof input === 'string' ? [input] : []);
  const seen = new Set();
  const valid = [];
  const invalid = [];
  raw.forEach((item) => {
    if (typeof item !== 'string') return;
    item.split(',').forEach((part) => {
      const trimmed = part.trim();
      if (!trimmed) return;
      const lower = trimmed.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      if (EMAIL_REGEX.test(trimmed)) valid.push(trimmed);
      else invalid.push(trimmed);
    });
  });
  return { valid, invalid };
}

function checkForUnsubscribe(blocks) {
  if (!Array.isArray(blocks)) return false;
  for (const block of blocks) {
    if (block.type === 'unsubscribe') return true;
    if (block.children && checkForUnsubscribe(block.children)) return true;
    if (block.columns) {
      for (const col of block.columns) {
        if (checkForUnsubscribe(col.blocks)) return true;
      }
    }
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const access = await getCallerEmsAccess(req);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (access.groups.length === 0) return res.status(403).json({ error: 'You do not have permission to send group emails.' });

  const { campaignId, testEmail, testEmails } = req.body || {};
  if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });

  // Verify ownership.
  const { data: row, error: rowErr } = await supabase
    .from('email_campaign')
    .select('id, created_by_member_id, member_group_id, tenant_id')
    .eq('id', campaignId)
    .eq('tenant_id', access.tenantContext.tenantId)
    .single();
  if (rowErr || !row) return res.status(404).json({ error: 'Campaign not found' });
  if (row.created_by_member_id !== access.memberId) return res.status(404).json({ error: 'Campaign not found' });
  if (!requireGroupAccess(access.groups, row.member_group_id)) {
    return res.status(403).json({ error: 'You do not have access to this campaign.' });
  }

  const { tenantContext, memberId } = access;
  const callerEmail = tenantContext.member?.email || null;

  const rawInput = (testEmails !== undefined && testEmails !== null)
    ? testEmails
    : (testEmail !== undefined && testEmail !== null ? testEmail : (callerEmail ? [callerEmail] : []));
  const { valid, invalid } = normalizeRecipients(rawInput);

  if (invalid.length > 0) {
    return res.status(400).json({
      error: `Invalid email address${invalid.length > 1 ? 'es' : ''}: ${invalid.join(', ')}`,
      invalidAddresses: invalid,
    });
  }
  if (valid.length === 0) return res.status(400).json({ error: 'Test email address required' });
  if (valid.length > MAX_RECIPIENTS) {
    return res.status(400).json({
      error: `Too many recipients. A maximum of ${MAX_RECIPIENTS} test recipients is allowed.`,
    });
  }

  try {
    const { success, campaign, error } = await getCampaign(campaignId, tenantContext.tenantId);
    if (!success || !campaign) return res.status(404).json({ error: error || 'Campaign not found' });

    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantContext.tenantId)
      .single();

    const tenantSlug = tenant?.slug || '';
    const requestHost = getHostFromRequest(req);

    let campaignSkipFooter = false;
    let designHasUnsubscribeBlock = false;
    let campaignContentWidth = null;
    let campaignSlotValues = null;
    if (campaign.design_json) {
      campaignSkipFooter = true;
      try {
        const designData = typeof campaign.design_json === 'string'
          ? JSON.parse(campaign.design_json)
          : campaign.design_json;
        if (designData?.globalStyles?.contentWidth) campaignContentWidth = designData.globalStyles.contentWidth;
        if (designData?.blocks) designHasUnsubscribeBlock = checkForUnsubscribe(designData.blocks);
        if (designData?.slotValues && typeof designData.slotValues === 'object') campaignSlotValues = designData.slotValues;
      } catch (_e) {}
    }

    const tenantBaseUrl = getTenantBaseUrl(tenantSlug, requestHost);
    const results = [];

    for (let i = 0; i < valid.length; i++) {
      const emailToUse = valid[i];

      // We do NOT insert an email_campaign_recipient row here — keep test
      // sends fully hermetic for the member-side path.
      const recipientId = `member-test-${Date.now()}-${memberId}-${i}`;

      let html = campaign.html_content || '';
      if (campaignSlotValues) html = applyDynamicSlotValues(html, campaignSlotValues);
      const subject = `[TEST] ${applyDynamicSlotValues(campaign.subject || 'No Subject', campaignSlotValues)}`;
      html = html.replace(/\{\{first_name\}\}/gi, 'Test');
      html = html.replace(/\{\{last_name\}\}/gi, 'User');
      html = html.replace(/\{\{email\}\}/gi, emailToUse);
      html = rewriteLinksForTracking(html, campaignId, recipientId, tenantSlug, requestHost);

      const preferencesUrl = `${tenantBaseUrl}/email-preferences?t=${generateTrackingToken(campaignId, recipientId, 0)}`;
      const unsubscribeLink = `<a href="${preferencesUrl}" style="color: #666;">Unsubscribe</a>`;
      const hasUnsubscribePlaceholder = /\{\{unsubscribe_link\}\}/i.test(html) || /\{\{unsubscribe_url\}\}/i.test(html);
      html = html.replace(/\{\{unsubscribe_link\}\}/gi, unsubscribeLink);
      html = html.replace(/\{\{unsubscribe_url\}\}/gi, preferencesUrl);
      const commPreferencesLink = `<a href="${preferencesUrl}" style="color: #666;">Manage communication preferences</a>`;
      html = html.replace(/\{\{communication_preferences_link\}\}/gi, commPreferencesLink);
      html = html.replace(/\{\{communication_preferences_url\}\}/gi, preferencesUrl);
      if (!hasUnsubscribePlaceholder && !designHasUnsubscribeBlock) {
        html += `<p style="margin-top: 20px; font-size: 12px; color: #666; text-align: center;">
          <a href="${preferencesUrl}" style="color: #666;">Manage email preferences</a>
        </p>`;
      }

      const sendResult = await sendEmail({
        to: emailToUse,
        subject,
        html,
        from: campaign.from_name ? `${campaign.from_name} <${campaign.from_email}>` : campaign.from_email,
        tenantId: tenantContext.tenantId,
        skipFooter: campaignSkipFooter,
        contentWidth: campaignContentWidth,
      });

      results.push(sendResult.success
        ? { success: true, email: emailToUse, messageId: sendResult.messageId }
        : { success: false, email: emailToUse, error: sendResult.error || 'Failed to send' });
    }

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    let message;
    if (failed.length === 0) {
      message = succeeded.length === 1 ? `Test email sent to ${succeeded[0].email}` : `Test email sent to ${succeeded.length} recipients`;
    } else if (succeeded.length === 0) {
      message = `Failed to send test email to ${failed.length === 1 ? failed[0].email : `all ${failed.length} recipients`}`;
    } else {
      message = `Test email sent to ${succeeded.length} of ${results.length} recipients (${failed.length} failed)`;
    }

    const responseBody = {
      success: succeeded.length > 0,
      message,
      total: results.length,
      succeededCount: succeeded.length,
      failedCount: failed.length,
      sentTo: succeeded.map((r) => r.email),
      failures: failed.map((r) => ({ email: r.email, error: r.error })),
      invalidAddresses: invalid,
    };
    if (succeeded.length === 0) return res.status(500).json({ ...responseBody, error: message });
    return res.json(responseBody);
  } catch (err) {
    console.error('[MemberCampaigns Test Send] Error:', err);
    return res.status(500).json({ error: 'Failed to send test email' });
  }
}
