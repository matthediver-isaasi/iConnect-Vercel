// Scan older BNMS CanvasBuilder pages for spacing drift — REPORT ONLY.
//
// Enumerates the in-scope published canvas pages for the BNMS tenant, extracts a
// spacing signature per page, compares each against the canonical rhythm encoded
// in scripts/provision-canvas-page-from-doc.mjs, classifies each page as
// "straightforward normalize" vs "needs review", and emits:
//   - scripts/output/canvas-spacing-report.md   (human report)
//   - scripts/output/canvas-spacing-report.json (machine-readable)
//
// This script makes NO writes to the database. The normalization logic lives in
// scripts/lib/canvasSpacing.mjs and is imported here in dry-run mode only; the
// follow-up "apply" task reuses that module.
//
// Usage:
//   node scripts/scan-canvas-spacing.mjs            # scan + write report
//   node scripts/scan-canvas-spacing.mjs --slug=x   # single page (debug)
//
// DB access: @supabase/supabase-js with the DEST service-role key (Supabase
// direct host unreachable from the Replit workspace; REST endpoint reachable).

import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TARGET, TOLERANCE, PROVISIONED_SLUGS, REFERENCE_SLUGS, SUPERSEDED_TWINS,
  extractSignature, compareToTarget, classifyPage, normalizeDesign, computeReflow,
} from './lib/canvasSpacing.mjs';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.DEST_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const BNMS_TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, 'output');

function isInScope(slug) {
  if (PROVISIONED_SLUGS.has(slug)) return false; // 29 script-provisioned
  if (REFERENCE_SLUGS.has(slug)) return false; // baseline only
  if (slug.includes('autumn')) return false; // autumn meeting pages
  if (slug.endsWith('-copy')) return false; // -copy duplicates
  return true;
}

async function main() {
  const slugArg = process.argv.find((a) => a.startsWith('--slug='))?.split('=')[1];

  const { data: pages, error } = await supabase
    .from('i_edit_page')
    .select('id, slug, title, status, builder_type, canvas_design, published_at')
    .eq('tenant_id', BNMS_TENANT_ID)
    .eq('builder_type', 'canvas')
    .eq('status', 'published')
    .order('slug');

  if (error) {
    console.error('Query failed:', error.message);
    process.exit(1);
  }

  // Baseline: analyse the three reference pages so the report can show the
  // target rhythm as measured on ground-truth pages, next to the constants.
  const references = pages.filter((p) => REFERENCE_SLUGS.has(p.slug));
  const baseline = references.map((p) => ({
    slug: p.slug,
    signature: extractSignature(p.canvas_design),
  }));

  let inScope = pages.filter((p) => isInScope(p.slug));
  if (slugArg) inScope = inScope.filter((p) => p.slug === slugArg);

  const results = [];
  for (const page of inScope) {
    const sig = extractSignature(page.canvas_design);
    const deltas = compareToTarget(sig);
    const { bucket, reasons } = classifyPage({ slug: page.slug, sig });
    const { changes } = normalizeDesign(page.canvas_design);
    const reflow = computeReflow(page.canvas_design);
    const yShifts = reflow.filter((r) => Math.abs(r.toY - r.fromY) > TOLERANCE.gap);

    results.push({
      slug: page.slug,
      title: page.title,
      pageId: page.id,
      updatedAt: page.published_at,
      bucket,
      reasons,
      signature: sig,
      deltas,
      proposedChanges: changes,
      proposedYShiftCount: yShifts.length,
      reflowSample: yShifts.slice(0, 8),
    });
  }

  // Sort: normalize bucket first (by delta count desc), then review.
  results.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket === 'normalize' ? -1 : 1;
    return b.deltas.length - a.deltas.length;
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    tenantId: BNMS_TENANT_ID,
    target: TARGET,
    tolerance: TOLERANCE,
    counts: {
      totalPublishedCanvas: pages.length,
      provisionedExcluded: pages.filter((p) => PROVISIONED_SLUGS.has(p.slug)).length,
      referenceExcluded: references.length,
      autumnExcluded: pages.filter((p) => p.slug.includes('autumn')).length,
      copyExcluded: pages.filter((p) => p.slug.endsWith('-copy')).length,
      inScope: inScope.length,
      straightforwardNormalize: results.filter((r) => r.bucket === 'normalize').length,
      needsReview: results.filter((r) => r.bucket === 'review').length,
    },
    baseline,
    pages: results,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'canvas-spacing-report.json'), JSON.stringify(summary, null, 2));
  writeFileSync(resolve(OUT_DIR, 'canvas-spacing-report.md'), renderMarkdown(summary));

  console.log(`Scanned ${inScope.length} in-scope pages.`);
  console.log(`  straightforward normalize: ${summary.counts.straightforwardNormalize}`);
  console.log(`  needs review:              ${summary.counts.needsReview}`);
  console.log(`Report written to scripts/output/canvas-spacing-report.{md,json}`);
}

// ---------------------------------------------------------------------------
// Markdown rendering.
// ---------------------------------------------------------------------------
function fmt(v) {
  if (v === null || v === undefined) return '—';
  return String(v);
}

function renderMarkdown(s) {
  const L = [];
  L.push('# BNMS Canvas Pages — Spacing Drift Report (scan only)');
  L.push('');
  L.push(`_Generated ${s.generatedAt}. **No database writes were made.** This is`);
  L.push('a dry-run analysis of the older, hand-built CanvasBuilder pages against the');
  L.push('canonical spacing rhythm produced by `scripts/provision-canvas-page-from-doc.mjs`._');
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('| Metric | Count |');
  L.push('| --- | ---: |');
  L.push(`| Total published canvas pages | ${s.counts.totalPublishedCanvas} |`);
  L.push(`| Excluded — script-provisioned (29) | ${s.counts.provisionedExcluded} |`);
  L.push(`| Excluded — reference/baseline (3) | ${s.counts.referenceExcluded} |`);
  L.push(`| Excluded — autumn meeting pages | ${s.counts.autumnExcluded} |`);
  L.push(`| Excluded — \`-copy\` duplicates | ${s.counts.copyExcluded} |`);
  L.push(`| **In scope (analysed)** | **${s.counts.inScope}** |`);
  L.push(`| → Straightforward to normalize | ${s.counts.straightforwardNormalize} |`);
  L.push(`| → Needs human review | ${s.counts.needsReview} |`);
  L.push('');

  L.push('## Target rhythm (the "standard")');
  L.push('');
  L.push('| Value | Target |');
  L.push('| --- | ---: |');
  L.push(`| Canvas width | ${TARGET.CANVAS_W} |`);
  L.push(`| Content left/right margin | ${TARGET.MARGIN} (content width ${TARGET.CONTENT_W}) |`);
  L.push(`| Two-column width / gap | ${TARGET.COL_W} / ${TARGET.COL_GAP} |`);
  L.push(`| Opening / closing hero height | ${TARGET.HERO_OPEN_H} / ${TARGET.HERO_CLOSE_H} |`);
  L.push(`| Hero horizontal padding | ${TARGET.HERO_PAD_X} (full-bleed) |`);
  L.push(`| Gap after hero | ${TARGET.GAP_AFTER_HERO} |`);
  L.push(`| Colour band inner top / all-sides padding | ${TARGET.BAND_INNER_TOP} / ${TARGET.BAND_PAD} |`);
  L.push(`| Heading→divider / divider→body gap | ${TARGET.GAP_HEADING_DIVIDER} / ${TARGET.GAP_DIVIDER_BODY} |`);
  L.push(`| Divider width / thickness | ${TARGET.DIVIDER_W} (col ${TARGET.DIVIDER_W_COL}) / ${TARGET.DIVIDER_THICKNESS} |`);
  L.push(`| Standard section gap | ${TARGET.SECTION_GAP} |`);
  L.push('');

  L.push('### Baseline (reference pages, measured — do not modify)');
  L.push('');
  L.push('> Note: the target-rhythm constants above (from the provisioning layout');
  L.push('> engine) are authoritative. Of the three named reference pages, only');
  L.push('> `about-mrt` sits cleanly on the 150/900 grid — `travelling-fellowships`');
  L.push('> and `honory-membership` are the original hand-built pages and carry their');
  L.push('> own minor drift (some blocks at x=0/125/616), which is why their measured');
  L.push('> content margin below reads as 0. They are analysed for context only and');
  L.push('> are not modified by any pass.');
  L.push('');
  L.push('| Page | Content margin | Content width | Hero pad | Band pad | Common gaps |');
  L.push('| --- | ---: | ---: | ---: | ---: | --- |');
  for (const b of s.baseline) {
    const sig = b.signature;
    const heroPad = sig.heroes[0] ? sig.heroes[0].padLeft : null;
    const bandPad = sig.bands[0] ? sig.bands[0].padTop : null;
    L.push(`| ${b.slug} | ${fmt(sig.contentLeftMargin)} | ${fmt(sig.contentWidth)} | ${fmt(heroPad)} | ${fmt(bandPad)} | ${topGaps(sig.gaps)} |`);
  }
  L.push('');

  const normalize = s.pages.filter((p) => p.bucket === 'normalize');
  const review = s.pages.filter((p) => p.bucket === 'review');

  L.push(`## Straightforward to normalize (${normalize.length})`);
  L.push('');
  L.push('These are single-column pages built only from standard blocks. A');
  L.push('normalization pass would re-align content margins, hero padding, band');
  L.push('padding, dividers and vertical gaps to the target with low risk.');
  L.push('');
  for (const p of normalize) L.push(...renderPage(p));

  L.push(`## Needs human review (${review.length})`);
  L.push('');
  L.push('These pages contain custom/dynamic blocks, event/meeting layouts, unusual');
  L.push('geometry, or are possible superseded duplicates. Spacing changes here could');
  L.push('disturb bespoke layouts — review before applying.');
  L.push('');
  for (const p of review) L.push(...renderPage(p));

  return L.join('\n');
}

function topGaps(gaps) {
  if (!gaps || !gaps.length) return '—';
  const counts = {};
  for (const g of gaps) counts[g] = (counts[g] || 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g, n]) => `${g}px×${n}`)
    .join(', ');
}

function renderPage(p) {
  const L = [];
  L.push(`### ${p.slug}`);
  L.push('');
  L.push(`_${p.title || ''}_  · ${p.signature.blockCount} blocks · block types: ${Object.entries(p.signature.blockTypes).map(([t, n]) => `${t}×${n}`).join(', ')}`);
  L.push('');
  if (p.reasons.length) {
    L.push('**Flags:** ' + p.reasons.join('; '));
    L.push('');
  }
  const sig = p.signature;
  L.push('| Metric | Current | Target |');
  L.push('| --- | ---: | ---: |');
  L.push(`| Content left margin | ${fmt(sig.contentLeftMargin)} | ${TARGET.MARGIN} |`);
  L.push(`| Content width | ${fmt(sig.contentWidth)} | ${TARGET.CONTENT_W} |`);
  L.push(`| Content right margin | ${fmt(sig.contentRightMargin)} | ${TARGET.MARGIN} |`);
  sig.heroes.forEach((h, i) => {
    L.push(`| hero[${i}] height / padX / fullBleed | ${h.h} / ${h.padLeft}·${h.padRight} / ${h.fullBleed} | ${i === 0 ? TARGET.HERO_OPEN_H : TARGET.HERO_CLOSE_H} / ${TARGET.HERO_PAD_X} / true |`);
  });
  sig.bands.forEach((b, i) => {
    L.push(`| band[${i}] pad (T·R·B·L) / innerTop | ${b.padTop}·${b.padRight}·${b.padBottom}·${b.padLeft} / ${fmt(b.innerTop)} | ${TARGET.BAND_PAD} / ${TARGET.BAND_INNER_TOP} |`);
  });
  if (sig.dividers.length) {
    const w = sig.dividers.map((d) => d.w).join(',');
    const th = sig.dividers.map((d) => d.thickness).join(',');
    L.push(`| divider widths / thickness | ${w} / ${th} | ${TARGET.DIVIDER_W}/${TARGET.DIVIDER_W_COL} / ${TARGET.DIVIDER_THICKNESS} |`);
  }
  L.push(`| Vertical gaps (top 5) | ${topGaps(sig.gaps)} | ${TARGET.SECTION_GAP} between sections |`);
  L.push('');
  L.push(`**Deltas beyond tolerance:** ${p.deltas.length}`);
  if (p.deltas.length) {
    L.push('');
    for (const d of p.deltas.slice(0, 20)) {
      L.push(`- \`${d.metric}\`: ${fmt(d.current)} → ${fmt(d.target)} (Δ ${fmt(d.delta)})`);
    }
    if (p.deltas.length > 20) L.push(`- …and ${p.deltas.length - 20} more`);
  }
  L.push('');
  L.push(`**Proposed safe geometry changes (dry-run):** ${p.proposedChanges.length} field edits · **proposed y-reflow shifts:** ${p.proposedYShiftCount}`);
  if (p.reflowSample.length) {
    L.push('');
    for (const r of p.reflowSample) {
      L.push(`- block \`${r.blockId}\` (${r.role}): y ${r.fromY} → ${r.toY}`);
    }
  }
  L.push('');
  L.push('---');
  L.push('');
  return L;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
