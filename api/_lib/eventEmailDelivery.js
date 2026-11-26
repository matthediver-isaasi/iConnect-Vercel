// Event email delivery ledger: one row per confirmation/reminder/follow-up
// send attempt, matched to Mailgun events via a dedicated custom variable.
// Ledger failures are logged and swallowed: they must never block, retry or
// duplicate the real email send.
import { classifyEmailDelivery } from './emailDeliveryClassification.js';

export const EVENT_EMAIL_DELIVERY_VARIABLE = 'iconn_event_email_delivery';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDeliveryId = value => typeof value === 'string' && UUID.test(value);
const uuidOrNull = value => (isDeliveryId(value) ? value : null);

export function normalizeMessageId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^<|>$/g, '');
  return trimmed || null;
}

export async function createEventEmailDelivery(db, context) {
  try {
    if (!db || !context?.tenantId || !context?.eventId || !context?.recipientEmail || !context?.emailType) return null;
    const { data, error } = await db.from('event_email_delivery').insert({
      tenant_id: context.tenantId,
      event_id: context.eventId,
      event_email_id: uuidOrNull(context.eventEmailId),
      email_type: context.emailType,
      booking_id: uuidOrNull(context.bookingId),
      recipient_email: String(context.recipientEmail).trim(),
      scheduled_email_id: uuidOrNull(context.scheduledEmailId),
      send_source: context.source || null,
    }).select('id').single();
    if (error) throw error;
    return isDeliveryId(data?.id) ? data.id : null;
  } catch (error) {
    console.warn('[eventEmailDelivery] Could not create ledger row:', error?.message || error);
    return null;
  }
}

export async function recordEventEmailSendResult(db, deliveryId, result, now = new Date()) {
  if (!deliveryId) return;
  try {
    const accepted = Boolean(result?.success);
    const { error } = await db.rpc('record_event_email_send_result', {
      p_delivery_id: deliveryId,
      p_accepted: accepted,
      p_message_id: accepted ? normalizeMessageId(result?.messageId) : null,
      p_domain: accepted ? (result?.domain || null) : null,
      p_reason: accepted ? null : String(result?.error || 'Send failed').slice(0, 1000),
      p_at: now.toISOString(),
    });
    if (error) throw error;
  } catch (error) {
    console.warn('[eventEmailDelivery] Could not record send result:', error?.message || error);
  }
}

// Wraps a single send. `send(payload)` is called exactly once regardless of
// ledger availability; its result (or thrown error) is returned unchanged.
export async function sendTrackedEventEmail(db, context, payload, send) {
  const deliveryId = await createEventEmailDelivery(db, context);
  let result;
  try {
    result = await send(deliveryId ? { ...payload, eventEmailDelivery: deliveryId } : payload);
  } catch (error) {
    await recordEventEmailSendResult(db, deliveryId, { success: false, error: error?.message || 'Send failed' });
    throw error;
  }
  await recordEventEmailSendResult(db, deliveryId, result);
  return result;
}

export function eventEmailDeliveryIdFrom(eventData) {
  const value = eventData?.['user-variables']?.[EVENT_EMAIL_DELIVERY_VARIABLE];
  return isDeliveryId(value) ? value : null;
}

export function eventEmailProviderKind(eventData) {
  if (eventData?.event === 'opened') return 'opened';
  return classifyEmailDelivery(eventData || {});
}

export async function applyEventEmailProviderEvent(db, eventData) {
  const deliveryId = eventEmailDeliveryIdFrom(eventData);
  if (!deliveryId) return null;
  const messageId = normalizeMessageId(eventData.message?.headers?.['message-id'] || eventData['message-id']);
  const at = eventData.timestamp ? new Date(eventData.timestamp * 1000) : new Date();
  const { data, error } = await db.rpc('apply_event_email_delivery_event', {
    p_delivery_id: deliveryId,
    p_message_id: messageId,
    p_kind: eventEmailProviderKind(eventData),
    p_event_type: eventData.event || null,
    p_event_at: at.toISOString(),
    p_reason: eventData.reason || eventData['delivery-status']?.message || eventData['delivery-status']?.description || null,
    p_provider_event_id: typeof eventData.id === 'string' && eventData.id ? eventData.id : null,
    // Compared with the ledger recipient so CC copies never affect the attendee row.
    p_recipient: typeof eventData.recipient === 'string' ? eventData.recipient : null,
  });
  if (error) throw error;
  return { deliveryId, messageId, ...(data || {}) };
}

export function displayStatus(row) {
  if (row.status === 'delivered') return 'delivered';
  if (row.status === 'failed') return row.failure_source === 'provider' ? 'bounced_or_failed' : 'not_sent';
  if (row.status === 'accepted') return 'awaiting_confirmation';
  return 'sending';
}

export async function loadEventEmailStats(db, tenantId, eventId) {
  const [{ data, error }, tracking] = await Promise.all([
    db.rpc('event_email_delivery_stats', { p_tenant_id: tenantId, p_event_id: eventId }),
    db.from('event_email_delivery_tracking').select('started_at').maybeSingle(),
  ]);
  if (error) throw error;
  if (tracking?.error) throw tracking.error;
  const emails = {};
  for (const row of data || []) {
    emails[row.event_email_id] = {
      total: Number(row.total) || 0,
      sent: Number(row.sent) || 0,
      delivered: Number(row.delivered) || 0,
      awaiting: Number(row.awaiting) || 0,
      opened: Number(row.opened) || 0,
      failed: Number(row.failed) || 0,
      sending: Number(row.sending) || 0,
      firstTrackedAt: row.first_tracked_at || null,
      lastSentAt: row.last_sent_at || null,
    };
  }
  return { trackingStartedAt: tracking?.data?.started_at || null, emails };
}

export async function loadEventEmailRecipients(db, tenantId, eventId, eventEmailId, { page = 1, pageSize = 25 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 25, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const from = (current - 1) * size;
  const { data, error, count } = await db.from('event_email_delivery')
    .select('id, recipient_email, status, failure_source, sent_at, delivered_at, first_opened_at, open_count, failed_at, failure_reason, temporary_failure_reason, created_at', { count: 'exact' })
    .eq('tenant_id', tenantId).eq('event_id', eventId).eq('event_email_id', eventEmailId)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .range(from, from + size - 1);
  if (error) throw error;
  return {
    page: current,
    pageSize: size,
    total: count ?? null,
    recipients: (data || []).map(row => ({
      id: row.id,
      email: row.recipient_email,
      status: displayStatus(row),
      sentAt: row.sent_at,
      attemptedAt: row.created_at,
      deliveredAt: row.delivered_at,
      openedAt: row.first_opened_at,
      opened: (row.open_count || 0) > 0,
      failedAt: row.failed_at,
      failureReason: row.status === 'failed' ? row.failure_reason : (row.status === 'accepted' ? row.temporary_failure_reason : null),
    })),
  };
}

// Recovery: re-read Mailgun events for recent tracked sends and apply any the
// webhook missed. Deduplication is by provider event id in the database.
const RECOVERY_EVENT_TYPES = ['delivered', 'opened', 'failed'];
export async function syncEventEmailDeliveries(db, fetchEvents, { domainForTenant, defaultDomain, deadline, lookbackDays = 7, fetchNext } = {}) {
  const summary = { domains: 0, events: 0, applied: 0, errors: 0, timedOut: false };
  const since = new Date(Date.now() - lookbackDays * 86400000);
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from('event_email_delivery')
      .select('id, tenant_id, mailgun_domain, created_at')
      .gte('created_at', since.toISOString()).not('mailgun_message_id', 'is', null)
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const byDomain = new Map();
  for (const row of rows) {
    const domain = row.mailgun_domain || domainForTenant?.(row.tenant_id) || defaultDomain;
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, { ids: new Set(), begin: row.created_at });
    const entry = byDomain.get(domain);
    entry.ids.add(row.id);
    if (row.created_at < entry.begin) entry.begin = row.created_at;
  }
  for (const [domain, entry] of byDomain) {
    summary.domains++;
    for (const event of RECOVERY_EVENT_TYPES) {
      let page = null;
      let first = true;
      while (first || page) {
        if (deadline && Date.now() > deadline) { summary.timedOut = true; return summary; }
        let data;
        try {
          data = first
            ? await fetchEvents(domain, { event, begin: String(Math.floor(new Date(entry.begin).getTime() / 1000) - 3600),
                end: String(Math.floor(Date.now() / 1000)), limit: 300, ascending: 'yes' })
            : await fetchNext(page);
        } catch (error) {
          summary.errors++;
          console.error('[eventEmailDelivery] Recovery fetch failed:', domain, error?.message);
          break;
        }
        first = false;
        const items = data?.items || [];
        for (const item of items) {
          const id = eventEmailDeliveryIdFrom(item);
          if (!id || !entry.ids.has(id)) continue;
          summary.events++;
          try {
            const outcome = await applyEventEmailProviderEvent(db, item);
            if (outcome?.applied) summary.applied++;
          } catch (error) {
            summary.errors++;
            console.error('[eventEmailDelivery] Recovery apply failed:', error?.message);
          }
        }
        page = items.length && fetchNext ? data?.paging?.next || null : null;
      }
    }
  }
  return summary;
}
