// Task #3371 — seed the first "AI generated" static page: the isaasi
// "AI for Membership Organisations" guide.
//
// Idempotent: re-running updates the same page row (keyed tenant_id + slug)
// and re-uploads the download asset with upsert. Targets the DEST
// (production) Supabase — the workspace runtime SUPABASE_URL is the legacy
// SOURCE and must not be used here.
//
// Usage:
//   node scripts/seed-isaasi-ai-guide-page.mjs           # seed/refresh
//   node scripts/seed-isaasi-ai-guide-page.mjs --dry-run # sanitize + report only
//
// Env: DEST_SUPABASE_URL, DEST_SUPABASE_KEY

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { prepareStaticPageContent } from '../api/_lib/staticPageContent.js';
import { buildGuideHtml, GUIDE_CSS } from './lib/isaasiAiGuideContent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DRY_RUN = process.argv.includes('--dry-run');

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set');
  process.exit(1);
}

const TENANT_SLUG = 'isaasi';
const PAGE_SLUG = 'ai-for-membership-organisations';
const PAGE_TITLE = 'AI for Membership Organisations';
const META_DESCRIPTION =
  'Practical AI. Real impact. Time back for your people. A short guide to help membership organisations use AI in ways that are practical, responsible and valuable.';
const ASSET_LOCAL = path.join(
  repoRoot,
  'attached_assets',
  'AI_for_membership_organisations_(1)_1785864416704.png'
);
const BUCKET = 'file-repository';

// "Let's talk" destination: isaasi has no public contact/enquiry page or form
// yet (checked 2026-08-04: only canvas pages 'home' and 'home-test' exist),
// so per the task spec fall back to a mailto for the tenant's contact.
const CONTACT_HREF = 'mailto:mat@teeone.co.uk?subject=AI%20for%20Membership%20Organisations';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  // 1. Resolve tenant.
  const { data: tenant, error: tenantErr } = await supabase
    .from('tenant')
    .select('id, name, slug')
    .eq('slug', TENANT_SLUG)
    .single();
  if (tenantErr || !tenant) {
    throw new Error(`tenant '${TENANT_SLUG}' not found: ${tenantErr?.message}`);
  }
  console.log(`Tenant: ${tenant.name} (${tenant.id})`);

  // 2. Upload the downloadable guide asset (idempotent upsert).
  const storagePath = `${tenant.id}/guides/ai-for-membership-organisations.png`;
  let downloadUrl;
  if (DRY_RUN) {
    downloadUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
    console.log('[dry-run] would upload asset to', storagePath);
  } else {
    const bytes = fs.readFileSync(ASSET_LOCAL);
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, bytes, {
        contentType: 'image/png',
        cacheControl: '3600',
        upsert: true,
      });
    if (upErr) throw new Error(`asset upload failed: ${upErr.message}`);
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    downloadUrl = pub.publicUrl;
    console.log('Asset uploaded:', downloadUrl);
  }

  // 3. Ensure the page row exists (we need its id to scope the CSS).
  const { data: existing, error: exErr } = await supabase
    .from('i_edit_page')
    .select('id, builder_type, status')
    .eq('tenant_id', tenant.id)
    .eq('slug', PAGE_SLUG)
    .maybeSingle();
  if (exErr) throw new Error(`page lookup failed: ${exErr.message}`);
  if (existing && existing.builder_type !== 'ai_static') {
    throw new Error(
      `page /${PAGE_SLUG} already exists with builder_type='${existing.builder_type}' — refusing to overwrite`
    );
  }

  let pageId = existing?.id;
  if (!pageId) {
    if (DRY_RUN) {
      pageId = '00000000-0000-0000-0000-000000000000';
      console.log('[dry-run] would insert new ai_static page row');
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from('i_edit_page')
        .insert({
          tenant_id: tenant.id,
          title: PAGE_TITLE,
          slug: PAGE_SLUG,
          builder_type: 'ai_static',
          status: 'draft',
          layout_type: 'public',
        })
        .select('id')
        .single();
      if (insErr) throw new Error(`page insert failed: ${insErr.message}`);
      pageId = inserted.id;
      console.log('Created page row', pageId);
    }
  } else {
    console.log('Updating existing page row', pageId);
  }

  // 4. Build + sanitize + scope the content (store-time choke point).
  const rawHtml = buildGuideHtml({ downloadUrl, contactHref: CONTACT_HREF });
  const storageHost = `${SUPABASE_URL}/storage/v1/object/public/`;
  const prepared = prepareStaticPageContent({
    html: rawHtml,
    css: GUIDE_CSS,
    pageId,
    allowedImageHosts: [storageHost],
  });
  if (prepared.htmlReport.removed.length) {
    console.warn('Sanitiser removed:', JSON.stringify(prepared.htmlReport.removed));
  }
  const cssProblems = prepared.cssRejections.filter((r) => !r.warning);
  if (cssProblems.length) {
    console.warn('CSS rejections:', JSON.stringify(cssProblems));
  }
  console.log(
    `Prepared content: html ${prepared.static_html.length} bytes, css ${prepared.static_css.length} bytes`
  );

  if (DRY_RUN) {
    console.log('[dry-run] done — nothing persisted');
    return;
  }

  // 5. Persist content + metadata, published.
  const { error: updErr } = await supabase
    .from('i_edit_page')
    .update({
      title: PAGE_TITLE,
      description: META_DESCRIPTION,
      meta_title: `${PAGE_TITLE} | ${tenant.name}`,
      meta_description: META_DESCRIPTION,
      layout_type: 'public',
      status: 'published',
      published_at: new Date().toISOString(),
      static_html: prepared.static_html,
      static_css: prepared.static_css,
    })
    .eq('id', pageId);
  if (updErr) throw new Error(`page update failed: ${updErr.message}`);

  console.log(`Done. Page published at /${PAGE_SLUG} for tenant '${tenant.slug}'.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
