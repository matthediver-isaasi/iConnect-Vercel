import { getTenantContext } from '../_lib/tenantContext.js';
import { getCampaign, generateTrackingToken, rewriteLinksForTracking, getTenantBaseUrl } from '../_lib/campaignService.js';
import { sendEmail } from '../_lib/emailService.js';
import { supabase } from '../_lib/database.js';
import { getHostFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId, member } = tenantContext;
  const { campaignId, testEmail } = req.body;

  if (!campaignId) {
    return res.status(400).json({ error: 'Campaign ID required' });
  }

  const emailToUse = testEmail || member?.email;
  if (!emailToUse) {
    return res.status(400).json({ error: 'Test email address required' });
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
      return res.status(500).json({ 
        error: 'Failed to verify recipient. Please try again.' 
      });
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
        return res.status(500).json({ 
          error: 'Failed to check recipient status. Please try again.' 
        });
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
            status: 'test'
          })
          .select('id')
          .single();

        if (insertError) {
          console.error('[Test Send] Failed to create recipient record:', insertError);
          return res.status(500).json({ 
            error: 'Failed to create test recipient record. Please try again.' 
          });
        }
        recipientId = newRecipient.id;
      }
    } else {
      recipientId = 'test-' + Date.now();
    }

    const firstName = recipientMember?.first_name || member?.first_name || 'Test';
    const lastName = recipientMember?.last_name || member?.last_name || 'User';

    let html = campaign.html_content || '';
    let subject = `[TEST] ${campaign.subject || 'No Subject'}`;

    html = html.replace(/\{\{first_name\}\}/gi, firstName);
    html = html.replace(/\{\{last_name\}\}/gi, lastName);
    html = html.replace(/\{\{email\}\}/gi, emailToUse);

    const requestHost = getHostFromRequest(req);
    html = rewriteLinksForTracking(html, campaignId, recipientId, tenantSlug, requestHost);

    const tenantBaseUrl = getTenantBaseUrl(tenantSlug, requestHost);
    const preferencesUrl = `${tenantBaseUrl}/api/email-preferences?t=${generateTrackingToken(campaignId, recipientId, 0)}`;
    const unsubscribeLink = `<a href="${preferencesUrl}" style="color: #666;">Unsubscribe</a>`;
    
    const hasUnsubscribePlaceholder = /\{\{unsubscribe_link\}\}/i.test(html) || /\{\{unsubscribe_url\}\}/i.test(html);
    
    html = html.replace(/\{\{unsubscribe_link\}\}/gi, unsubscribeLink);
    html = html.replace(/\{\{unsubscribe_url\}\}/gi, preferencesUrl);
    
    if (!hasUnsubscribePlaceholder) {
      html += `<p style="margin-top: 20px; font-size: 12px; color: #666; text-align: center;">
        <a href="${preferencesUrl}" style="color: #666;">Manage email preferences</a>
      </p>`;
    }

    const result = await sendEmail({
      to: emailToUse,
      subject: subject,
      html: html,
      from: campaign.from_name ? `${campaign.from_name} <${campaign.from_email}>` : campaign.from_email,
      tenantId: tenantId
    });

    if (result.success) {
      return res.json({ 
        success: true, 
        message: `Test email sent to ${emailToUse}`,
        messageId: result.messageId
      });
    } else {
      return res.status(500).json({ error: result.error || 'Failed to send test email' });
    }
  } catch (err) {
    console.error('[Test Send] Error:', err);
    return res.status(500).json({ error: 'Failed to send test email' });
  }
}
