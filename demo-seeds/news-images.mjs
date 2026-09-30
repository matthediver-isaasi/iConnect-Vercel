// Demo news article feature images — storage + linking helpers (all demo tenants).
//
// AI feature images are generated OUTSIDE the seed runtime (image generation
// is only available in the Replit agent's CodeExecution sandbox); this module
// owns everything else: deterministic storage paths, uploads, prompt
// building, and the provenance-safe write of feature_image_url on `news_post`
// rows.
//
// Provenance rule (same as demo avatars/logos/event-images): a news post's
// existing feature_image_url is NEVER replaced — writes are fill-null only,
// enforced at the database with a compare-and-set, so an admin-uploaded or
// concurrently-set image always wins.
//
// Seeded-post identification:
//   - `news_post` has NO is_sample column; the deterministic seed slug prefix
//     ('demo-') is the only provenance marker (same approach as complex_event),
//     so the slug-prefix predicate is mandatory on every read AND write.

import crypto from 'crypto';

export const DEMO_NEWS_IMAGE_BUCKET = 'demo-avatars';
export const DEMO_NEWS_SLUG_PREFIX = 'demo-';

/** Deterministic per-article storage path so re-runs overwrite, not duplicate. */
export function demoNewsImageStoragePath(tenantId, slug) {
  const key = crypto.createHash('sha1').update(String(slug).trim()).digest('hex');
  return `${tenantId}/news-${key}.jpg`;
}

/**
 * Seeded demo news posts missing a feature image.
 * Returns a list: { id, slug, title, tags, feature_image_url }.
 */
export async function listDemoNewsNeedingImages(sb, tenantId, { slugPrefix = DEMO_NEWS_SLUG_PREFIX } = {}) {
  const { data, error } = await sb
    .from('news_post')
    .select('id, slug, title, tags, feature_image_url')
    .eq('tenant_id', tenantId)
    .ilike('slug', `${slugPrefix}%`)
    .is('feature_image_url', null)
    .order('slug')
    .limit(2000);
  if (error) throw new Error(`demo news image list failed: ${error.message}`);
  return data || [];
}

/** Upload (upsert) a JPEG buffer to the deterministic path; returns the public URL. */
export async function uploadDemoNewsImage(sb, { tenantId, slug, buffer, contentType = 'image/jpeg', bucket = DEMO_NEWS_IMAGE_BUCKET }) {
  const path = demoNewsImageStoragePath(tenantId, slug);
  const { error } = await sb.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`demo news image upload failed for ${slug}: ${error.message}`);
  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error(`demo news image public URL missing for ${slug}`);
  return data.publicUrl;
}

/**
 * Fill-null-only write of feature_image_url on `news_post`. The UPDATE itself
 * re-checks feature_image_url IS NULL (compare-and-set), so an image assigned
 * between read and write is never overwritten. The seed slug prefix is applied
 * as a provenance predicate on both read and write (news_post has no
 * is_sample column).
 */
export async function applyDemoNewsImage({ sb, tenantId, postId, url, slugPrefix = DEMO_NEWS_SLUG_PREFIX, log = console.log }) {
  const { data: post, error } = await sb
    .from('news_post')
    .select('id, slug, title, feature_image_url')
    .eq('id', postId)
    .eq('tenant_id', tenantId)
    .ilike('slug', `${slugPrefix}%`)
    .maybeSingle();
  if (error) throw new Error(`news post lookup failed: ${error.message}`);
  if (!post) throw new Error(`news_post row not found among the demo tenant's seeded posts`);
  if (post.feature_image_url === url) return true;
  if (post.feature_image_url) {
    log(`[demo-news-image] ${post.slug || postId} keeps existing image; not replacing`);
    return false;
  }
  const { data: updRows, error: upErr } = await sb
    .from('news_post')
    .update({ feature_image_url: url })
    .eq('id', postId)
    .eq('tenant_id', tenantId)
    .ilike('slug', `${slugPrefix}%`)
    .is('feature_image_url', null)
    .select('id');
  if (upErr) throw new Error(`news image link failed: ${upErr.message}`);
  if (!updRows || updRows.length === 0) {
    log(`[demo-news-image] ${post.slug || postId} got an image concurrently; not overwriting`);
    return false;
  }
  return true;
}

/**
 * Seed-time pass: link seeded news posts missing a feature image to
 * ALREADY-GENERATED images in storage (matched by deterministic path). The
 * seed runtime cannot generate images, so posts without a stored image are
 * counted and reported — callers should warn, never fail the seed over this.
 * Returns { linked, missing }.
 */
export async function linkExistingDemoNewsImages({ sb, tenantId, bucket = DEMO_NEWS_IMAGE_BUCKET, slugPrefix, log = console.log }) {
  const posts = await listDemoNewsNeedingImages(sb, tenantId, slugPrefix ? { slugPrefix } : {});
  if (posts.length === 0) return { linked: 0, missing: 0 };

  // One listing of the tenant's folder beats a per-post existence probe.
  const stored = new Set();
  for (let offset = 0; ; offset += 1000) {
    const { data: files, error } = await sb.storage.from(bucket).list(tenantId, { limit: 1000, offset });
    if (error) throw new Error(`demo news image storage list failed: ${error.message}`);
    for (const f of files || []) stored.add(`${tenantId}/${f.name}`);
    if (!files || files.length < 1000) break;
  }

  let linked = 0, missing = 0;
  for (const post of posts) {
    const path = demoNewsImageStoragePath(tenantId, post.slug);
    if (!stored.has(path)) { missing++; continue; }
    const { data } = sb.storage.from(bucket).getPublicUrl(path);
    const opts = { sb, tenantId, postId: post.id, url: data.publicUrl, log };
    if (slugPrefix) opts.slugPrefix = slugPrefix;
    if (await applyDemoNewsImage(opts)) linked++;
  }
  if (missing > 0) {
    log(`[demo-news-image] warning: ${missing} seeded news post(s) have no generated feature image in storage yet — run the news image generation pass (see demo-seeds/README.md, "Images (avatars, logos, event headers & news articles)")`);
  }
  return { linked, missing };
}

// ---------------------------------------------------------------------------
// Prompt building + generation pass (agent CodeExecution only)
// ---------------------------------------------------------------------------

/** Scene flavour by article tag/title; falls back to a generic editorial scene. */
const TAG_SCENES = [
  [/survey|research|report/i, 'a professional reviewing data charts and survey results on a laptop in a modern office, focused and engaged'],
  [/conference|event|programme/i, 'a professional membership association conference in a modern venue — delegates in conversation, name badges, branded signage in background, natural light'],
  [/career|student|graduate|recruit/i, 'a diverse group of young professionals at a careers event or campus setting, engaged in discussion, bright and optimistic atmosphere'],
  [/mentor/i, 'two professionals in a one-to-one mentoring conversation at a modern workplace café, relaxed and collegial'],
  [/guidance|guide|framework|cpd|training/i, 'a professional reading guidance documents at a well-lit desk, bookmarked reports and a laptop open, focused and purposeful'],
  [/policy|consultation|response|planning/i, 'professionals at a formal working group or policy meeting around a table, documents in hand, civic or government building setting'],
  [/biodiversity|ecology|nature/i, 'ecologists with clipboards conducting a nature survey in a green meadow or wetland, bright natural daylight'],
  [/net.?zero|carbon|climate|emission/i, 'a sustainability professional presenting net-zero data on a screen to colleagues, modern office, charts showing declining emissions'],
  [/esg|sustainability|reporting/i, 'a professional reviewing sustainability reports at a corporate desk, clean modern office, subtle greenery'],
];

/**
 * Build an AI image prompt for a wide editorial-style news feature image.
 * Works for any demo tenant: derives the scene from the post's tags/title
 * and an optional sector flavour ('environmental and sustainability' for AESP).
 */
export function buildNewsImagePrompt(post, { sector = 'professional' } = {}) {
  const hay = `${(post.tags || []).join(' ')} ${post.title || ''}`;
  const scene = (TAG_SCENES.find(([re]) => re.test(hay)) || [null,
    'a professional at a desk reviewing documents related to environmental and sustainability practice, modern UK office setting'])[1];
  const nature = /environment|sustainab|biodiversity|carbon|net zero|ecolog|green/i.test(`${sector} ${hay}`)
    ? ' Subtle environmental theme: touches of greenery, natural materials, or sustainable-looking setting.'
    : '';
  return (
    `Wide-format editorial photograph for a news article feature image: ${scene}. ` +
    `Context: published by a ${sector} membership association in the UK.${nature} ` +
    `Photorealistic, natural colours, professional editorial photography style, ` +
    `16:9 landscape composition with clear space at the edges, no visible readable text, ` +
    `no logos, no watermarks.`
  );
}

/**
 * Find seeded news posts missing a feature image and generate+upload+link one
 * for each. generateFn: async (prompt, post) => Buffer<JPEG>. Agent
 * CodeExecution only — see demo-seeds/README.md.
 * Returns { generated, skipped, errors }.
 */
export async function runNewsImageGenerationPass({
  sb, tenantId, generateFn, sector, slugPrefix,
  bucket = DEMO_NEWS_IMAGE_BUCKET, log = console.log, concurrency = 3,
}) {
  const posts = await listDemoNewsNeedingImages(sb, tenantId, slugPrefix ? { slugPrefix } : {});
  if (posts.length === 0) {
    log('[demo-news-image-gen] No seeded news posts need a feature image — nothing to do.');
    return { generated: 0, skipped: 0, errors: 0 };
  }
  log(`[demo-news-image-gen] ${posts.length} news post(s) need a feature image. Starting generation…`);

  let generated = 0, skipped = 0, errors = 0;
  const processOne = async (post) => {
    const prompt = buildNewsImagePrompt(post, sector ? { sector } : {});
    const label = `news_post:${post.slug}`;
    log(`[demo-news-image-gen] generating: ${label}`);
    log(`[demo-news-image-gen]   prompt: ${prompt}`);
    try {
      const buffer = await generateFn(prompt, post);
      const url = await uploadDemoNewsImage(sb, { tenantId, slug: post.slug, buffer, bucket });
      const opts = { sb, tenantId, postId: post.id, url, log };
      if (slugPrefix) opts.slugPrefix = slugPrefix;
      if (await applyDemoNewsImage(opts)) { generated++; log(`[demo-news-image-gen] ✓ ${label}`); }
      else { skipped++; log(`[demo-news-image-gen] ~ ${label} — already has an image, skipped`); }
    } catch (err) {
      errors++;
      log(`[demo-news-image-gen] ✗ ${label} — ${err.message}`);
    }
  };

  const active = [];
  for (const post of posts) {
    const p = processOne(post).then(() => active.splice(active.indexOf(p), 1));
    active.push(p);
    if (active.length >= concurrency) await Promise.race(active);
  }
  await Promise.all(active);

  log(`[demo-news-image-gen] done — generated ${generated}, skipped ${skipped}, errors ${errors}`);
  return { generated, skipped, errors };
}
