import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

const ALLOWED_ORIGINS = ['https://iconn.app', 'https://www.iconn.app'];
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_REGION = process.env.MAILGUN_REGION || 'eu';
const TIME_BUDGET_MS = 50_000;

function getAllowedOrigin(requestOrigin) {
  if (!requestOrigin) return ALLOWED_ORIGINS[0];
  if (ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  if (requestOrigin.endsWith('.iconn.app')) return requestOrigin;
  return ALLOWED_ORIGINS[0];
}

async function fetchMailgunEvents(domain, params) {
  if (!MAILGUN_API_KEY) throw new Error('MAILGUN_API_KEY not configured');

  const apiBase = MAILGUN_REGION === 'eu'
    ? 'https://api.eu.mailgun.net'
    : 'https://api.mailgun.net';
  const authHeader = 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64');

  const url = new URL(`${apiBase}/v3/${domain}/events`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Authorization': authHeader }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`Mailgun Events API error: ${response.status} - ${JSON.stringify(errorData)}`);
  }

  return response.json();
}

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

function extractEventIdentifiers(eventData) {
  const headerMessageId = eventData.message?.headers?.['message-id'];
  const topLevelMessageId = eventData['message-id'];
  const rawMessageId = headerMessageId || topLevelMessageId;
  const messageId = rawMessageId ? rawMessageId.replace(/^<|>$/g, '') : rawMessageId;
  const recipientEmail = eventData.recipient;
  const timestamp = eventData.timestamp
    ? new Date(eventData.timestamp * 1000).toISOString()
    : new Date().toISOString();
  return { messageId, recipientEmail, timestamp };
}

function lookupRecipient(messageId, recipientEmail, recipientsByMsgId, recipientsByEmail) {
  if (messageId && recipientsByMsgId.has(messageId)) {
    return recipientsByMsgId.get(messageId);
  }
  if (recipientEmail && recipientsByEmail.has(recipientEmail)) {
    return recipientsByEmail.get(recipientEmail);
  }
  return null;
}

function buildEventRow(eventData, campaignId, tenantId, recipientObj, messageId, recipientEmail, timestamp) {
  return {
    tenant_id: tenantId,
    campaign_id: campaignId,
    recipient_id: recipientObj.id,
    member_id: recipientObj.member_id,
    event_type: eventData.event,
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
    event_timestamp: timestamp,
  };
}

async function applyRecipientSideEffects(eventData, recipient, campaignId, tenantId, timestamp) {
  const eventType = eventData.event;
  const recipientEmail = eventData.recipient;

  switch (eventType) {
    case 'delivered': {
      if (!recipient.delivered_at) {
        await supabase
          .from('email_campaign_recipient')
          .update({ status: 'delivered', delivered_at: timestamp })
          .eq('id', recipient.id);
        await incrementCampaignColumn(campaignId, 'delivered_count');
        recipient.delivered_at = timestamp;
        recipient.status = 'delivered';
      }
      break;
    }

    case 'opened': {
      const newOpenCount = (recipient.open_count || 0) + 1;
      const recipientUpdate = { open_count: newOpenCount };
      const isFirstOpen = !recipient.opened_at;

      if (isFirstOpen) {
        recipientUpdate.status = 'opened';
        recipientUpdate.opened_at = timestamp;
      }

      if (!recipient.delivered_at) {
        recipientUpdate.delivered_at = timestamp;
        await incrementCampaignColumn(campaignId, 'delivered_count');
        recipient.delivered_at = timestamp;
      }

      await supabase
        .from('email_campaign_recipient')
        .update(recipientUpdate)
        .eq('id', recipient.id);

      if (isFirstOpen) {
        await incrementCampaignColumn(campaignId, 'opened_count');
        recipient.opened_at = timestamp;
        recipient.status = 'opened';
      }
      recipient.open_count = newOpenCount;
      break;
    }

    case 'clicked': {
      const newClickCount = (recipient.click_count || 0) + 1;
      const clickUpdate = { click_count: newClickCount };
      const isFirstClick = !recipient.clicked_at;

      if (isFirstClick) {
        clickUpdate.status = 'clicked';
        clickUpdate.clicked_at = timestamp;
      }

      if (!recipient.delivered_at) {
        clickUpdate.delivered_at = timestamp;
        await incrementCampaignColumn(campaignId, 'delivered_count');
        recipient.delivered_at = timestamp;
      }

      await supabase
        .from('email_campaign_recipient')
        .update(clickUpdate)
        .eq('id', recipient.id);

      if (isFirstClick) {
        await incrementCampaignColumn(campaignId, 'clicked_count');
        recipient.clicked_at = timestamp;
        recipient.status = 'clicked';
      }
      recipient.click_count = newClickCount;
      break;
    }

    case 'failed':
    case 'bounced': {
      if (recipient.status !== 'bounced') {
        await supabase
          .from('email_campaign_recipient')
          .update({
            status: 'bounced',
            bounced_at: timestamp,
            error_message: eventData.reason || eventData['delivery-status']?.message
          })
          .eq('id', recipient.id);
        await incrementCampaignColumn(campaignId, 'bounced_count');
        recipient.status = 'bounced';

        if (eventData.severity === 'permanent') {
          await supabase
            .from('member')
            .update({
              email_bounced: true,
              email_bounce_reason: eventData.reason
            })
            .eq('id', recipient.member_id);
        }
      }
      break;
    }

    case 'complained': {
      if (recipient.status !== 'complained') {
        await supabase
          .from('email_campaign_recipient')
          .update({ status: 'complained', complained_at: timestamp })
          .eq('id', recipient.id);
        await incrementCampaignColumn(campaignId, 'complained_count');
        recipient.status = 'complained';

        await supabase.from('email_unsubscribe').upsert({
          tenant_id: tenantId,
          email: recipientEmail,
          member_id: recipient.member_id,
          unsubscribe_type: 'all',
          campaign_id: campaignId,
          reason: 'Spam complaint',
          source: 'complaint'
        }, {
          onConflict: 'tenant_id,email,unsubscribe_type,communication_category_id'
        });
      }
      break;
    }

    case 'unsubscribed': {
      if (recipient.status !== 'unsubscribed') {
        await supabase
          .from('email_campaign_recipient')
          .update({ status: 'unsubscribed', unsubscribed_at: timestamp })
          .eq('id', recipient.id);
        await incrementCampaignColumn(campaignId, 'unsubscribed_count');
        recipient.status = 'unsubscribed';

        await supabase.from('email_unsubscribe').upsert({
          tenant_id: tenantId,
          email: recipientEmail,
          member_id: recipient.member_id,
          unsubscribe_type: 'all',
          campaign_id: campaignId,
          source: 'webhook'
        }, {
          onConflict: 'tenant_id,email,unsubscribe_type,communication_category_id'
        });
      }
      break;
    }
  }
}

async function loadAllRecipients(campaignId) {
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('email_campaign_recipient')
      .select('id, campaign_id, member_id, email, mailgun_message_id, status, delivered_at, opened_at, clicked_at, open_count, click_count')
      .eq('campaign_id', campaignId)
      .in('status', ['sent', 'delivered', 'opened', 'clicked', 'processing'])
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function loadExistingEventIds(campaignId) {
  const ids = new Set();
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('email_event')
      .select('mailgun_event_id')
      .eq('campaign_id', campaignId)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (row.mailgun_event_id) ids.add(row.mailgun_event_id);
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return ids;
}

export default async function handler(req, res) {
  const origin = getAllowedOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const isAuthorized = await hasAdminAccess(tenantContext);
  if (!isAuthorized) {
    return res.status(403).json({ error: 'Forbidden - requires admin access' });
  }

  const tenantId = tenantContext.tenantId;
  const { campaignId } = req.body || {};

  if (!campaignId) {
    return res.status(400).json({ error: 'campaignId is required' });
  }

  const startTime = Date.now();

  try {
    const { data: campaign, error: campaignError } = await supabase
      .from('email_campaign')
      .select('id, tenant_id, from_email, status, sent_at')
      .eq('id', campaignId)
      .eq('tenant_id', tenantId)
      .single();

    if (campaignError || !campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { data: tenant } = await supabase
      .from('tenant')
      .select('settings')
      .eq('id', tenantId)
      .single();

    const emailDomain = tenant?.settings?.email_domain?.domain;
    if (!emailDomain) {
      return res.status(400).json({ error: 'No email domain configured for this tenant' });
    }

    const allRecipients = await loadAllRecipients(campaignId);

    if (allRecipients.length === 0) {
      return res.json({
        success: true,
        message: 'No recipients found for this campaign',
        summary: { total_events: 0, processed: 0, skipped: 0 }
      });
    }

    const recipientsByMsgId = new Map();
    const recipientsByEmail = new Map();
    const messageIds = new Set();
    const recipientEmails = new Set();

    for (const r of allRecipients) {
      if (r.mailgun_message_id) {
        recipientsByMsgId.set(r.mailgun_message_id, r);
        messageIds.add(r.mailgun_message_id);
      }
      if (r.email) {
        recipientsByEmail.set(r.email, r);
        recipientEmails.add(r.email);
      }
    }

    const existingEventIds = await loadExistingEventIds(campaignId);

    console.log(`[Sync Mailgun Events] Starting sync for campaign ${campaignId}, ${messageIds.size} message IDs, ${recipientEmails.size} emails, domain: ${emailDomain}, ${existingEventIds.size} existing events pre-loaded`);

    let totalEvents = 0;
    let processed = 0;
    let skipped = 0;
    let errors = 0;
    let timedOut = false;
    let lastEventType = null;
    const eventTypes = ['delivered', 'opened', 'clicked', 'failed', 'bounced', 'complained', 'unsubscribed'];

    const sentAtMs = campaign.sent_at ? new Date(campaign.sent_at).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;
    const beginDate = String(Math.floor((sentAtMs - 60 * 60 * 1000) / 1000));
    const endDate = String(Math.floor(Math.min(sentAtMs + 7 * 24 * 60 * 60 * 1000, Date.now()) / 1000));

    const INSERT_BATCH_SIZE = 50;

    for (const eventType of eventTypes) {
      if (timedOut) break;
      lastEventType = eventType;
      let nextUrl = null;
      let hasMore = true;

      while (hasMore) {
        if (Date.now() - startTime > TIME_BUDGET_MS) {
          timedOut = true;
          break;
        }

        let eventsData;
        if (nextUrl) {
          const authHeader = 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64');
          const resp = await fetch(nextUrl, {
            method: 'GET',
            headers: { 'Authorization': authHeader }
          });
          if (!resp.ok) break;
          eventsData = await resp.json();
        } else {
          eventsData = await fetchMailgunEvents(emailDomain, {
            event: eventType,
            begin: beginDate,
            end: endDate,
            limit: 300,
            ascending: 'yes'
          });
        }

        const items = eventsData.items || [];
        if (items.length === 0) {
          hasMore = false;
          break;
        }

        const matchedEvents = [];
        for (const event of items) {
          const { messageId, recipientEmail } = extractEventIdentifiers(event);
          if (!messageId && !recipientEmail) continue;

          const matchesByMessageId = messageId && messageIds.has(messageId);
          const matchesByEmail = recipientEmail && recipientEmails.has(recipientEmail);
          if (!matchesByMessageId && !matchesByEmail) continue;

          if (event.id && existingEventIds.has(event.id)) {
            skipped++;
            continue;
          }

          const recipient = lookupRecipient(messageId, recipientEmail, recipientsByMsgId, recipientsByEmail);
          if (!recipient) {
            skipped++;
            continue;
          }

          matchedEvents.push({ event, recipient, messageId, recipientEmail });
        }

        for (let i = 0; i < matchedEvents.length; i += INSERT_BATCH_SIZE) {
          if (Date.now() - startTime > TIME_BUDGET_MS) {
            timedOut = true;
            break;
          }

          const batch = matchedEvents.slice(i, i + INSERT_BATCH_SIZE);
          const insertRows = batch.map(({ event, recipient, messageId, recipientEmail }) => {
            const { timestamp } = extractEventIdentifiers(event);
            return buildEventRow(event, campaignId, tenantId, recipient, messageId, recipientEmail, timestamp);
          });

          const { error: insertError } = await supabase
            .from('email_event')
            .insert(insertRows);

          if (insertError) {
            console.error(`[Sync Mailgun Events] Batch insert error:`, insertError.message);
            errors += batch.length;
            continue;
          }

          for (const row of insertRows) {
            if (row.mailgun_event_id) existingEventIds.add(row.mailgun_event_id);
          }

          for (const { event, recipient } of batch) {
            totalEvents++;
            try {
              const { timestamp } = extractEventIdentifiers(event);
              await applyRecipientSideEffects(event, recipient, campaignId, tenantId, timestamp);
              processed++;
            } catch (err) {
              console.error(`[Sync Mailgun Events] Side-effect error:`, err.message);
              errors++;
            }
          }
        }

        if (timedOut) break;

        nextUrl = eventsData.paging?.next;
        if (!nextUrl) {
          hasMore = false;
        }
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[Sync Mailgun Events] ${timedOut ? 'Partial' : 'Complete'} for campaign ${campaignId}: ${totalEvents} events found, ${processed} processed, ${skipped} skipped, ${errors} errors, ${elapsed}s elapsed${timedOut ? `, stopped at event type: ${lastEventType}` : ''}`);

    return res.json({
      success: true,
      partial: timedOut,
      summary: {
        total_events: totalEvents,
        processed,
        skipped,
        errors,
        elapsed_seconds: elapsed,
        ...(timedOut ? { stopped_at: lastEventType, message: 'Time budget reached — click Sync again to continue processing remaining events.' } : {}),
      }
    });
  } catch (error) {
    console.error('[Sync Mailgun Events] Error:', error);
    return res.status(500).json({
      error: 'Failed to sync Mailgun events',
      details: error.message
    });
  }
}
