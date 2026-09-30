// Demo event header images — storage + linking helpers (all demo tenants).
//
// AI header images are generated OUTSIDE the seed runtime (image generation
// is only available in the Replit agent's CodeExecution sandbox); this module
// owns everything else: deterministic storage paths, uploads, prompt
// building, and the provenance-safe write of image_url on `event` and
// `complex_event` rows.
//
// Provenance rule (same as demo avatars/logos): an event's existing
// image_url is NEVER replaced — writes are fill-null only, enforced at the
// database with a compare-and-set, so an admin-uploaded or concurrently-set
// image always wins.
//
// Seeded-event identification:
//   - `event` rows carry is_sample = true AND a deterministic seed slug
//     (default prefix 'demo-').
//   - `complex_event` has NO is_sample column; the deterministic seed slug
//     prefix + the manifest are the only provenance markers, so the slug
//     prefix predicate is mandatory on every read AND write.

import crypto from 'crypto';

export const DEMO_EVENT_IMAGE_BUCKET = 'demo-avatars';
export const DEMO_EVENT_SLUG_PREFIX = 'demo-';

/** Deterministic per-event storage path so re-runs overwrite, not duplicate. */
export function demoEventImageStoragePath(tenantId, slug) {
  const key = crypto.createHash('sha1').update(String(slug).trim()).digest('hex');
  return `${tenantId}/event-${key}.jpg`;
}

/**
 * Seeded demo events (simple + complex) missing a header image.
 * Returns a unified list: { table, id, slug, title, event_type, location, is_online }.
 */
export async function listDemoEventsNeedingImages(sb, tenantId, { slugPrefix = DEMO_EVENT_SLUG_PREFIX } = {}) {
  const out = [];
  const { data: simple, error: e1 } = await sb
    .from('event')
    .select('id, slug, title, event_type, location, is_online, image_url')
    .eq('tenant_id', tenantId)
    .eq('is_sample', true)
    .ilike('slug', `${slugPrefix}%`)
    .is('image_url', null)
    .order('slug')
    .limit(2000);
  if (e1) throw new Error(`demo event image list failed: ${e1.message}`);
  for (const r of simple || []) out.push({ table: 'event', ...r });

  const { data: complex, error: e2 } = await sb
    .from('complex_event')
    .select('id, slug, title, event_type, location, is_online, image_url')
    .eq('tenant_id', tenantId)
    .ilike('slug', `${slugPrefix}%`)
    .is('image_url', null)
    .order('slug')
    .limit(2000);
  if (e2) throw new Error(`demo complex event image list failed: ${e2.message}`);
  for (const r of complex || []) out.push({ table: 'complex_event', ...r });
  return out;
}

/** Upload (upsert) a JPEG buffer to the deterministic path; returns the public URL. */
export async function uploadDemoEventImage(sb, { tenantId, slug, buffer, contentType = 'image/jpeg', bucket = DEMO_EVENT_IMAGE_BUCKET }) {
  const path = demoEventImageStoragePath(tenantId, slug);
  const { error } = await sb.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`demo event image upload failed for ${slug}: ${error.message}`);
  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error(`demo event image public URL missing for ${slug}`);
  return data.publicUrl;
}

/**
 * Fill-null-only write of image_url on `event` or `complex_event`. The
 * UPDATE itself re-checks image_url IS NULL (compare-and-set), so an image
 * assigned between read and write is never overwritten. Provenance
 * predicates are applied on the UPDATE too: is_sample for `event`, the seed
 * slug prefix for `complex_event` (which has no is_sample column).
 */
export async function applyDemoEventImage({ sb, tenantId, table, eventId, url, slugPrefix = DEMO_EVENT_SLUG_PREFIX, log = console.log }) {
  if (table !== 'event' && table !== 'complex_event') {
    throw new Error(`unsupported table for demo event image: ${table}`);
  }
  const provenance = (q) => table === 'event'
    ? q.eq('is_sample', true).ilike('slug', `${slugPrefix}%`)
    : q.ilike('slug', `${slugPrefix}%`);

  const { data: ev, error } = await provenance(
    sb.from(table).select('id, slug, title, image_url')
      .eq('id', eventId).eq('tenant_id', tenantId),
  ).maybeSingle();
  if (error) throw new Error(`event lookup failed: ${error.message}`);
  if (!ev) throw new Error(`${table} row not found among the demo tenant's seeded events`);
  if (ev.image_url === url) return true;
  if (ev.image_url) {
    log(`[demo-event-image] ${ev.slug || eventId} keeps existing image; not replacing`);
    return false;
  }
  const { data: updRows, error: upErr } = await provenance(
    sb.from(table).update({ image_url: url })
      .eq('id', eventId).eq('tenant_id', tenantId)
      .is('image_url', null),
  ).select('id');
  if (upErr) throw new Error(`event image link failed: ${upErr.message}`);
  if (!updRows || updRows.length === 0) {
    log(`[demo-event-image] ${ev.slug || eventId} got an image concurrently; not overwriting`);
    return false;
  }
  return true;
}

/**
 * Seed-time pass: link seeded events missing a header image to
 * ALREADY-GENERATED images in storage (matched by deterministic path). The
 * seed runtime cannot generate images, so events without a stored image are
 * counted and reported — callers should warn, never fail the seed over this.
 * Returns { linked, missing }.
 */
export async function linkExistingDemoEventImages({ sb, tenantId, bucket = DEMO_EVENT_IMAGE_BUCKET, slugPrefix, log = console.log }) {
  const events = await listDemoEventsNeedingImages(sb, tenantId, slugPrefix ? { slugPrefix } : {});
  if (events.length === 0) return { linked: 0, missing: 0 };

  // One listing of the tenant's folder beats a per-event existence probe.
  const stored = new Set();
  for (let offset = 0; ; offset += 1000) {
    const { data: files, error } = await sb.storage.from(bucket).list(tenantId, { limit: 1000, offset });
    if (error) throw new Error(`demo event image storage list failed: ${error.message}`);
    for (const f of files || []) stored.add(`${tenantId}/${f.name}`);
    if (!files || files.length < 1000) break;
  }

  let linked = 0, missing = 0;
  for (const ev of events) {
    const path = demoEventImageStoragePath(tenantId, ev.slug);
    if (!stored.has(path)) { missing++; continue; }
    const { data } = sb.storage.from(bucket).getPublicUrl(path);
    const opts = { sb, tenantId, table: ev.table, eventId: ev.id, url: data.publicUrl, log };
    if (slugPrefix) opts.slugPrefix = slugPrefix;
    if (await applyDemoEventImage(opts)) linked++;
  }
  if (missing > 0) {
    log(`[demo-event-image] warning: ${missing} seeded event(s) have no generated header image in storage yet — run the event image generation pass (see demo-seeds/README.md, "Images (avatars, logos & event headers)")`);
  }
  return { linked, missing };
}

// ---------------------------------------------------------------------------
// Prompt building + generation pass (agent CodeExecution only)
// ---------------------------------------------------------------------------

/** Scene flavour by event type/tag; falls back to a generic conference scene. */
const TYPE_SCENES = [
  [/webinar/i, 'a professional working at a modern desk setup joining an online video presentation, laptop showing a slide deck, bright contemporary home-office or open-plan office'],
  [/conference/i, 'a large modern conference hall with an audience facing a keynote stage, ambient stage lighting, wide angle'],
  [/workshop|training|cpd/i, 'a small group of professionals collaborating around a table with notebooks and a facilitator at a whiteboard, bright modern training room'],
  [/site visit|visit/i, 'a small group in hi-vis vests and hard hats being shown around a sustainable construction site with timber and green features, daylight'],
  [/networking/i, 'professionals mingling and chatting with drinks at an informal evening reception in a stylish contemporary venue'],
  [/governance|agm|meeting/i, 'a formal boardroom meeting of professionals around a long table, natural daylight, modern civic building'],
];

/**
 * Build an AI image prompt for a wide event header image. Works for any demo
 * tenant: derives the scene from the event's type/title and an optional
 * sector flavour ('environmental and sustainability' for AESP).
 */
export function buildEventImagePrompt(ev, { sector = 'professional' } = {}) {
  const hay = `${ev.event_type || ''} ${ev.title || ''}`;
  const scene = (TYPE_SCENES.find(([re]) => re.test(hay)) || [null,
    'a modern professional event venue with people attending a presentation'])[1];
  const nature = /environment|sustainab|biodiversity|carbon|net zero|eia|ecolog/i.test(`${sector} ${hay}`)
    ? ' Subtle environmental theme: touches of greenery, natural light, sustainable architecture.'
    : '';
  return (
    `Wide-format photograph for an event listing header: ${scene}. ` +
    `Context: a ${sector} membership association event in the UK.${nature} ` +
    `Photorealistic, natural colours, professional editorial photography style, ` +
    `16:9 landscape composition with clear space, no visible readable text, ` +
    `no logos, no watermarks.`
  );
}

/**
 * Find seeded events missing a header image and generate+upload+link one for
 * each. generateFn: async (prompt, ev) => Buffer<JPEG>. Agent CodeExecution
 * only — see demo-seeds/README.md.
 * Returns { generated, skipped, errors }.
 */
export async function runEventImageGenerationPass({
  sb, tenantId, generateFn, sector, slugPrefix,
  bucket = DEMO_EVENT_IMAGE_BUCKET, log = console.log, concurrency = 3,
}) {
  const events = await listDemoEventsNeedingImages(sb, tenantId, slugPrefix ? { slugPrefix } : {});
  if (events.length === 0) {
    log('[demo-event-image-gen] No seeded events need a header image — nothing to do.');
    return { generated: 0, skipped: 0, errors: 0 };
  }
  log(`[demo-event-image-gen] ${events.length} event(s) need a header image. Starting generation…`);

  let generated = 0, skipped = 0, errors = 0;
  const processOne = async (ev) => {
    const prompt = buildEventImagePrompt(ev, sector ? { sector } : {});
    const label = `${ev.table}:${ev.slug}`;
    log(`[demo-event-image-gen] generating: ${label}`);
    log(`[demo-event-image-gen]   prompt: ${prompt}`);
    try {
      const buffer = await generateFn(prompt, ev);
      const url = await uploadDemoEventImage(sb, { tenantId, slug: ev.slug, buffer, bucket });
      const opts = { sb, tenantId, table: ev.table, eventId: ev.id, url, log };
      if (slugPrefix) opts.slugPrefix = slugPrefix;
      if (await applyDemoEventImage(opts)) { generated++; log(`[demo-event-image-gen] ✓ ${label}`); }
      else { skipped++; log(`[demo-event-image-gen] ~ ${label} — already has an image, skipped`); }
    } catch (err) {
      errors++;
      log(`[demo-event-image-gen] ✗ ${label} — ${err.message}`);
    }
  };

  const active = [];
  for (const ev of events) {
    const p = processOne(ev).then(() => active.splice(active.indexOf(p), 1));
    active.push(p);
    if (active.length >= concurrency) await Promise.race(active);
  }
  await Promise.all(active);

  log(`[demo-event-image-gen] done — generated ${generated}, skipped ${skipped}, errors ${errors}`);
  return { generated, skipped, errors };
}
