/**
 * POST /api/webhooks/gocardless
 *
 * GoCardless webhook endpoint. Verifies the `Webhook-Signature` header
 * (HMAC-SHA256 of the raw body keyed by GOCARDLESS_WEBHOOK_SECRET),
 * durably logs every event to payment_webhook_events (unique on the
 * GoCardless event id — duplicate deliveries are acknowledged without
 * reprocessing), then processes each new event idempotently.
 *
 * Body parsing is disabled so the signature is verified against the raw
 * payload (same pattern as api/webhooks/stripe-plan.js).
 */

import { supabase } from '../_lib/database.js';
import { verifyWebhookSignature, createGocardlessClient } from '../_lib/gocardless.js';
import { getGocardlessCredentials } from '../_lib/gocardlessCredentials.js';
import { processGocardlessEvent } from '../_lib/gocardlessWebhookProcessor.js';

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  // Per-tenant webhook endpoints: each tenant connects their OWN GoCardless
  // account and registers this URL with ?tenant=<uuid>. The signature is
  // verified against THAT tenant's webhook secret (from tenant_integrations),
  // falling back to the platform GOCARDLESS_WEBHOOK_SECRET for the bare URL.
  const tenantId = typeof req.query?.tenant === 'string' && req.query.tenant ? req.query.tenant : null;
  let creds;
  try {
    creds = await getGocardlessCredentials(tenantId);
  } catch (err) {
    console.error(`[gocardless webhook] credential lookup failed: ${err.message}`);
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  if (!creds.webhookSecret) {
    console.error(`[gocardless webhook] no webhook secret configured (tenant=${tenantId || 'platform'})`);
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to read body' });
  }

  const signature = req.headers['webhook-signature'];
  if (!verifyWebhookSignature(raw, signature, creds.webhookSecret)) {
    console.error('[gocardless webhook] Invalid signature');
    // 498 is what GoCardless docs suggest for invalid signatures; any
    // non-2xx works — GC will retry, and retries with a bad secret keep
    // failing loudly instead of being silently accepted.
    return res.status(498).json({ error: 'Invalid webhook signature' });
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const events = Array.isArray(body?.events) ? body.events : [];
  const results = [];

  for (const event of events) {
    if (!event?.id) continue;

    // Durable insert with dedupe on (provider, event_id). If the row
    // already exists this delivery is a duplicate — acknowledge, skip.
    const { data: inserted, error: insErr } = await supabase
      .from('payment_webhook_events')
      .upsert({
        provider: 'gocardless',
        event_id: event.id,
        resource_type: event.resource_type || null,
        action: event.action || null,
        resource_id: event.links ? Object.values(event.links)[0] || null : null,
        tenant_id: tenantId,
        payload: event,
        processing_status: 'pending',
      }, { onConflict: 'provider,event_id', ignoreDuplicates: true })
      .select('id');

    if (insErr) {
      console.error(`[gocardless webhook] failed to log event ${event.id}: ${insErr.message}`);
      // Without a durable log we must not ack — let GC retry.
      return res.status(500).json({ error: 'Failed to log event' });
    }
    if (!inserted || inserted.length === 0) {
      results.push({ event: event.id, status: 'duplicate' });
      continue;
    }
    const rowId = inserted[0].id;

    try {
      const outcome = await processGocardlessEvent(event, { gc: createGocardlessClient(creds) });
      const { error: updErr } = await supabase
        .from('payment_webhook_events')
        .update({
          processing_status: outcome.handled ? 'processed' : 'skipped',
          processing_error: outcome.handled ? null : outcome.detail,
          processed_at: new Date().toISOString(),
        })
        .eq('id', rowId);
      if (updErr) console.error(`[gocardless webhook] failed to mark event ${event.id}: ${updErr.message}`);
      results.push({ event: event.id, status: outcome.handled ? 'processed' : 'skipped', detail: outcome.detail });
    } catch (err) {
      console.error(`[gocardless webhook] processing failed for ${event.id}: ${err.message}`);
      const { error: updErr } = await supabase
        .from('payment_webhook_events')
        .update({ processing_status: 'failed', processing_error: err.message, processed_at: new Date().toISOString() })
        .eq('id', rowId);
      if (updErr) console.error(`[gocardless webhook] failed to mark event failed ${event.id}: ${updErr.message}`);
      // Still 2xx: the event is durably logged; reconciliation/retry
      // handles repair. GC retrying the whole batch would duplicate work.
      results.push({ event: event.id, status: 'failed', error: err.message });
    }
  }

  return res.status(200).json({ received: events.length, results });
}
