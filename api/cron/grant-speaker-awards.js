// Task #3285: grant configured speaker awards (training vouchers + library
// badges) once an event's start time has passed. Speakers often change before
// the event, so nothing is granted at save time — this cron grants to the
// speakers attached at start.
//
// Idempotency: per-speaker rows in speaker_award_grant are claimed under a
// unique(event_type, event_id, speaker_id) constraint before any voucher or
// badge is created; the event is then stamped speaker_awards_granted_at so it
// never re-enters the queue.

import { supabase } from '../_lib/database.js';
import { grantSpeakerAwardsForEvent, normalizeSpeakerAwardConfig } from '../_lib/speakerAwards.js';
import { sendPendingSpeakerAwardNotifications } from '../_lib/speakerAwardEmails.js';

const MAX_EVENTS_PER_RUN = 20;

export function checkCronAuthorization(headers, cronSecret) {
  if (!cronSecret) return { status: 500, error: 'Cron secret not configured' };
  if (headers?.authorization !== `Bearer ${cronSecret}`) return { status: 401, error: 'Unauthorized' };
  return null;
}

export function buildSpeakerAwardEventQueue(simpleEvents, complexEvents, limit = MAX_EVENTS_PER_RUN) {
  return [
    ...(simpleEvents || [])
      .filter(event => event.event_state !== 'draft')
      .map(event => ({ eventType: 'event', event })),
    ...(complexEvents || [])
      .filter(event => event.event_state !== 'draft')
      .map(event => ({ eventType: 'complex_event', event })),
  ]
    .sort((a, b) =>
      String(a.event.start_date).localeCompare(String(b.event.start_date))
      || String(a.event.id).localeCompare(String(b.event.id))
    )
    .slice(0, limit);
}

export async function loadEligibleSpeakerAwardEvents(db, nowIso) {
  const [simpleRes, complexRes] = await Promise.all([
    db
      .from('event')
      .select('id, tenant_id, title, start_date, speaker_ids, speaker_award_config, speaker_awards_granted_at, status, event_state')
      .not('speaker_award_config', 'is', null)
      .is('speaker_awards_granted_at', null)
      .eq('status', 'published')
      .or('event_state.is.null,event_state.neq.draft')
      .lte('start_date', nowIso)
      .order('start_date', { ascending: true })
      .limit(MAX_EVENTS_PER_RUN),
    db
      .from('complex_event')
      .select('id, tenant_id, title, start_date, speaker_award_config, speaker_awards_granted_at, status, event_state')
      .not('speaker_award_config', 'is', null)
      .is('speaker_awards_granted_at', null)
      .eq('status', 'published')
      .or('event_state.is.null,event_state.neq.draft')
      .lte('start_date', nowIso)
      .order('start_date', { ascending: true })
      .limit(MAX_EVENTS_PER_RUN),
  ]);
  if (simpleRes.error) throw new Error(`event query failed: ${simpleRes.error.message}`);
  if (complexRes.error) throw new Error(`complex_event query failed: ${complexRes.error.message}`);
  return buildSpeakerAwardEventQueue(simpleRes.data, complexRes.data);
}

export function createGrantSpeakerAwardsHandler({
  db = supabase,
  getCronSecret = () => process.env.CRON_SECRET,
  grantAwards = grantSpeakerAwardsForEvent,
  sendNotifications = sendPendingSpeakerAwardNotifications,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = getCronSecret();

  // Fail closed: this job creates vouchers (money-like) — never run unauthenticated.
  const authError = checkCronAuthorization({ authorization: authHeader }, cronSecret);
  if (authError?.status === 500) {
    console.error('[cron/grant-speaker-awards] CRON_SECRET is not configured; refusing to run');
    return res.status(authError.status).json({ error: authError.error });
  }
  if (authError) {
    return res.status(authError.status).json({ error: authError.error });
  }
  if (!db) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const nowIso = now().toISOString();
  const summary = { processed: 0, granted: 0, skipped: 0, notified: 0, errors: [] };

  try {
    const queue = await loadEligibleSpeakerAwardEvents(db, nowIso);

    for (const { eventType, event } of queue) {
      try {
        const config = normalizeSpeakerAwardConfig(event.speaker_award_config);
        if (!config || !config.enabled || !event.tenant_id) {
          // Nothing to do — stamp so it never re-enters the queue.
          await stampGranted(db, eventType, event.id, event.tenant_id);
          continue;
        }

        const speakerIds = await collectSpeakerIds(db, eventType, event);
        let speakers = [];
        if (speakerIds.length > 0) {
          const { data, error } = await db
            .from('speaker')
            .select('id, full_name, email, member_id')
            .in('id', speakerIds)
            .eq('tenant_id', event.tenant_id);
          if (error) throw new Error(`speaker fetch failed: ${error.message}`);
          speakers = data || [];
        }

        const results = await grantAwards(db, { eventType, event, speakers });

        // Only stamp the event once no grant is left pending — checked
        // against the DATABASE (not just this run's results) so grants from
        // earlier runs are never abandoned. Pending rows are retried next run.
        let pendingCount = results.filter(r => r.status === 'pending').length;
        if (pendingCount === 0) {
          const { count, error: pendErr } = await db
            .from('speaker_award_grant')
            .select('id', { count: 'exact', head: true })
            .eq('event_type', eventType)
            .eq('event_id', event.id)
            .eq('tenant_id', event.tenant_id)
            .eq('status', 'pending');
          if (pendErr) throw new Error(`pending count failed: ${pendErr.message}`);
          pendingCount = count || 0;
        }
        if (pendingCount === 0) {
          await stampGranted(db, eventType, event.id, event.tenant_id);
        } else {
          summary.errors.push({ eventType, eventId: event.id, error: `${pendingCount} grant(s) pending, will retry` });
        }

        summary.processed += 1;
        summary.granted += results.filter(r => r.status === 'granted').length;
        summary.skipped += results.filter(r => r.status !== 'granted' && r.status !== 'pending').length;
        console.log(`[cron/grant-speaker-awards] ${eventType} ${event.id} "${event.title}": ${JSON.stringify(results.map(r => ({ s: r.speaker_id, st: r.status })))}`);
      } catch (err) {
        // Leave the event unstamped so the next run retries it.
        console.error(`[cron/grant-speaker-awards] ${eventType} ${event.id} failed: ${err.message}`);
        summary.errors.push({ eventType, eventId: event.id, error: err.message });
      }
    }

    // Task #3287: notify speakers/organisations for granted awards. Runs as a
    // sweep over ALL granted-but-unnotified rows — deliberately independent of
    // the event's speaker_awards_granted_at stamp, so notification sends that
    // failed on an earlier run are retried even after the event has left the
    // grant queue above. Exactly-once per recipient is guarded by
    // member_notified_at/org_notified_at claims inside the helper; it never
    // throws.
    const notifySummary = await sendNotifications({ db });
    summary.notified += notifySummary.notified;
    if (notifySummary.failed > 0) {
      summary.errors.push({ error: `${notifySummary.failed} award notification(s) failed, will retry next run` });
    }

    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error('[cron/grant-speaker-awards] run failed:', err.message);
    return res.status(500).json({ error: err.message, ...summary });
  }
  };
}

export default createGrantSpeakerAwardsHandler();

export async function collectSpeakerIds(db, eventType, event) {
  if (eventType === 'event') {
    const ids = new Set(Array.isArray(event.speaker_ids) ? event.speaker_ids.filter(Boolean) : []);
    // Training events also attach speakers per agenda item (Task #3436);
    // per-item speakers are event speakers for award purposes. Non-training
    // events simply have no agenda rows.
    const { data, error } = await db
      .from('event_agenda_item')
      .select('speaker_ids')
      .eq('event_id', event.id)
      .eq('tenant_id', event.tenant_id);
    if (error) throw new Error(`agenda fetch failed: ${error.message}`);
    (data || []).forEach(l => (Array.isArray(l.speaker_ids) ? l.speaker_ids : []).forEach(id => id && ids.add(id)));
    return [...ids];
  }
  // Complex events attach speakers per session.
  const { data, error } = await db
    .from('complex_event_session')
    .select('speaker_ids')
    .eq('complex_event_id', event.id)
    .eq('tenant_id', event.tenant_id);
  if (error) throw new Error(`session fetch failed: ${error.message}`);
  const ids = new Set();
  (data || []).forEach(s => (Array.isArray(s.speaker_ids) ? s.speaker_ids : []).forEach(id => id && ids.add(id)));
  return [...ids];
}

async function stampGranted(db, eventType, eventId, tenantId) {
  const table = eventType === 'event' ? 'event' : 'complex_event';
  const { error } = await db
    .from(table)
    .update({ speaker_awards_granted_at: new Date().toISOString() })
    .eq('id', eventId)
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`failed to stamp ${table} ${eventId}: ${error.message}`);
}
