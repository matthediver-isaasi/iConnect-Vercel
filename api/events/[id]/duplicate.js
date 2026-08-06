import { randomUUID } from 'crypto';
import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { authorizeGroupAdminEventAction } from '../../_lib/groupAdminEventWrite.js';

// Schedule fields are intentionally NOT copied — duplicates land as drafts
// with cleared dates so admins must explicitly set new dates before
// publishing.  Status reset is enforced below.
const FIELDS_TO_COPY = [
  'title', 'summary', 'description', 'internal_reference', 'xero_account_code',
  'event_type', 'program_tag',
  'location', 'image_url', 'image_focal_point', 'available_seats',
  'is_unlimited_registration', 'show_ticket_availability', 'show_seat_count',
  'is_online', 'pricing_config', 'speaker_ids', 'filter_tags',
  'allow_guests_to_view_all_tickets', 'collect_third_party_consent',
  'donation_config', 'seo_title', 'seo_description', 'og_image_url', 'event_timing', 'timezone',
  'organization_id', 'program_id', 'attached_documents', 'documents_section_title',
  'member_group_id', 'group_event_public', 'is_training'
];

// Best-effort deep-copy. Tables that don't exist in this tenant's schema
// are skipped silently via the "relation does not exist" guard below, so
// the matrix can safely include optional/legacy associations.
//
// `tenantScoped` indicates whether the child table has its own `tenant_id`
// column. When false, we fetch by FK only — the parent `event` row was
// already verified to belong to `ctx.tenantId`, so child rows scoped by
// `event_id` are implicitly tenant-safe — and we omit `tenant_id` from the
// insert payload (otherwise the insert would fail on a missing column).
const CHILD_TABLES = [
  // event_email has no tenant_id column (see docs/event_email_schema.sql).
  { table: 'event_email', fk: 'event_id', tenantScoped: false },
  { table: 'event_sponsor_assignment', fk: 'event_id', tenantScoped: true },
  { table: 'event_resource_link', fk: 'event_id', tenantScoped: true },
  { table: 'event_field', fk: 'event_id', tenantScoped: true },
  { table: 'event_cta_button', fk: 'event_id', tenantScoped: true },
  { table: 'event_booking_terms', fk: 'event_id', tenantScoped: true },
  { table: 'event_timing', fk: 'event_id', tenantScoped: true },
  // NOTE: event_attendees / booking / registration tables are intentionally
  // excluded — duplicates must never inherit attendance/booking data.
  { table: 'event_discount_code', fk: 'event_id', tenantScoped: true },
  { table: 'event_training_fund', fk: 'event_id', tenantScoped: true },
  // Training-event agenda lines (Task #3419). Dates are copied as-is — the
  // duplicate's event dates are cleared, so admins revisit the agenda anyway.
  { table: 'event_agenda_item', fk: 'event_id', tenantScoped: true },
];

async function findUniqueSlug(tenantId, base) {
  const candidate = `${base}-copy`;
  let slug = candidate;
  let n = 1;
  while (true) {
    const { data } = await supabase
      .from('event').select('id')
      .eq('tenant_id', tenantId).eq('slug', slug).maybeSingle();
    if (!data) return slug;
    n += 1; slug = `${candidate}-${n}`;
    if (n > 50) return `${candidate}-${randomUUID().slice(0, 8)}`;
  }
}

function rewriteTicketClasses(pricingConfig) {
  if (!pricingConfig || typeof pricingConfig !== 'object') return pricingConfig;
  const tcs = Array.isArray(pricingConfig.ticket_classes) ? pricingConfig.ticket_classes : [];
  return { ...pricingConfig, ticket_classes: tcs.map(tc => ({ ...tc, id: randomUUID() })) };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Event id is required' });

  const ctx = await getTenantContext(req);
  if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
  // Tenant admins pass; group admins may duplicate their own group's events
  // (the copy keeps member_group_id and, being a copy of a guarded group
  // event, stays free-ticket / zoom-free; it lands as a draft).
  const dupAuthz = await authorizeGroupAdminEventAction({
    eventId: id, eventTable: 'event', tenantCtx: ctx, req, requireTypeEnabled: true,
    denialError: 'You can only duplicate events for groups you administer',
  });
  if (!dupAuthz.ok) return res.status(dupAuthz.status || 403).json({ error: dupAuthz.error });
  if (!ctx.tenantId) return res.status(403).json({ error: 'No tenant context' });

  let createdEventId = null;
  try {
    const { data: original, error: fetchErr } = await supabase
      .from('event').select('*').eq('id', id).eq('tenant_id', ctx.tenantId).single();
    if (fetchErr || !original) return res.status(404).json({ error: 'Event not found' });

    const baseSlug = original.slug || (original.title || 'event')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const newSlug = await findUniqueSlug(ctx.tenantId, baseSlug);

    const insertRow = { tenant_id: ctx.tenantId };
    for (const field of FIELDS_TO_COPY) if (field in original) insertRow[field] = original[field];
    insertRow.title = `${original.title || 'Event'} (Copy)`;
    insertRow.slug = newSlug;
    insertRow.status = 'draft';
    insertRow.event_state = 'draft';
    insertRow.is_featured = false;
    // Schedule reset — admin must enter new dates before publishing
    insertRow.start_date = null;
    insertRow.end_date = null;
    insertRow.registration_closes_at = null;
    insertRow.zoom_webinar_id = null;
    insertRow.zoom_meeting_id = null;
    insertRow.backstage_event_id = null;
    insertRow.backstage_ticket_type_id = null;
    insertRow.backstage_public_url = null;
    insertRow.last_synced = null;
    insertRow.pricing_config = rewriteTicketClasses(original.pricing_config);
    insertRow.history_log = [
      {
        action: 'duplicated_from',
        at: new Date().toISOString(),
        by: ctx.tenantUserId || ctx.memberId || null,
        source_event_id: original.id,
        source_slug: original.slug || null,
      },
    ];

    const { data: created, error: insertErr } = await supabase
      .from('event').insert(insertRow).select('id, slug').single();
    if (insertErr || !created) {
      console.error('[DuplicateEvent] insert error:', insertErr);
      return res.status(500).json({ error: insertErr?.message || 'Failed to duplicate event' });
    }
    createdEventId = created.id;

    // Deep-copy child rows. On any error → rollback by deleting the new event row.
    for (const { table, fk, tenantScoped } of CHILD_TABLES) {
      try {
        let fetchQuery = supabase.from(table).select('*').eq(fk, id);
        if (tenantScoped) fetchQuery = fetchQuery.eq('tenant_id', ctx.tenantId);
        const { data: rows, error: childFetchErr } = await fetchQuery;
        if (childFetchErr) {
          // Table may not exist; skip silently.
          if (/relation .* does not exist|schema cache/i.test(childFetchErr.message || '')) continue;
          throw new Error(`fetch ${table}: ${childFetchErr.message}`);
        }
        if (!rows || rows.length === 0) continue;
        const inserts = rows.map(({ id: _id, created_at, updated_at, ...rest }) => {
          const row = { ...rest, [fk]: createdEventId };
          if (tenantScoped) row.tenant_id = ctx.tenantId;
          return row;
        });
        const { error: insChildErr } = await supabase.from(table).insert(inserts);
        if (insChildErr) throw new Error(`insert ${table}: ${insChildErr.message}`);
      } catch (err) {
        console.error(`[DuplicateEvent] ${table} copy failed, rolling back:`, err.message);
        await supabase.from('event').delete().eq('id', createdEventId).eq('tenant_id', ctx.tenantId);
        return res.status(500).json({ error: `Failed to copy ${table}: ${err.message}` });
      }
    }

    console.log(`[DuplicateEvent] ${id} → ${createdEventId} (slug=${created.slug}) tenant=${ctx.tenantId} by=${ctx.tenantUserId || ctx.memberId || 'unknown'}`);
    return res.status(200).json({ id: createdEventId, slug: created.slug });
  } catch (err) {
    console.error('[DuplicateEvent] error:', err);
    if (createdEventId) {
      try { await supabase.from('event').delete().eq('id', createdEventId).eq('tenant_id', ctx.tenantId); } catch {}
    }
    return res.status(500).json({ error: err.message || 'Failed to duplicate event' });
  }
}
