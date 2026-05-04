import { supabase } from './database.js';

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_REGION = process.env.MAILGUN_REGION || 'eu';

export async function fetchMailgunEvents(domain, params) {
  if (!MAILGUN_API_KEY) throw new Error('MAILGUN_API_KEY not configured');
  const apiBase = MAILGUN_REGION === 'eu'
    ? 'https://api.eu.mailgun.net'
    : 'https://api.mailgun.net';
  const authHeader = 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64');
  const url = new URL(`${apiBase}/v3/${domain}/events`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
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

export function extractEventIdentifiers(eventData) {
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

export function lookupRecipient(messageId, recipientEmail, recipientsByMsgId, recipientsByEmail) {
  if (messageId && recipientsByMsgId.has(messageId)) return recipientsByMsgId.get(messageId);
  if (recipientEmail && recipientsByEmail.has(recipientEmail)) return recipientsByEmail.get(recipientEmail);
  return null;
}

export function buildEventRow(eventData, campaignId, tenantId, recipientObj, messageId, recipientEmail, timestamp) {
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

const STATUS_PRIORITY = { complained: 6, unsubscribed: 5, bounced: 4, clicked: 3, opened: 2, delivered: 1 };

export function applyEventToRecipientState(state, eventData, timestamp) {
  const eventType = eventData.event;
  const effectiveType = eventType === 'failed' ? 'bounced' : eventType;
  const currentPriority = STATUS_PRIORITY[state.status] || 0;
  const newPriority = STATUS_PRIORITY[effectiveType] || 0;

  if (!state.delivered_at && (effectiveType === 'delivered' || effectiveType === 'opened' || effectiveType === 'clicked')) {
    state.delivered_at = timestamp;
    state.counterDeltas.delivered_count = (state.counterDeltas.delivered_count || 0) + 1;
    if (currentPriority < STATUS_PRIORITY['delivered']) {
      state.status = 'delivered';
    }
  }

  switch (effectiveType) {
    case 'delivered':
      if (currentPriority < newPriority) state.status = 'delivered';
      break;
    case 'opened':
      state.open_count = (state.open_count || 0) + 1;
      if (!state.opened_at) {
        state.opened_at = timestamp;
        state.counterDeltas.opened_count = (state.counterDeltas.opened_count || 0) + 1;
      }
      if (currentPriority < newPriority) state.status = 'opened';
      break;
    case 'clicked':
      state.click_count = (state.click_count || 0) + 1;
      if (!state.clicked_at) {
        state.clicked_at = timestamp;
        state.counterDeltas.clicked_count = (state.counterDeltas.clicked_count || 0) + 1;
      }
      if (currentPriority < newPriority) state.status = 'clicked';
      break;
    case 'bounced':
      if (currentPriority < newPriority) {
        state.status = 'bounced';
        state.bounced_at = state.bounced_at || timestamp;
        state.error_message = eventData.reason || eventData['delivery-status']?.message;
        state.counterDeltas.bounced_count = (state.counterDeltas.bounced_count || 0) + 1;
        if (eventData.severity === 'permanent') {
          state.permanentBounce = true;
          state.bounceReason = eventData.reason;
        }
      }
      break;
    case 'complained':
      if (currentPriority < newPriority) {
        state.status = 'complained';
        state.complained_at = state.complained_at || timestamp;
        state.counterDeltas.complained_count = (state.counterDeltas.complained_count || 0) + 1;
        state.needsUnsubscribe = { reason: 'Spam complaint', source: 'complaint' };
      }
      break;
    case 'unsubscribed':
      if (currentPriority < newPriority) {
        state.status = 'unsubscribed';
        state.unsubscribed_at = state.unsubscribed_at || timestamp;
        state.counterDeltas.unsubscribed_count = (state.counterDeltas.unsubscribed_count || 0) + 1;
        state.needsUnsubscribe = { source: 'webhook' };
      }
      break;
  }

  state.dirty = true;
}

export async function loadAllRecipients(campaignId) {
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('email_campaign_recipient')
      .select('id, campaign_id, member_id, email, mailgun_message_id, status, delivered_at, opened_at, clicked_at, bounced_at, complained_at, unsubscribed_at, open_count, click_count, error_message')
      .eq('campaign_id', campaignId)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

export async function loadExistingEventIds(campaignId) {
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

export async function flushRecipientUpdates(recipientStates) {
  const dirty = [...recipientStates.values()].filter(s => s.dirty);
  const CONCURRENCY = 50;
  for (let i = 0; i < dirty.length; i += CONCURRENCY) {
    const chunk = dirty.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(state => {
      const update = { status: state.status };
      if (state.delivered_at) update.delivered_at = state.delivered_at;
      if (state.opened_at) update.opened_at = state.opened_at;
      if (state.clicked_at) update.clicked_at = state.clicked_at;
      if (state.bounced_at) update.bounced_at = state.bounced_at;
      if (state.complained_at) update.complained_at = state.complained_at;
      if (state.unsubscribed_at) update.unsubscribed_at = state.unsubscribed_at;
      if (state.open_count != null) update.open_count = state.open_count;
      if (state.click_count != null) update.click_count = state.click_count;
      if (state.error_message) update.error_message = state.error_message;
      return supabase.from('email_campaign_recipient').update(update).eq('id', state.id);
    }));
  }
  return dirty.length;
}

export async function flushCampaignCounters(campaignId, recipientStates) {
  const totals = {};
  for (const state of recipientStates.values()) {
    for (const [col, delta] of Object.entries(state.counterDeltas)) {
      totals[col] = (totals[col] || 0) + delta;
    }
  }
  if (Object.keys(totals).length === 0) return;

  const { data: current } = await supabase
    .from('email_campaign')
    .select('delivered_count, opened_count, clicked_count, bounced_count, complained_count, unsubscribed_count')
    .eq('id', campaignId)
    .single();

  if (!current) return;
  const update = {};
  for (const [col, delta] of Object.entries(totals)) {
    update[col] = (current[col] || 0) + delta;
  }
  await supabase.from('email_campaign').update(update).eq('id', campaignId);
}

export async function flushBounceAndUnsubscribe(recipientStates, tenantId, campaignId) {
  const bounceUpdates = [];
  const unsubRows = [];
  for (const state of recipientStates.values()) {
    if (!state.dirty) continue;
    if (state.permanentBounce) {
      bounceUpdates.push({ memberId: state.member_id, reason: state.bounceReason });
    }
    if (state.needsUnsubscribe) {
      unsubRows.push({
        tenant_id: tenantId,
        email: state.email,
        member_id: state.member_id,
        unsubscribe_type: 'all',
        campaign_id: campaignId,
        reason: state.needsUnsubscribe.reason || null,
        source: state.needsUnsubscribe.source
      });
    }
  }

  const BATCH = 20;
  for (let i = 0; i < bounceUpdates.length; i += BATCH) {
    await Promise.all(bounceUpdates.slice(i, i + BATCH).map(b =>
      supabase.from('member').update({ email_bounced: true, email_bounce_reason: b.reason }).eq('id', b.memberId)
    ));
  }

  for (let i = 0; i < unsubRows.length; i += 50) {
    await supabase.from('email_unsubscribe').upsert(
      unsubRows.slice(i, i + 50),
      { onConflict: 'tenant_id,email,unsubscribe_type,communication_category_id' }
    );
  }
}

export function buildRecipientState(r) {
  return {
    id: r.id,
    member_id: r.member_id,
    email: r.email,
    status: r.status,
    delivered_at: r.delivered_at,
    opened_at: r.opened_at,
    clicked_at: r.clicked_at,
    bounced_at: r.bounced_at || null,
    complained_at: r.complained_at || null,
    unsubscribed_at: r.unsubscribed_at || null,
    open_count: r.open_count || 0,
    click_count: r.click_count || 0,
    error_message: r.error_message || null,
    counterDeltas: {},
    dirty: false,
    permanentBounce: false,
    bounceReason: null,
    needsUnsubscribe: null,
  };
}

const MIN_USEFUL_BUDGET_MS = 12_000;

export async function syncCampaignEvents(campaign, emailDomain, tenantId, timeBudgetMs) {
  if (timeBudgetMs < MIN_USEFUL_BUDGET_MS) {
    return { totalEvents: 0, processed: 0, skipped: 0, errors: 0, timedOut: true, lastEventType: null, elapsedSeconds: 0 };
  }
  const startTime = Date.now();
  const FLUSH_BUDGET_MS = 8_000;
  const fetchBudgetMs = Math.max(timeBudgetMs - FLUSH_BUDGET_MS, 3_000);

  const [allRecipients, existingEventIds] = await Promise.all([
    loadAllRecipients(campaign.id),
    loadExistingEventIds(campaign.id)
  ]);

  if (allRecipients.length === 0) {
    return { totalEvents: 0, processed: 0, skipped: 0, errors: 0, timedOut: false, elapsedSeconds: 0 };
  }

  const recipientsByMsgId = new Map();
  const recipientsByEmail = new Map();
  const messageIds = new Set();
  const recipientEmails = new Set();
  const recipientStates = new Map();

  for (const r of allRecipients) {
    if (r.mailgun_message_id) {
      recipientsByMsgId.set(r.mailgun_message_id, r);
      messageIds.add(r.mailgun_message_id);
    }
    if (r.email) {
      recipientsByEmail.set(r.email, r);
      recipientEmails.add(r.email);
    }
    recipientStates.set(r.id, buildRecipientState(r));
  }

  console.log(`[Mailgun Sync] Campaign ${campaign.id}: ${messageIds.size} message IDs, ${recipientEmails.size} emails, domain: ${emailDomain}, ${existingEventIds.size} existing events`);

  let totalEvents = 0;
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  let timedOut = false;
  let lastEventType = null;
  const eventTypes = ['delivered', 'opened', 'clicked', 'failed', 'bounced', 'complained', 'unsubscribed'];

  const sentAtMs = campaign.sent_at ? new Date(campaign.sent_at).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;
  const beginDate = String(Math.floor((sentAtMs - 60 * 60 * 1000) / 1000));
  const endDate = String(Math.floor(Math.min(sentAtMs + 30 * 24 * 60 * 60 * 1000, Date.now()) / 1000));

  const pendingInsertRows = [];
  const INSERT_BATCH_SIZE = 500;

  for (const eventType of eventTypes) {
    if (timedOut) break;
    lastEventType = eventType;
    let nextUrl = null;
    let hasMore = true;

    while (hasMore) {
      if (Date.now() - startTime > fetchBudgetMs) {
        timedOut = true;
        break;
      }

      let eventsData;
      if (nextUrl) {
        const authHeader = 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64');
        const resp = await fetch(nextUrl, { method: 'GET', headers: { 'Authorization': authHeader } });
        if (!resp.ok) break;
        eventsData = await resp.json();
      } else {
        eventsData = await fetchMailgunEvents(emailDomain, {
          event: eventType, begin: beginDate, end: endDate, limit: 300, ascending: 'yes'
        });
      }

      const items = eventsData.items || [];
      if (items.length === 0) { hasMore = false; break; }

      for (const event of items) {
        const { messageId, recipientEmail, timestamp } = extractEventIdentifiers(event);
        if (!messageId && !recipientEmail) continue;

        const matchesByMessageId = messageId && messageIds.has(messageId);
        const matchesByEmail = recipientEmail && recipientEmails.has(recipientEmail);
        if (!matchesByMessageId && !matchesByEmail) continue;

        if (event.id && existingEventIds.has(event.id)) { skipped++; continue; }

        const recipient = lookupRecipient(messageId, recipientEmail, recipientsByMsgId, recipientsByEmail);
        if (!recipient) { skipped++; continue; }

        existingEventIds.add(event.id);
        totalEvents++;

        pendingInsertRows.push(buildEventRow(event, campaign.id, tenantId, recipient, messageId, recipientEmail, timestamp));

        const state = recipientStates.get(recipient.id);
        if (state) {
          applyEventToRecipientState(state, event, timestamp);
          processed++;
        }
      }

      nextUrl = eventsData.paging?.next;
      if (!nextUrl) hasMore = false;
    }
  }

  if (totalEvents > 0) {
    console.log(`[Mailgun Sync] Campaign ${campaign.id}: Fetch done, ${totalEvents} events, ${processed} applied. Flushing...`);

    const insertBatches = [];
    for (let i = 0; i < pendingInsertRows.length; i += INSERT_BATCH_SIZE) {
      insertBatches.push(pendingInsertRows.slice(i, i + INSERT_BATCH_SIZE));
    }

    const INSERT_CONCURRENCY = 5;
    async function flushInserts() {
      for (let i = 0; i < insertBatches.length; i += INSERT_CONCURRENCY) {
        const chunk = insertBatches.slice(i, i + INSERT_CONCURRENCY);
        const results = await Promise.all(chunk.map(batch =>
          supabase.from('email_event').insert(batch)
        ));
        for (const r of results) {
          if (r.error) {
            console.error(`[Mailgun Sync] Batch insert error:`, r.error.message);
            errors += INSERT_BATCH_SIZE;
          }
        }
      }
    }

    await Promise.all([
      flushInserts(),
      flushRecipientUpdates(recipientStates),
      flushCampaignCounters(campaign.id, recipientStates),
      flushBounceAndUnsubscribe(recipientStates, tenantId, campaign.id),
    ]);
  } else {
    console.log(`[Mailgun Sync] Campaign ${campaign.id}: No new events found (${skipped} skipped as duplicates)`);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  return {
    totalEvents,
    processed,
    skipped,
    errors,
    timedOut,
    lastEventType: timedOut ? lastEventType : null,
    elapsedSeconds: elapsed,
  };
}
