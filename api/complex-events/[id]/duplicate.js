import { randomUUID } from 'crypto';
import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { recomputeComplexEventDates } from '../../_lib/complexEventDateSync.js';

const EVENT_FIELDS = [
  'title', 'summary', 'description', 'event_type', 'program_tag', 'start_date',
  'end_date', 'registration_closes_at', 'location', 'image_url',
  'image_focal_point', 'available_seats', 'is_unlimited_registration',
  'show_ticket_availability', 'is_online', 'speaker_ids', 'filter_tags',
  'allow_guests_to_view_all_tickets', 'collect_third_party_consent',
  'donation_config', 'seo_title', 'seo_description', 'og_image_url', 'timezone',
  'organization_id', 'program_id', 'pricing_config'
];

async function findUniqueSlug(tenantId, base) {
  const candidate = `${base}-copy`;
  let slug = candidate;
  let n = 1;
  while (true) {
    const { data } = await supabase
      .from('complex_event').select('id')
      .eq('tenant_id', tenantId).eq('slug', slug).maybeSingle();
    if (!data) return slug;
    n += 1; slug = `${candidate}-${n}`;
    if (n > 50) return `${candidate}-${randomUUID().slice(0, 8)}`;
  }
}

function stripPk(row) {
  const { id: _id, created_at, updated_at, ...rest } = row;
  return rest;
}

async function rollback(newEventId, tenantId) {
  if (!newEventId) return;
  // Best-effort manual rollback (Supabase JS has no transactions). Children with
  // ON DELETE CASCADE clean up automatically; we still try direct deletes for tables
  // that may be SET NULL.
  try { await supabase.from('complex_event_session_track').delete().in('complex_event_session_id',
    (await supabase.from('complex_event_session').select('id').eq('complex_event_id', newEventId)).data?.map(r => r.id) || []); } catch {}
  try { await supabase.from('complex_event_session').delete().eq('complex_event_id', newEventId).eq('tenant_id', tenantId); } catch {}
  try { await supabase.from('complex_event_track').delete().eq('complex_event_id', newEventId).eq('tenant_id', tenantId); } catch {}
  try { await supabase.from('complex_event_ticket_class').delete().eq('complex_event_id', newEventId).eq('tenant_id', tenantId); } catch {}
  try { await supabase.from('complex_event').delete().eq('id', newEventId).eq('tenant_id', tenantId); } catch {}
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Complex event id is required' });

  const ctx = await getTenantContext(req);
  if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
  if (!await hasAdminAccess(ctx)) return res.status(403).json({ error: 'Admin access required' });
  if (!ctx.tenantId) return res.status(403).json({ error: 'No tenant context' });

  const tenantId = ctx.tenantId;
  let newEventId = null;

  try {
    const { data: original, error: fetchErr } = await supabase
      .from('complex_event').select('*').eq('id', id).eq('tenant_id', tenantId).single();
    if (fetchErr || !original) return res.status(404).json({ error: 'Complex event not found' });

    const baseSlug = original.slug || (original.title || 'event')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const newSlug = await findUniqueSlug(tenantId, baseSlug);

    const insertEvent = { tenant_id: tenantId };
    for (const field of EVENT_FIELDS) if (field in original) insertEvent[field] = original[field];
    insertEvent.slug = newSlug;
    insertEvent.title = `${original.title || 'Event'} (Copy)`;
    insertEvent.status = 'draft';
    insertEvent.is_featured = false;
    insertEvent.history_log = [
      {
        action: 'duplicated_from',
        at: new Date().toISOString(),
        by: ctx.tenantUserId || ctx.memberId || null,
        source_event_id: original.id,
        source_slug: original.slug || null,
      },
    ];

    const { data: newEvent, error: insertErr } = await supabase
      .from('complex_event').insert(insertEvent).select('id, slug').single();
    if (insertErr || !newEvent) {
      console.error('[DuplicateComplexEvent] insert error:', insertErr);
      return res.status(500).json({ error: insertErr?.message || 'Failed to duplicate complex event' });
    }
    newEventId = newEvent.id;

    // Tracks
    const trackIdMap = new Map();
    const { data: tracks, error: trkFetchErr } = await supabase
      .from('complex_event_track').select('*')
      .eq('complex_event_id', id).eq('tenant_id', tenantId).order('display_order', { ascending: true });
    if (trkFetchErr) throw new Error(`fetch tracks: ${trkFetchErr.message}`);
    if (tracks && tracks.length > 0) {
      for (const t of tracks) {
        const r = stripPk(t);
        const { data: nt, error: trkInsErr } = await supabase
          .from('complex_event_track')
          .insert({ ...r, complex_event_id: newEventId, tenant_id: tenantId })
          .select('id').single();
        if (trkInsErr || !nt) throw new Error(`insert track: ${trkInsErr?.message}`);
        trackIdMap.set(t.id, nt.id);
      }
    }

    // Sessions (clear all zoom_*)
    const sessionIdMap = new Map();
    const { data: sessions, error: sFetchErr } = await supabase
      .from('complex_event_session').select('*')
      .eq('complex_event_id', id).eq('tenant_id', tenantId).order('start_time', { ascending: true });
    if (sFetchErr) throw new Error(`fetch sessions: ${sFetchErr.message}`);
    if (sessions && sessions.length > 0) {
      for (const s of sessions) {
        const r = stripPk(s);
        const { data: ns, error: sInsErr } = await supabase
          .from('complex_event_session')
          .insert({
            ...r,
            complex_event_id: newEventId,
            tenant_id: tenantId,
            zoom_meeting_id: null,
            zoom_webinar_id: null,
            zoom_join_url: null,
            zoom_start_url: null,
            zoom_registration_url: null,
          })
          .select('id').single();
        if (sInsErr || !ns) throw new Error(`insert session: ${sInsErr?.message}`);
        sessionIdMap.set(s.id, ns.id);
      }
    }

    // Session-track junctions
    if (sessionIdMap.size > 0 && trackIdMap.size > 0) {
      const oldSessionIds = Array.from(sessionIdMap.keys());
      const { data: junctions, error: jFetchErr } = await supabase
        .from('complex_event_session_track')
        .select('complex_event_session_id, complex_event_track_id, tenant_id')
        .in('complex_event_session_id', oldSessionIds).eq('tenant_id', tenantId);
      if (jFetchErr) throw new Error(`fetch junctions: ${jFetchErr.message}`);
      const junctionRows = (junctions || []).map(j => ({
        complex_event_session_id: sessionIdMap.get(j.complex_event_session_id),
        complex_event_track_id: trackIdMap.get(j.complex_event_track_id),
        tenant_id: tenantId,
      })).filter(r => r.complex_event_session_id && r.complex_event_track_id);
      if (junctionRows.length > 0) {
        const { error: jErr } = await supabase.from('complex_event_session_track').insert(junctionRows);
        if (jErr) throw new Error(`insert junctions: ${jErr.message}`);
      }
    }

    // Ticket classes (rewrite linked_track_ids via map)
    const { data: ticketClasses, error: tcFetchErr } = await supabase
      .from('complex_event_ticket_class').select('*')
      .eq('complex_event_id', id).eq('tenant_id', tenantId);
    if (tcFetchErr) throw new Error(`fetch ticket_classes: ${tcFetchErr.message}`);
    if (ticketClasses && ticketClasses.length > 0) {
      const tcRows = ticketClasses.map(tc => {
        const r = stripPk(tc);
        const linked = Array.isArray(r.linked_track_ids)
          ? r.linked_track_ids.map(tid => trackIdMap.get(tid)).filter(Boolean)
          : r.linked_track_ids;
        return { ...r, complex_event_id: newEventId, tenant_id: tenantId, linked_track_ids: linked };
      });
      const { error: tcErr } = await supabase.from('complex_event_ticket_class').insert(tcRows);
      if (tcErr) throw new Error(`insert ticket_classes: ${tcErr.message}`);
    }

    try {
      await recomputeComplexEventDates(supabase, newEventId, tenantId);
    } catch (recomputeErr) {
      console.error('[DuplicateComplexEvent] Date recompute failed:', recomputeErr?.message || recomputeErr);
    }

    console.log(`[DuplicateComplexEvent] ${id} → ${newEventId} tenant=${tenantId} tracks=${trackIdMap.size} sessions=${sessionIdMap.size} by=${ctx.tenantUserId || ctx.memberId || 'unknown'}`);
    return res.status(200).json({ id: newEventId, slug: newEvent.slug });
  } catch (err) {
    console.error('[DuplicateComplexEvent] error:', err);
    await rollback(newEventId, tenantId);
    return res.status(500).json({ error: err.message || 'Failed to duplicate complex event' });
  }
}
