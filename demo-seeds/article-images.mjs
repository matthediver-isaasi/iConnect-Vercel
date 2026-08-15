// Demo article (blog post) feature images — storage + linking helpers (all
// demo tenants).
//
// AI feature images are generated OUTSIDE the seed runtime (image generation
// is only available in the Replit agent's CodeExecution sandbox); this module
// owns everything else: deterministic storage paths, uploads, prompt
// building, and the provenance-safe write of feature_image_url on `blog_post`
// rows.
//
// Provenance rule (same as demo avatars/logos/event-images/news-images): an
// article's existing feature_image_url is NEVER replaced — writes are
// fill-null only, enforced at the database with a compare-and-set, so an
// admin-uploaded or concurrently-set image always wins.
//
// Seeded-article identification:
//   - blog_post HAS an is_sample column, so provenance is double-gated:
//     is_sample = true AND the deterministic seed slug prefix ('demo-') on
//     every read AND write.

import crypto from 'crypto';

export const DEMO_ARTICLE_IMAGE_BUCKET = 'demo-avatars';
export const DEMO_ARTICLE_SLUG_PREFIX = 'demo-';

/** Deterministic per-article storage path so re-runs overwrite, not duplicate. */
export function demoArticleImageStoragePath(tenantId, slug) {
  const key = crypto.createHash('sha1').update(String(slug).trim()).digest('hex');
  return `${tenantId}/article-${key}.jpg`;
}

/**
 * Seeded demo articles missing a feature image.
 * Returns a list: { id, slug, title, tags, subcategories, feature_image_url }.
 */
export async function listDemoArticlesNeedingImages(sb, tenantId, { slugPrefix = DEMO_ARTICLE_SLUG_PREFIX } = {}) {
  const { data, error } = await sb
    .from('blog_post')
    .select('id, slug, title, tags, subcategories, feature_image_url')
    .eq('tenant_id', tenantId)
    .eq('is_sample', true)
    .ilike('slug', `${slugPrefix}%`)
    .is('feature_image_url', null)
    .order('slug')
    .limit(2000);
  if (error) throw new Error(`demo article image list failed: ${error.message}`);
  return data || [];
}

/** Upload (upsert) a JPEG buffer to the deterministic path; returns the public URL. */
export async function uploadDemoArticleImage(sb, { tenantId, slug, buffer, contentType = 'image/jpeg', bucket = DEMO_ARTICLE_IMAGE_BUCKET }) {
  const path = demoArticleImageStoragePath(tenantId, slug);
  const { error } = await sb.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`demo article image upload failed for ${slug}: ${error.message}`);
  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error(`demo article image public URL missing for ${slug}`);
  return data.publicUrl;
}

/**
 * Fill-null-only write of feature_image_url on `blog_post`. The UPDATE itself
 * re-checks feature_image_url IS NULL (compare-and-set), so an image assigned
 * between read and write is never overwritten. Provenance predicates
 * (is_sample + seed slug prefix) are applied on both read and write.
 */
export async function applyDemoArticleImage({ sb, tenantId, postId, url, slugPrefix = DEMO_ARTICLE_SLUG_PREFIX, log = console.log }) {
  const { data: post, error } = await sb
    .from('blog_post')
    .select('id, slug, title, feature_image_url')
    .eq('id', postId)
    .eq('tenant_id', tenantId)
    .eq('is_sample', true)
    .ilike('slug', `${slugPrefix}%`)
    .maybeSingle();
  if (error) throw new Error(`article lookup failed: ${error.message}`);
  if (!post) throw new Error(`blog_post row not found among the demo tenant's seeded articles`);
  if (post.feature_image_url === url) return true;
  if (post.feature_image_url) {
    log(`[demo-article-image] ${post.slug || postId} keeps existing image; not replacing`);
    return false;
  }
  const { data: updRows, error: upErr } = await sb
    .from('blog_post')
    .update({ feature_image_url: url })
    .eq('id', postId)
    .eq('tenant_id', tenantId)
    .eq('is_sample', true)
    .ilike('slug', `${slugPrefix}%`)
    .is('feature_image_url', null)
    .select('id');
  if (upErr) throw new Error(`article image link failed: ${upErr.message}`);
  if (!updRows || updRows.length === 0) {
    log(`[demo-article-image] ${post.slug || postId} got an image concurrently; not overwriting`);
    return false;
  }
  return true;
}

/**
 * Seed-time pass: link seeded articles missing a feature image to
 * ALREADY-GENERATED images in storage (matched by deterministic path). The
 * seed runtime cannot generate images, so articles without a stored image are
 * counted and reported — callers should warn, never fail the seed over this.
 * Returns { linked, missing }.
 */
export async function linkExistingDemoArticleImages({ sb, tenantId, bucket = DEMO_ARTICLE_IMAGE_BUCKET, slugPrefix, log = console.log }) {
  const posts = await listDemoArticlesNeedingImages(sb, tenantId, slugPrefix ? { slugPrefix } : {});
  if (posts.length === 0) return { linked: 0, missing: 0 };

  // One listing of the tenant's folder beats a per-article existence probe.
  const stored = new Set();
  for (let offset = 0; ; offset += 1000) {
    const { data: files, error } = await sb.storage.from(bucket).list(tenantId, { limit: 1000, offset });
    if (error) throw new Error(`demo article image storage list failed: ${error.message}`);
    for (const f of files || []) stored.add(`${tenantId}/${f.name}`);
    if (!files || files.length < 1000) break;
  }

  let linked = 0, missing = 0;
  for (const post of posts) {
    const path = demoArticleImageStoragePath(tenantId, post.slug);
    if (!stored.has(path)) { missing++; continue; }
    const { data } = sb.storage.from(bucket).getPublicUrl(path);
    const opts = { sb, tenantId, postId: post.id, url: data.publicUrl, log };
    if (slugPrefix) opts.slugPrefix = slugPrefix;
    if (await applyDemoArticleImage(opts)) linked++;
  }
  if (missing > 0) {
    log(`[demo-article-image] warning: ${missing} seeded article(s) have no generated feature image in storage yet — run the article image generation pass (see demo-seeds/README.md, "Images (avatars, logos, event headers & news articles)")`);
  }
  return { linked, missing };
}

// ---------------------------------------------------------------------------
// Prompt building + generation pass (agent CodeExecution only)
// ---------------------------------------------------------------------------

/** Scene flavour by article tag/subcategory/title; falls back to a generic editorial scene. */
const TAG_SCENES = [
  [/career|student|graduate|mentor/i, 'a diverse group of professionals at different career stages in conversation at a modern workplace or campus, bright and optimistic atmosphere'],
  [/biodiversity|ecology|nature|bng|habitat/i, 'ecologists conducting a field survey in a green meadow, woodland edge or wetland, clipboards and field kit, bright natural daylight'],
  [/net.?zero|carbon|climate|emission|transition/i, 'a sustainability professional presenting decarbonisation data on a large screen to colleagues, modern office, charts showing declining emissions'],
  [/esg|reporting|disclosure|assurance/i, 'a professional reviewing sustainability and ESG reports at a corporate desk, clean modern office, subtle greenery'],
  [/eia|planning|consent|infrastructure/i, 'environmental professionals reviewing large site plans and environmental statements around a table, hard hats and hi-vis nearby, infrastructure project office'],
  [/policy|consultation|regulation|law/i, 'professionals at a formal policy working group around a table, documents in hand, civic or government building setting'],
  [/energy|renewable|wind|solar/i, 'an engineer and consultant reviewing plans near a renewable energy installation, wind turbines or solar panels in soft focus behind them'],
  [/construction|building|retrofit/i, 'a sustainability consultant and site manager reviewing plans on a low-carbon construction site, timber structure and green materials visible'],
  [/water|river|flood/i, 'an environmental scientist taking water samples by a UK river, waders and sampling kit, overcast natural light'],
  [/data|digital|ai|technology/i, 'an environmental analyst working with mapping and data dashboards across two monitors, modern office, focused'],
];

/**
 * Build an AI image prompt for a wide editorial-style article feature image.
 * Works for any demo tenant: derives the scene from the article's tags,
 * subcategories and title, plus an optional sector flavour
 * ('environmental and sustainability' for AESP).
 */
export function buildArticleImagePrompt(post, { sector = 'professional' } = {}) {
  const hay = `${(post.tags || []).join(' ')} ${(post.subcategories || []).join(' ')} ${post.title || ''}`;
  const scene = (TAG_SCENES.find(([re]) => re.test(hay)) || [null,
    'a professional at a desk writing a long-form article, notes and reference reports open, modern UK office setting'])[1];
  const nature = /environment|sustainab|biodiversity|carbon|net zero|ecolog|green/i.test(`${sector} ${hay}`)
    ? ' Subtle environmental theme: touches of greenery, natural materials, or sustainable-looking setting.'
    : '';
  return (
    `Wide-format editorial photograph for a member-magazine article feature image: ${scene}. ` +
    `Context: published by a ${sector} membership association in the UK.${nature} ` +
    `Photorealistic, natural colours, professional editorial photography style, ` +
    `16:9 landscape composition with clear space at the edges, no visible readable text, ` +
    `no logos, no watermarks.`
  );
}

/**
 * Find seeded articles missing a feature image and generate+upload+link one
 * for each. generateFn: async (prompt, post) => Buffer<JPEG>. Agent
 * CodeExecution only — see demo-seeds/README.md.
 * Returns { generated, skipped, errors }.
 */
export async function runArticleImageGenerationPass({
  sb, tenantId, generateFn, sector, slugPrefix,
  bucket = DEMO_ARTICLE_IMAGE_BUCKET, log = console.log, concurrency = 3,
}) {
  const posts = await listDemoArticlesNeedingImages(sb, tenantId, slugPrefix ? { slugPrefix } : {});
  if (posts.length === 0) {
    log('[demo-article-image-gen] No seeded articles need a feature image — nothing to do.');
    return { generated: 0, skipped: 0, errors: 0 };
  }
  log(`[demo-article-image-gen] ${posts.length} article(s) need a feature image. Starting generation…`);

  let generated = 0, skipped = 0, errors = 0;
  const processOne = async (post) => {
    const prompt = buildArticleImagePrompt(post, sector ? { sector } : {});
    const label = `blog_post:${post.slug}`;
    log(`[demo-article-image-gen] generating: ${label}`);
    log(`[demo-article-image-gen]   prompt: ${prompt}`);
    try {
      const buffer = await generateFn(prompt, post);
      const url = await uploadDemoArticleImage(sb, { tenantId, slug: post.slug, buffer, bucket });
      const opts = { sb, tenantId, postId: post.id, url, log };
      if (slugPrefix) opts.slugPrefix = slugPrefix;
      if (await applyDemoArticleImage(opts)) { generated++; log(`[demo-article-image-gen] ✓ ${label}`); }
      else { skipped++; log(`[demo-article-image-gen] ~ ${label} — already has an image, skipped`); }
    } catch (err) {
      errors++;
      log(`[demo-article-image-gen] ✗ ${label} — ${err.message}`);
    }
  };

  const active = [];
  for (const post of posts) {
    const p = processOne(post).then(() => active.splice(active.indexOf(p), 1));
    active.push(p);
    if (active.length >= concurrency) await Promise.race(active);
  }
  await Promise.all(active);

  log(`[demo-article-image-gen] done — generated ${generated}, skipped ${skipped}, errors ${errors}`);
  return { generated, skipped, errors };
}
