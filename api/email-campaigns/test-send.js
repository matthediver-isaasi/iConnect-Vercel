import { getTenantContext } from '../_lib/tenantContext.js';
import { getCampaign, generateTrackingToken, rewriteLinksForTracking, getTenantBaseUrl } from '../_lib/campaignService.js';
import { sendEmail } from '../_lib/emailService.js';
import { supabase } from '../_lib/database.js';
import { getHostFromRequest } from '../_lib/tenantResolver.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 25;

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

async function sendTestToRecipient(emailToUse, ctx) {
  const {
    campaign,
    campaignId,
    tenantId,
    tenantSlug,
    member,
    requestHost,
    campaignSkipFooter,
    designHasUnsubscribeBlock,
    campaignContentWidth,
    recipientIndex,
  } = ctx;

  let recipientId;
  let recipientMember = null;

  const { data: memberResults, error: memberError } = await supabase
    .from('member')
    .select('id, first_name, last_name, email')
    .eq('tenant_id', tenantId)
    .eq('email', emailToUse)
    .limit(1);

  if (memberError) {
    console.error('[Test Send] Member lookup error:', memberError);
    return { success: false, email: emailToUse, error: 'Failed to verify recipient' };
  }

  const existingMember = memberResults && memberResults.length > 0 ? memberResults[0] : null;

  if (existingMember) {
    recipientMember = existingMember;

    const { data: existingRecipients, error: recipientLookupError } = await supabase
      .from('email_campaign_recipient')
      .select('id')
      .eq('campaign_id', campaignId)
      .eq('member_id', existingMember.id)
      .limit(1);

    if (recipientLookupError) {
      console.error('[Test Send] Recipient lookup error:', recipientLookupError);
      return { success: false, email: emailToUse, error: 'Failed to check recipient status' };
    }

    if (existingRecipients && existingRecipients.length > 0) {
      recipientId = existingRecipients[0].id;
    } else {
      const { data: newRecipient, error: insertError } = await supabase
        .from('email_campaign_recipient')
        .insert({
          campaign_id: campaignId,
          member_id: existingMember.id,
          email: emailToUse,
          first_name: existingMember.first_name,
          last_name: existingMember.last_name,
          status: 'test',
        })
        .select('id')
        .single();

      if (insertError) {
        console.error('[Test Send] Failed to create recipient record:', insertError);
        return { success: false, email: emailToUse, error: 'Failed to create test recipient record' };
      }
      recipientId = newRecipient.id;
    }
  } else {
    recipientId = `test-${Date.now()}-${recipientIndex}`;
  }

  const firstName = recipientMember?.first_name || member?.first_name || 'Test';
  const lastName = recipientMember?.last_name || member?.last_name || 'User';

  let html = campaign.html_content || '';
  const subject = `[TEST] ${campaign.subject || 'No Subject'}`;

  html = html.replace(/\{\{first_name\}\}/gi, firstName);
  html = html.replace(/\{\{last_name\}\}/gi, lastName);
  html = html.replace(/\{\{email\}\}/gi, emailToUse);

  html = rewriteLinksForTracking(html, campaignId, recipientId, tenantSlug, requestHost);

  const tenantBaseUrl = getTenantBaseUrl(tenantSlug, requestHost);
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

  const result = await sendEmail({
    to: emailToUse,
    subject,
    html,
    from: campaign.from_name ? `${campaign.from_name} <${campaign.from_email}>` : campaign.from_email,
    tenantId,
    skipFooter: campaignSkipFooter,
    contentWidth: campaignContentWidth,
  });

  if (result.success) {
    return { success: true, email: emailToUse, messageId: result.messageId };
  }
  return { success: false, email: emailToUse, error: result.error || 'Failed to send' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId, member } = tenantContext;
  const { campaignId, testEmail, testEmails } = req.body || {};

  if (!campaignId) {
    return res.status(400).json({ error: 'Campaign ID required' });
  }

  const rawInput = (testEmails !== undefined && testEmails !== null)
    ? testEmails
    : (testEmail !== undefined && testEmail !== null ? testEmail : (member?.email ? [member.email] : []));

  const { valid, invalid } = normalizeRecipients(rawInput);

  if (invalid.length > 0) {
    return res.status(400).json({
      error: `Invalid email address${invalid.length > 1 ? 'es' : ''}: ${invalid.join(', ')}`,
      invalidAddresses: invalid,
    });
  }

  if (valid.length === 0) {
    return res.status(400).json({ error: 'Test email address required' });
  }

  if (valid.length > MAX_RECIPIENTS) {
    return res.status(400).json({
      error: `Too many recipients. A maximum of ${MAX_RECIPIENTS} test recipients is allowed.`,
    });
  }

  try {
    const { success, campaign, error } = await getCampaign(campaignId, tenantId);
    if (!success || !campaign) {
      return res.status(404).json({ error: error || 'Campaign not found' });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();

    const tenantSlug = tenant?.slug || '';
    const requestHost = getHostFromRequest(req);

    let campaignSkipFooter = false;
    let designHasUnsubscribeBlock = false;
    let campaignContentWidth = null;
    if (campaign.design_json) {
      campaignSkipFooter = true;
      try {
        const designData = typeof campaign.design_json === 'string'
          ? JSON.parse(campaign.design_json)
          : campaign.design_json;
        if (designData?.globalStyles?.contentWidth) {
          campaignContentWidth = designData.globalStyles.contentWidth;
        }
        if (designData?.blocks) {
          designHasUnsubscribeBlock = checkForUnsubscribe(designData.blocks);
        }
      } catch (e) {}
    }

    const ctxBase = {
      campaign,
      campaignId,
      tenantId,
      tenantSlug,
      member,
      requestHost,
      campaignSkipFooter,
      designHasUnsubscribeBlock,
      campaignContentWidth,
    };

    const results = [];
    for (let i = 0; i < valid.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await sendTestToRecipient(valid[i], { ...ctxBase, recipientIndex: i });
      results.push(r);
    }

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    let message;
    if (failed.length === 0) {
      if (succeeded.length === 1) {
        message = `Test email sent to ${succeeded[0].email}`;
      } else {
        message = `Test email sent to ${succeeded.length} recipients`;
      }
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

    if (succeeded.length === 0) {
      return res.status(500).json({ ...responseBody, error: message });
    }
    return res.json(responseBody);
  } catch (err) {
    console.error('[Test Send] Error:', err);
    return res.status(500).json({ error: 'Failed to send test email' });
  }
}
