import { supabase } from '../_lib/database.js';
import crypto from 'crypto';

const MAILGUN_WEBHOOK_SIGNING_KEY = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;

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
    const messageId = eventData.message?.headers?.['message-id'] || eventData['message-id'];
    const recipientEmail = eventData.recipient;
    const timestamp = eventData.timestamp ? new Date(eventData.timestamp * 1000).toISOString() : new Date().toISOString();

    console.log(`[Mailgun Webhook] Received ${eventType} event for ${recipientEmail}`);

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
        const { data: campaignData } = await supabase
          .from('email_campaign')
          .select('id, tenant_id')
          .eq('id', data.campaign_id)
          .single();
        campaign = campaignData;
      }
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
      const updates = {};
      const campaignUpdates = {};

      switch (eventType) {
        case 'delivered':
          updates.status = 'delivered';
          updates.delivered_at = timestamp;
          campaignUpdates.delivered_count = supabase.raw ? supabase.raw('delivered_count + 1') : 1;
          break;

        case 'opened':
          updates.open_count = supabase.raw ? supabase.raw('open_count + 1') : 1;
          if (!updates.opened_at) {
            updates.status = 'opened';
            updates.opened_at = timestamp;
            campaignUpdates.opened_count = supabase.raw ? supabase.raw('opened_count + 1') : 1;
          }
          break;

        case 'clicked':
          updates.click_count = supabase.raw ? supabase.raw('click_count + 1') : 1;
          if (!updates.clicked_at) {
            updates.status = 'clicked';
            updates.clicked_at = timestamp;
            campaignUpdates.clicked_count = supabase.raw ? supabase.raw('clicked_count + 1') : 1;
          }
          break;

        case 'failed':
        case 'bounced':
          updates.status = 'bounced';
          updates.bounced_at = timestamp;
          updates.error_message = eventData.reason || eventData['delivery-status']?.message;
          campaignUpdates.bounced_count = supabase.raw ? supabase.raw('bounced_count + 1') : 1;

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

        case 'complained':
          updates.status = 'complained';
          updates.complained_at = timestamp;
          campaignUpdates.complained_count = supabase.raw ? supabase.raw('complained_count + 1') : 1;

          await supabase.from('email_unsubscribe').upsert({
            tenant_id: campaign?.tenant_id,
            email: recipientEmail,
            member_id: recipient.member_id,
            unsubscribe_type: 'all',
            campaign_id: recipient.campaign_id,
            reason: 'Spam complaint',
            source: 'complaint'
          }, { 
            onConflict: 'tenant_id,email,unsubscribe_type,communication_category_id' 
          });
          break;

        case 'unsubscribed':
          updates.status = 'unsubscribed';
          updates.unsubscribed_at = timestamp;
          campaignUpdates.unsubscribed_count = supabase.raw ? supabase.raw('unsubscribed_count + 1') : 1;

          await supabase.from('email_unsubscribe').upsert({
            tenant_id: campaign?.tenant_id,
            email: recipientEmail,
            member_id: recipient.member_id,
            unsubscribe_type: 'all',
            campaign_id: recipient.campaign_id,
            source: 'webhook'
          }, { 
            onConflict: 'tenant_id,email,unsubscribe_type,communication_category_id' 
          });
          break;
      }

      if (Object.keys(updates).length > 0) {
        await supabase
          .from('email_campaign_recipient')
          .update(updates)
          .eq('id', recipient.id);
      }

      if (Object.keys(campaignUpdates).length > 0 && campaign) {
        await supabase
          .from('email_campaign')
          .update(campaignUpdates)
          .eq('id', campaign.id);
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
