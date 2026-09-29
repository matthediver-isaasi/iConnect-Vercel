import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  getCampaign,
  rewriteLinksForTracking,
  validateCampaignSenderEmail,
  sendToRecipient,
} from '../_lib/campaignService.js';
import { campaignTestAudience, selectCampaignTestSource, searchCampaignTestSources } from '../_lib/campaignTestSource.js';
import { sendEmail } from '../_lib/emailService.js';
import { supabase } from '../_lib/database.js';
import { getHostFromRequest } from '../_lib/tenantResolver.js';
import { resolveCampaignEventSurvey, replaceEventSurvey } from '../_lib/campaignEventSurvey.js';
import { resolveCampaignEventSponsors, replaceEventSponsors } from '../_lib/eventEmailSponsors.js';
import { getCampaignEmailComposition } from '../_lib/campaignEmailComposition.js';

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

async function sendTestToRecipient(emailToUse, ctx) {
  const {
    campaign,
    campaignId,
    tenantId,
    tenantSlug,
    member,
    requestHost,
    campaignSkipFooter,
    campaignContentWidth,
    recipientIndex,
  } = ctx;

  // Test sends are deliberately hermetic: never create or reuse a campaign
  // recipient row merely to mint actionable preference credentials.
  const recipientId = `test-${Date.now()}-${recipientIndex}`;
  const firstName = member?.first_name || 'Test';
  const lastName = member?.last_name || 'User';

  let html = campaign.html_content || '';
  const subject = `[TEST] ${campaign.subject || 'No Subject'}`;

  html = html.replace(/\{\{first_name\}\}/gi, firstName);
  html = html.replace(/\{\{last_name\}\}/gi, lastName);
  html = html.replace(/\{\{email\}\}/gi, emailToUse);

  html = rewriteLinksForTracking(html, campaignId, recipientId, tenantSlug, requestHost);

  const result = await sendEmail({
    to: emailToUse,
    subject,
    html,
    from: campaign.from_name ? `${campaign.from_name} <${campaign.from_email}>` : campaign.from_email,
    tenantId,
    skipFooter: campaignSkipFooter,
    contentWidth: campaignContentWidth,
    campaignPreferences: {
      // Keep the final footer/body shape visible without exposing a link backed
      // by the synthetic, unpersisted test recipient id.
      preferencesUrl: '#',
    },
    resolveTransactionalPreferences: false,
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
  if (!await hasAdminAccess(tenantContext)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { campaignId, testEmail, testEmails, sourceRecipientEmail, action, search, offset } = req.body || {};

  if (!campaignId) {
    return res.status(400).json({ error: 'Campaign ID required' });
  }

  if (action === 'search-sources') {
    res.setHeader('Cache-Control', 'no-store');
    const result = await getCampaign(campaignId, tenantId);
    if (!result.success || !result.campaign) return res.status(404).json({ error: 'Campaign not found' });
    try {
      return res.json(searchCampaignTestSources(await campaignTestAudience(result.campaign, tenantId), search, offset));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
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
    let sourceRecipient = null;
    if (sourceRecipientEmail !== undefined && sourceRecipientEmail !== null) {
      try {
        sourceRecipient = selectCampaignTestSource(await campaignTestAudience(campaign, tenantId), sourceRecipientEmail);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
    try {
      // The source path resolves dynamic slots and event context in the live pipeline.
      if (!sourceRecipient) {
        const surveyUrl = await resolveCampaignEventSurvey(supabase, campaign, tenantId);
        const sponsors = await resolveCampaignEventSponsors(supabase, campaign, tenantId);
        if (sponsors !== null) campaign.html_content = replaceEventSponsors(campaign.html_content, sponsors);
        if (surveyUrl) {
          campaign.html_content = replaceEventSurvey(campaign.html_content, surveyUrl);
          campaign.subject = replaceEventSurvey(campaign.subject, surveyUrl);
        }
      }
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const senderValidation = validateCampaignSenderEmail(campaign.from_email);
    if (!senderValidation.valid) {
      return res.status(400).json({
        error: senderValidation.error,
        code: 'INVALID_SENDER_EMAIL',
      });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();

    const tenantSlug = tenant?.slug || '';
    const requestHost = getHostFromRequest(req);

    const composition = getCampaignEmailComposition(campaign);
    const campaignSkipFooter = composition.skipFooter;
    const campaignContentWidth = composition.contentWidth;

    const ctxBase = {
      campaign,
      campaignId,
      tenantId,
      tenantSlug,
      member,
      requestHost,
      campaignSkipFooter,
      campaignContentWidth,
    };

    const results = [];
    for (let i = 0; i < valid.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = sourceRecipient
        ? { ...await sendToRecipient(sourceRecipient, campaign, tenantId, tenantSlug, requestHost, composition, valid[i]), email: valid[i] }
        : await sendTestToRecipient(valid[i], { ...ctxBase, recipientIndex: i });
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
