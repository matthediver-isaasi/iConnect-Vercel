import { supabase } from './database.js';
import { sendEmail } from './emailService.js';
import crypto from 'crypto';

const APP_URL = process.env.APP_URL || process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:5000';

export async function getCampaigns(tenantId, options = {}) {
  if (!supabase || !tenantId) {
    return { success: false, error: 'Database not configured or missing tenant' };
  }

  try {
    let query = supabase
      .from('email_campaign')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (options.status) {
      query = query.eq('status', options.status);
    }

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) throw error;
    return { success: true, campaigns: data || [] };
  } catch (err) {
    console.error('[Campaign Service] Error fetching campaigns:', err);
    return { success: false, error: err.message };
  }
}

export async function getCampaign(campaignId, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data, error } = await supabase
      .from('email_campaign')
      .select('*')
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .single();

    if (error) throw error;
    return { success: true, campaign: data };
  } catch (err) {
    console.error('[Campaign Service] Error fetching campaign:', err);
    return { success: false, error: err.message };
  }
}

export async function createCampaign(campaignData, tenantId, createdBy) {
  if (!supabase || !tenantId) {
    return { success: false, error: 'Database not configured or missing tenant' };
  }

  try {
    const { data, error } = await supabase
      .from('email_campaign')
      .insert({
        ...campaignData,
        tenant_id: tenantId,
        created_by: createdBy,
        status: 'draft'
      })
      .select()
      .single();

    if (error) throw error;
    return { success: true, campaign: data };
  } catch (err) {
    console.error('[Campaign Service] Error creating campaign:', err);
    return { success: false, error: err.message };
  }
}

export async function updateCampaign(campaignId, updates, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data, error } = await supabase
      .from('email_campaign')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw error;
    return { success: true, campaign: data };
  } catch (err) {
    console.error('[Campaign Service] Error updating campaign:', err);
    return { success: false, error: err.message };
  }
}

export async function deleteCampaign(campaignId, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { error } = await supabase
      .from('email_campaign')
      .delete()
      .eq('id', campaignId)
      .eq('tenant_id', tenantId);

    if (error) throw error;
    return { success: true };
  } catch (err) {
    console.error('[Campaign Service] Error deleting campaign:', err);
    return { success: false, error: err.message };
  }
}

export function generateTrackingToken(campaignId, recipientId, linkIndex) {
  const data = `${campaignId}:${recipientId}:${linkIndex}`;
  return Buffer.from(data).toString('base64url');
}

export function rewriteLinksForTracking(html, campaignId, recipientId, tenantSlug) {
  if (!html) return html;

  const baseUrl = APP_URL;
  let linkIndex = 0;

  const rewritten = html.replace(
    /<a\s+([^>]*href=["'])([^"']+)(["'][^>]*)>/gi,
    (match, prefix, url, suffix) => {
      if (url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:')) {
        return match;
      }

      const token = generateTrackingToken(campaignId, recipientId, linkIndex);
      const trackUrl = `${baseUrl}/api/track/click?t=${token}&url=${encodeURIComponent(url)}`;
      linkIndex++;

      return `<a ${prefix}${trackUrl}${suffix}>`;
    }
  );

  return rewritten;
}

export async function getTargetRecipients(campaign, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const targetType = campaign.target_type;
    const targetIds = campaign.target_ids || [];
    let recipients = [];

    if (targetType === 'communication_category' && targetIds.length > 0) {
      // Get role IDs associated with these categories
      const { data: categoryRoles } = await supabase
        .from('communication_category_role')
        .select('role_id')
        .in('category_id', targetIds);

      const roleIds = [...new Set((categoryRoles || []).map(cr => cr.role_id))];

      if (roleIds.length > 0) {
        // Get members with those roles (exclude deleted emails and those who opted out)
        const { data: members } = await supabase
          .from('member')
          .select('id, email, first_name, last_name, role_id, communications_opted_out_all')
          .eq('tenant_id', tenantId)
          .in('role_id', roleIds)
          .not('email', 'ilike', 'deleted_%@deleted.local');

        // Get members who have explicitly unsubscribed from these categories
        const { data: unsubscribes } = await supabase
          .from('member_communication_preference')
          .select('member_id')
          .in('category_id', targetIds)
          .eq('is_subscribed', false);

        const unsubscribedIds = new Set((unsubscribes || []).map(u => u.member_id));

        recipients = (members || []).filter(m => 
          m.email && 
          !unsubscribedIds.has(m.id) &&
          m.communications_opted_out_all !== true
        );
      }
    } else if (targetType === 'member_group' && targetIds.length > 0) {
      const { data: assignments } = await supabase
        .from('member_group_assignment')
        .select('member_id')
        .in('member_group_id', targetIds);

      const memberIds = [...new Set((assignments || []).map(a => a.member_id))];

      if (memberIds.length > 0) {
        const { data: members } = await supabase
          .from('member')
          .select('id, email, first_name, last_name, communications_opted_out_all')
          .eq('tenant_id', tenantId)
          .in('id', memberIds)
          .not('email', 'ilike', 'deleted_%@deleted.local');

        recipients = (members || []).filter(m => 
          m.email && m.communications_opted_out_all !== true
        );
      }
    } else if (targetType === 'role' && targetIds.length > 0) {
      const { data: members } = await supabase
        .from('member')
        .select('id, email, first_name, last_name, communications_opted_out_all')
        .eq('tenant_id', tenantId)
        .in('role_id', targetIds)
        .not('email', 'ilike', 'deleted_%@deleted.local');

      recipients = (members || []).filter(m => 
        m.email && m.communications_opted_out_all !== true
      );
    } else if (targetType === 'all_members') {
      const { data: members } = await supabase
        .from('member')
        .select('id, email, first_name, last_name, communications_opted_out_all')
        .eq('tenant_id', tenantId)
        .not('email', 'ilike', 'deleted_%@deleted.local');

      recipients = (members || []).filter(m => 
        m.email && m.communications_opted_out_all !== true
      );
    }

    const { data: globalUnsubscribes } = await supabase
      .from('email_unsubscribe')
      .select('email')
      .eq('tenant_id', tenantId)
      .eq('unsubscribe_type', 'all');

    const globalUnsubSet = new Set((globalUnsubscribes || []).map(u => u.email.toLowerCase()));
    recipients = recipients.filter(r => !globalUnsubSet.has(r.email.toLowerCase()));

    const uniqueRecipients = [];
    const seenEmails = new Set();
    for (const r of recipients) {
      const emailLower = r.email.toLowerCase();
      if (!seenEmails.has(emailLower)) {
        seenEmails.add(emailLower);
        uniqueRecipients.push(r);
      }
    }

    return { success: true, recipients: uniqueRecipients };
  } catch (err) {
    console.error('[Campaign Service] Error getting recipients:', err);
    return { success: false, error: err.message };
  }
}

export async function scheduleCampaign(campaignId, tenantId, scheduledAt) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { success, campaign, error } = await getCampaign(campaignId, tenantId);
    if (!success || !campaign) {
      return { success: false, error: error || 'Campaign not found' };
    }

    if (campaign.status !== 'draft') {
      return { success: false, error: `Cannot schedule campaign with status: ${campaign.status}` };
    }

    const { error: updateError } = await supabase
      .from('email_campaign')
      .update({ 
        status: 'scheduled', 
        scheduled_at: scheduledAt.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', campaignId)
      .eq('tenant_id', tenantId);

    if (updateError) {
      throw updateError;
    }

    console.log(`[Campaign Service] Campaign ${campaignId} scheduled for ${scheduledAt.toISOString()}`);
    return { 
      success: true, 
      scheduled: true,
      scheduledAt: scheduledAt.toISOString()
    };
  } catch (err) {
    console.error('[Campaign Service] Error scheduling campaign:', err);
    return { success: false, error: err.message };
  }
}

export async function processScheduledCampaigns() {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const now = new Date().toISOString();
    
    // Find all scheduled campaigns that are due
    const { data: dueCampaigns, error: fetchError } = await supabase
      .from('email_campaign')
      .select('id, tenant_id, name')
      .eq('status', 'scheduled')
      .lte('scheduled_at', now);

    if (fetchError) {
      throw fetchError;
    }

    if (!dueCampaigns || dueCampaigns.length === 0) {
      return { success: true, processed: 0, campaigns: [] };
    }

    const results = [];
    for (const campaign of dueCampaigns) {
      console.log(`[Campaign Service] Processing scheduled campaign: ${campaign.id} (${campaign.name})`);
      const result = await sendCampaign(campaign.id, campaign.tenant_id);
      results.push({
        campaignId: campaign.id,
        name: campaign.name,
        ...result
      });
    }

    return { 
      success: true, 
      processed: dueCampaigns.length,
      campaigns: results
    };
  } catch (err) {
    console.error('[Campaign Service] Error processing scheduled campaigns:', err);
    return { success: false, error: err.message };
  }
}

export async function sendCampaign(campaignId, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { success, campaign, error } = await getCampaign(campaignId, tenantId);
    if (!success || !campaign) {
      return { success: false, error: error || 'Campaign not found' };
    }

    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      return { success: false, error: `Cannot send campaign with status: ${campaign.status}` };
    }

    const recipientsResult = await getTargetRecipients(campaign, tenantId);
    if (!recipientsResult.success) {
      return recipientsResult;
    }

    const recipients = recipientsResult.recipients;
    if (recipients.length === 0) {
      return { success: false, error: 'No recipients found for this campaign' };
    }

    await updateCampaign(campaignId, {
      status: 'sending',
      sent_at: new Date().toISOString(),
      total_recipients: recipients.length
    }, tenantId);

    const recipientRecords = recipients.map(r => ({
      campaign_id: campaignId,
      member_id: r.id,
      email: r.email,
      first_name: r.first_name,
      last_name: r.last_name,
      status: 'pending'
    }));

    const { data: insertedRecipients, error: insertError } = await supabase
      .from('email_campaign_recipient')
      .insert(recipientRecords)
      .select();

    if (insertError) throw insertError;

    const { data: tenant } = await supabase
      .from('tenant')
      .select('slug')
      .eq('id', tenantId)
      .single();

    const tenantSlug = tenant?.slug || '';

    let sentCount = 0;
    let failedCount = 0;

    for (const recipient of insertedRecipients || []) {
      try {
        let html = campaign.html_content || '';
        let subject = campaign.subject || '';

        html = html.replace(/\{\{first_name\}\}/gi, recipient.first_name || '');
        html = html.replace(/\{\{last_name\}\}/gi, recipient.last_name || '');
        html = html.replace(/\{\{email\}\}/gi, recipient.email || '');
        subject = subject.replace(/\{\{first_name\}\}/gi, recipient.first_name || '');

        html = rewriteLinksForTracking(html, campaignId, recipient.id, tenantSlug);

        const unsubscribeUrl = `${APP_URL}/api/email-campaigns/unsubscribe?t=${generateTrackingToken(campaignId, recipient.id, 0)}`;
        if (!html.includes('{{unsubscribe_url}}')) {
          html += `<p style="margin-top: 20px; font-size: 12px; color: #666; text-align: center;">
            <a href="${unsubscribeUrl}" style="color: #666;">Unsubscribe from these emails</a>
          </p>`;
        } else {
          html = html.replace(/\{\{unsubscribe_url\}\}/gi, unsubscribeUrl);
        }

        const result = await sendEmail({
          to: recipient.email,
          subject: subject,
          html: html,
          from: campaign.from_name ? `${campaign.from_name} <${campaign.from_email}>` : campaign.from_email,
          tenantId: tenantId
        });

        if (result.success) {
          await supabase
            .from('email_campaign_recipient')
            .update({
              status: 'sent',
              sent_at: new Date().toISOString(),
              mailgun_message_id: result.messageId
            })
            .eq('id', recipient.id);

          sentCount++;
        } else {
          await supabase
            .from('email_campaign_recipient')
            .update({
              status: 'failed',
              error_message: result.error
            })
            .eq('id', recipient.id);

          failedCount++;
        }
      } catch (err) {
        console.error(`[Campaign Service] Error sending to ${recipient.email}:`, err);
        await supabase
          .from('email_campaign_recipient')
          .update({
            status: 'failed',
            error_message: err.message
          })
          .eq('id', recipient.id);

        failedCount++;
      }
    }

    await updateCampaign(campaignId, {
      status: 'sent',
      completed_at: new Date().toISOString(),
      sent_count: sentCount
    }, tenantId);

    return {
      success: true,
      totalRecipients: recipients.length,
      sent: sentCount,
      failed: failedCount
    };
  } catch (err) {
    console.error('[Campaign Service] Error sending campaign:', err);
    await updateCampaign(campaignId, { status: 'failed' }, tenantId).catch(() => {});
    return { success: false, error: err.message };
  }
}

export async function getCampaignStats(campaignId, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data: campaign, error: campaignError } = await supabase
      .from('email_campaign')
      .select('*')
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .single();

    if (campaignError) throw campaignError;

    const { data: recipients, error: recipientsError } = await supabase
      .from('email_campaign_recipient')
      .select('status, open_count, click_count')
      .eq('campaign_id', campaignId);

    if (recipientsError) throw recipientsError;

    const stats = {
      total: recipients?.length || 0,
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      failed: 0,
      unsubscribed: 0,
      complained: 0
    };

    for (const r of recipients || []) {
      if (r.status === 'sent' || r.status === 'delivered' || r.status === 'opened' || r.status === 'clicked') {
        stats.sent++;
      }
      if (r.status === 'delivered' || r.status === 'opened' || r.status === 'clicked') {
        stats.delivered++;
      }
      if (r.status === 'opened' || r.status === 'clicked' || r.open_count > 0) {
        stats.opened++;
      }
      if (r.status === 'clicked' || r.click_count > 0) {
        stats.clicked++;
      }
      if (r.status === 'bounced') {
        stats.bounced++;
      }
      if (r.status === 'failed') {
        stats.failed++;
      }
      if (r.status === 'unsubscribed') {
        stats.unsubscribed++;
      }
      if (r.status === 'complained') {
        stats.complained++;
      }
    }

    stats.openRate = stats.delivered > 0 ? ((stats.opened / stats.delivered) * 100).toFixed(1) : 0;
    stats.clickRate = stats.opened > 0 ? ((stats.clicked / stats.opened) * 100).toFixed(1) : 0;
    stats.bounceRate = stats.sent > 0 ? ((stats.bounced / stats.sent) * 100).toFixed(1) : 0;

    return { success: true, campaign, stats };
  } catch (err) {
    console.error('[Campaign Service] Error getting campaign stats:', err);
    return { success: false, error: err.message };
  }
}

export async function getClickHeatmapData(campaignId, tenantId) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }

  try {
    const { data: clicks, error } = await supabase
      .from('email_link_click')
      .select('original_url, link_position, link_index, link_text')
      .eq('campaign_id', campaignId);

    if (error) throw error;

    const heatmapData = {};
    for (const click of clicks || []) {
      const key = click.link_index?.toString() || click.link_position || click.original_url;
      if (!heatmapData[key]) {
        heatmapData[key] = {
          url: click.original_url,
          position: click.link_position,
          index: click.link_index,
          text: click.link_text,
          clicks: 0
        };
      }
      heatmapData[key].clicks++;
    }

    const sortedData = Object.values(heatmapData).sort((a, b) => b.clicks - a.clicks);

    return { success: true, heatmapData: sortedData };
  } catch (err) {
    console.error('[Campaign Service] Error getting heatmap data:', err);
    return { success: false, error: err.message };
  }
}
