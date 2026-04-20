import { supabase } from '../_lib/database.js';
import crypto from 'crypto';

const MAILGUN_WEBHOOK_SIGNING_KEY = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;

async function incrementCampaignColumn(campaignId, columnName) {
  try {
    const { error: rpcError } = await supabase.rpc('increment_campaign_counter', {
      p_campaign_id: campaignId,
      p_column_name: columnName
    });
    if (rpcError) throw rpcError;
  } catch {
    const { data: current } = await supabase
      .from('email_campaign')
      .select(columnName)
      .eq('id', campaignId)
      .single();

    const currentVal = current?.[columnName] || 0;
    await supabase
      .from('email_campaign')
      .update({ [columnName]: currentVal + 1 })
      .eq('id', campaignId);
  }
}

function verifyWebhookSignature(timestamp, token, signature) {
  if (!MAILGUN_WEBHOOK_SIGNING_KEY) {
    console.log('[Mailgun Webhook] No signing key configured, skipping verification');
    return true;
  }

  const encodedToken = crypto
    .createHmac('sha256', MAILGUN_WEBHOOK_SIGNING_KEY)
    .update(timestamp + token)
    .digest('hex');

  return encodedToken === signature;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const eventData = req.body['event-data'] || req.body;
  const signature = req.body.signature;

  if (signature && MAILGUN_WEBHOOK_SIGNING_KEY) {
    const isValid = verifyWebhookSignature(
      signature.timestamp,
      signature.token,
      signature.signature
    );

    if (!isValid) {
      console.error('[Mailgun Webhook] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  if (!supabase) {
    console.error('[Mailgun Webhook] Database not configured');
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const eventType = eventData.event;
    const headerMessageId = eventData.message?.headers?.['message-id'];
    const topLevelMessageId = eventData['message-id'];
    const rawMessageId = headerMessageId || topLevelMessageId;
    const messageId = rawMessageId ? rawMessageId.replace(/^<|>$/g, '') : rawMessageId;
    const recipientEmail = eventData.recipient;
    const timestamp = eventData.timestamp ? new Date(eventData.timestamp * 1000).toISOString() : new Date().toISOString();

    console.log(`[Mailgun Webhook] Received ${eventType} event for ${recipientEmail}, messageId: ${messageId || 'none'} (header: ${headerMessageId || 'none'}, top-level: ${topLevelMessageId || 'none'})`);

    let recipient = null;
    let campaign = null;

    if (messageId) {
      const { data } = await supabase
        .from('email_campaign_recipient')
        .select('id, campaign_id, member_id')
        .eq('mailgun_message_id', messageId)
        .single();

      if (data) {
        recipient = data;
        console.log(`[Mailgun Webhook] Matched recipient ${data.id} for campaign ${data.campaign_id} via messageId`);
      } else {
        console.log(`[Mailgun Webhook] No recipient found for messageId: ${messageId}`);
      }
    }

    if (!recipient && recipientEmail) {
      const { data: fallbackRecipients } = await supabase
        .from('email_campaign_recipient')
        .select('id, campaign_id, member_id, mailgun_message_id')
        .eq('email', recipientEmail)
        .in('status', ['sent', 'delivered', 'opened', 'clicked'])
        .order('sent_at', { ascending: false })
        .limit(5);

      if (fallbackRecipients && fallbackRecipients.length > 0) {
        recipient = fallbackRecipients[0];
        console.log(`[Mailgun Webhook] Fallback: matched recipient ${recipient.id} for campaign ${recipient.campaign_id} via email ${recipientEmail} (stored msgId: ${recipient.mailgun_message_id})`);
      } else {
        console.log(`[Mailgun Webhook] No recipient found via email fallback for ${recipientEmail}`);
      }
    }

    if (recipient) {
      const { data: campaignData } = await supabase
        .from('email_campaign')
        .select('id, tenant_id')
        .eq('id', recipient.campaign_id)
        .single();
      campaign = campaignData;
    }

    await supabase.from('email_event').insert({
      tenant_id: campaign?.tenant_id,
      campaign_id: recipient?.campaign_id,
      recipient_id: recipient?.id,
      member_id: recipient?.member_id,
      event_type: eventType,
      email: recipientEmail,
      mailgun_message_id: messageId,
      mailgun_event_id: eventData.id,
      severity: eventData.severity,
      reason: eventData.reason,
      delivery_status_code: eventData['delivery-status']?.code,
      delivery_status_message: eventData['delivery-status']?.message,
      client_type: eventData['client-info']?.['client-type'],
      client_name: eventData['client-info']?.['client-name'],
      client_os: eventData['client-info']?.['client-os'],
      device_type: eventData['client-info']?.['device-type'],
      country: eventData.geolocation?.country,
      region: eventData.geolocation?.region,
      city: eventData.geolocation?.city,
      raw_event: eventData,
      event_timestamp: timestamp
    });

    if (recipient) {
      const { data: existingRecipient } = await supabase
        .from('email_campaign_recipient')
        .select('status, opened_at, clicked_at, open_count, click_count')
        .eq('id', recipient.id)
        .single();

      switch (eventType) {
        case 'delivered': {
          await supabase
            .from('email_campaign_recipient')
            .update({ status: 'delivered', delivered_at: timestamp })
            .eq('id', recipient.id);

          if (campaign) {
            await incrementCampaignColumn(campaign.id, 'delivered_count');
          }
          break;
        }

        case 'opened': {
          const newOpenCount = (existingRecipient?.open_count || 0) + 1;
          const recipientUpdate = { open_count: newOpenCount };
          const isFirstOpen = !existingRecipient?.opened_at;

          if (isFirstOpen) {
            recipientUpdate.status = 'opened';
            recipientUpdate.opened_at = timestamp;
          }

          await supabase
            .from('email_campaign_recipient')
            .update(recipientUpdate)
            .eq('id', recipient.id);

          if (isFirstOpen && campaign) {
            await incrementCampaignColumn(campaign.id, 'opened_count');
          }
          break;
        }

        case 'clicked': {
          const newClickCount = (existingRecipient?.click_count || 0) + 1;
          const clickUpdate = { click_count: newClickCount };
          const isFirstClick = !existingRecipient?.clicked_at;

          if (isFirstClick) {
            clickUpdate.status = 'clicked';
            clickUpdate.clicked_at = timestamp;
          }

          await supabase
            .from('email_campaign_recipient')
            .update(clickUpdate)
            .eq('id', recipient.id);

          if (isFirstClick && campaign) {
            await incrementCampaignColumn(campaign.id, 'clicked_count');
          }
          break;
        }

        case 'failed':
        case 'bounced': {
          await supabase
            .from('email_campaign_recipient')
            .update({
              status: 'bounced',
              bounced_at: timestamp,
              error_message: eventData.reason || eventData['delivery-status']?.message
            })
            .eq('id', recipient.id);

          if (campaign) {
            await incrementCampaignColumn(campaign.id, 'bounced_count');
          }

          if (eventData.severity === 'permanent') {
            await supabase
              .from('member')
              .update({ 
                email_bounced: true,
                email_bounce_reason: eventData.reason 
              })
              .eq('id', recipient.member_id);
          }
          break;
        }

        case 'complained': {
          await supabase
            .from('email_campaign_recipient')
            .update({ status: 'complained', complained_at: timestamp })
            .eq('id', recipient.id);

          if (campaign) {
            await incrementCampaignColumn(campaign.id, 'complained_count');
          }

          await supabase.from('email_unsubscribe').upsert({
            tenant_id: campaign?.tenant_id,
            email: recipientEmail,
            member_id: recipient.member_id,
            unsubscribe_type: 'all',
            campaign_id: recipient.campaign_id,
            reason: 'Spam complaint',
            source: 'complaint'
          }, { 
            onConflict: 'tenant_id,email,unsubscribe_type' 
          });
          break;
        }

        case 'unsubscribed': {
          await supabase
            .from('email_campaign_recipient')
            .update({ status: 'unsubscribed', unsubscribed_at: timestamp })
            .eq('id', recipient.id);

          if (campaign) {
            await incrementCampaignColumn(campaign.id, 'unsubscribed_count');
          }

          await supabase.from('email_unsubscribe').upsert({
            tenant_id: campaign?.tenant_id,
            email: recipientEmail,
            member_id: recipient.member_id,
            unsubscribe_type: 'all',
            campaign_id: recipient.campaign_id,
            source: 'webhook'
          }, { 
            onConflict: 'tenant_id,email,unsubscribe_type' 
          });
          break;
        }
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Mailgun Webhook] Error processing event:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export const config = {
  api: {
    bodyParser: true
  }
};
