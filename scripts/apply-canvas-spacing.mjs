// Apply spacing/geometry normalization to the older, hand-built BNMS
// CanvasBuilder pages so they match the canonical rhythm produced by
// scripts/provision-canvas-page-from-doc.mjs. This is the "apply" follow-up to
// the report-only scan (scripts/scan-canvas-spacing.mjs); it reuses the shared
// normalization module (scripts/lib/canvasSpacing.mjs).
//
// SAFETY MODEL
//   - DRY-RUN BY DEFAULT. Nothing is written unless you pass --apply.
//   - Before writing any page, its full canvas_design is snapshotted to disk
//     under scripts/backups/canvas-spacing/<run-timestamp>/<slug>.json plus a
//     manifest.json. Every write is therefore restorable.
//   - Content preservation is VERIFIED (block copy / content / ids / types /
//     order / tablet+mobile geometry are unchanged) before AND after each
//     write. A page that fails verification is never written (and if a
//     post-write read fails verification the run aborts loudly).
//   - The normalization is IDEMPOTENT: re-running produces no further changes.
//
// SCOPE
//   Only the pages the scan classified "straightforward normalize" (bucket
//   === 'normalize' in scripts/output/canvas-spacing-report.json) are touched,
//   re-validated against the same in-scope rules used by the scan (excludes the
//   29 script-provisioned slugs, the 3 reference pages, autumn-meeting pages and
//   -copy duplicates). Restrict further with --slug=<one> or --slugs=a,b,c.
//   "Needs review" pages are never touched by this script.
//
// USAGE
//   node scripts/apply-canvas-spacing.mjs                 # dry-run: show plan for all approved pages
//   node scripts/apply-canvas-spacing.mjs --slug=mentorship
//   node scripts/apply-canvas-spacing.mjs --apply         # WRITE (snapshots first)
//   node scripts/apply-canvas-spacing.mjs --apply --slug=mentorship
//
//   node scripts/apply-canvas-spacing.mjs --restore                       # dry-run: show restore plan (latest snapshot run)
//   node scripts/apply-canvas-spacing.mjs --restore --apply               # RESTORE all pages from latest snapshot run
//   node scripts/apply-canvas-spacing.mjs --restore --from=<run-ts> --apply
//   node scripts/apply-canvas-spacing.mjs --restore --slug=mentorship --apply
//   node scripts/apply-canvas-spacing.mjs --list-backups                  # list snapshot runs on disk
//
// DB access: @supabase/supabase-js with the DEST (prod) service-role key. The
// Supabase direct host is unreachable from the Replit workspace; the REST
// endpoint used here is reachable. See replit.md "Database connection".

import { createClient } from '@supabase/supabase-js';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVISIONED_SLUGS, REFERENCE_SLUGS,
  normalizeDesignFull, verifyContentPreserved,
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
const BACKUP_ROOT = resolve(__dirname, 'backups', 'canvas-spacing');
const REPORT_JSON = resolve(__dirname, 'output', 'canvas-spacing-report.json');

// ---------------------------------------------------------------------------
// CLI args.
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const a = argv.find((x) => x.startsWith(`${f}=`));
  return a ? a.split('=').slice(1).join('=') : null;
};
const APPLY = has('--apply');
const RESTORE = has('--restore');
const LIST_BACKUPS = has('--list-backups');
const ONLY_SLUG = val('--slug');
const SLUGS_CSV = val('--slugs');
const FROM_RUN = val('--from');

// ---------------------------------------------------------------------------
// In-scope rules — mirror scripts/scan-canvas-spacing.mjs isInScope().
// ---------------------------------------------------------------------------
function isInScope(slug) {
  if (PROVISIONED_SLUGS.has(slug)) return false;
  if (REFERENCE_SLUGS.has(slug)) return false;
  if (slug.includes('autumn')) return false;
  if (slug.endsWith('-copy')) return false;
  return true;
}

// The approved set = pages the scan bucketed as "normalize", intersected with
// the in-scope rules. Read from the committed scan report so the two stages
// stay in lockstep.
function approvedSlugs() {
  if (!existsSync(REPORT_JSON)) {
    console.error(`Scan report not found at ${REPORT_JSON}. Run scripts/scan-canvas-spacing.mjs first.`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(REPORT_JSON, 'utf8'));
  const slugs = (report.pages || [])
    .filter((p) => p.bucket === 'normalize')
    .map((p) => p.slug)
    .filter(isInScope);
  return new Set(slugs);
}

function selectedSlugs() {
  let set = approvedSlugs();
  if (SLUGS_CSV) {
    const wanted = new Set(SLUGS_CSV.split(',').map((s) => s.trim()).filter(Boolean));
    set = new Set([...set].filter((s) => wanted.has(s)));
    for (const w of wanted) {
      if (!set.has(w)) console.warn(`  ! --slugs entry "${w}" is not in the approved in-scope set; skipping.`);
    }
  }
  if (ONLY_SLUG) {
    if (!set.has(ONLY_SLUG)) {
      console.error(`Slug "${ONLY_SLUG}" is not in the approved in-scope set. Refusing to touch it.`);
      process.exit(1);
    }
    set = new Set([ONLY_SLUG]);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Backup helpers.
// ---------------------------------------------------------------------------
function runStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function listRuns() {
  if (!existsSync(BACKUP_ROOT)) return [];
  return readdirSync(BACKUP_ROOT)
    .filter((d) => statSync(resolve(BACKUP_ROOT, d)).isDirectory())
    .sort();
}

function latestRun() {
  const runs = listRuns();
  return runs.length ? runs[runs.length - 1] : null;
}

function writeSnapshot(runDir, page) {
  mkdirSync(runDir, { recursive: true });
  const payload = {
    slug: page.slug,
    pageId: page.id,
    tenantId: BNMS_TENANT_ID,
    capturedAt: new Date().toISOString(),
    canvas_design: page.canvas_design,
  };
  writeFileSync(resolve(runDir, `${page.slug}.json`), JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// DB helpers.
// ---------------------------------------------------------------------------
async function fetchPages(slugSet) {
  const { data, error } = await supabase
    .from('i_edit_page')
    .select('id, slug, title, status, builder_type, canvas_design')
    .eq('tenant_id', BNMS_TENANT_ID)
    .eq('builder_type', 'canvas')
    .eq('status', 'published')
    .order('slug');
  if (error) {
    console.error('Query failed:', error.message);
    process.exit(1);
  }
  return data.filter((p) => slugSet.has(p.slug));
}

async function writeDesign(pageId, design) {
  const { error } = await supabase
    .from('i_edit_page')
    .update({ canvas_design: design })
    .eq('id', pageId)
    .eq('tenant_id', BNMS_TENANT_ID);
  if (error) throw new Error(`update failed for ${pageId}: ${error.message}`);
}

async function readDesign(pageId) {
  const { data, error } = await supabase
    .from('i_edit_page')
    .select('canvas_design')
    .eq('id', pageId)
    .eq('tenant_id', BNMS_TENANT_ID)
    .single();
  if (error) throw new Error(`re-read failed for ${pageId}: ${error.message}`);
  return data.canvas_design;
}

// ---------------------------------------------------------------------------
// Change summarisation for the dry-run report.
// ---------------------------------------------------------------------------
function summariseChanges(changes) {
  const byField = {};
  for (const c of changes) byField[c.field] = (byField[c.field] || 0) + 1;
  return Object.entries(byField)
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${f}×${n}`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Modes.
// ---------------------------------------------------------------------------
async function runApply() {
  const slugSet = selectedSlugs();
  const pages = await fetchPages(slugSet);
  const missing = [...slugSet].filter((s) => !pages.some((p) => p.slug === s));
  if (missing.length) {
    console.warn(`  ! ${missing.length} approved slug(s) not found as published canvas pages: ${missing.join(', ')}`);
  }

  console.log(`\n${APPLY ? 'APPLY' : 'DRY-RUN'} — normalize spacing on ${pages.length} BNMS canvas page(s)`);
  console.log(`  target DB: ${SUPABASE_URL}`);
  const runDir = resolve(BACKUP_ROOT, runStamp());
  if (APPLY) console.log(`  snapshots: ${runDir}`);
  console.log('');

  const manifest = [];
  let wrote = 0;
  let skipped = 0;
  let failed = 0;

  for (const page of pages) {
    const { design: normalized, changes } = normalizeDesignFull(page.canvas_design);
    const preCheck = verifyContentPreserved(page.canvas_design, normalized);

    if (!preCheck.ok) {
      failed++;
      console.log(`  ✗ ${page.slug}: normalization would ALTER CONTENT — refusing. ${preCheck.diffs.join('; ')}`);
      continue;
    }

    if (changes.length === 0) {
      skipped++;
      console.log(`  · ${page.slug}: already on-grid (no changes)`);
      continue;
    }

    console.log(`  ${APPLY ? '→' : '·'} ${page.slug}: ${changes.length} field edits — ${summariseChanges(changes)}`);

    if (!APPLY) continue;

    // Snapshot BEFORE writing.
    writeSnapshot(runDir, page);
    try {
      await writeDesign(page.id, normalized);
      // Verify the persisted result against the pre-write snapshot.
      const after = await readDesign(page.id);
      const postCheck = verifyContentPreserved(page.canvas_design, after);
      if (!postCheck.ok) {
        throw new Error(`post-write content verification FAILED: ${postCheck.diffs.join('; ')}`);
      }
      // Verify idempotency: normalizing the persisted design yields no changes.
      const { changes: again } = normalizeDesignFull(after);
      if (again.length !== 0) {
        console.warn(`    ! ${page.slug}: not fully idempotent (${again.length} residual edits: ${summariseChanges(again)})`);
      }
      wrote++;
      manifest.push({ slug: page.slug, pageId: page.id, changes: changes.length });
      console.log(`    ✓ written + verified (content preserved)`);
    } catch (e) {
      failed++;
      console.error(`    ✗ ${page.slug}: ${e.message}`);
      console.error(`      snapshot retained at ${resolve(runDir, `${page.slug}.json`)} — restore with:`);
      console.error(`      node scripts/apply-canvas-spacing.mjs --restore --from=${runStamp} --slug=${page.slug} --apply`);
    }
  }

  if (APPLY && manifest.length) {
    writeFileSync(resolve(runDir, 'manifest.json'), JSON.stringify({
      runAt: new Date().toISOString(),
      tenantId: BNMS_TENANT_ID,
      db: SUPABASE_URL,
      pages: manifest,
    }, null, 2));
  }

  console.log('');
  if (APPLY) {
    console.log(`Done. wrote=${wrote} skipped=${skipped} failed=${failed}`);
    if (wrote) {
      const runName = runDir.split('/').pop();
      console.log(`\nTo roll back this run:`);
      console.log(`  node scripts/apply-canvas-spacing.mjs --restore --from=${runName} --apply`);
    }
  } else {
    console.log(`Dry-run complete. would-write=${pages.length - skipped - failed} on-grid=${skipped} would-fail=${failed}`);
    console.log(`Re-run with --apply to persist (snapshots are taken automatically before each write).`);
  }
  if (failed) process.exit(1);
}

async function runRestore() {
  const from = FROM_RUN || latestRun();
  if (!from) {
    console.error('No snapshot runs found under scripts/backups/canvas-spacing/. Nothing to restore.');
    process.exit(1);
  }
  const runDir = resolve(BACKUP_ROOT, from);
  if (!existsSync(runDir)) {
    console.error(`Snapshot run not found: ${runDir}`);
    process.exit(1);
  }

  let files = readdirSync(runDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
  if (ONLY_SLUG) files = files.filter((f) => f === `${ONLY_SLUG}.json`);
  if (SLUGS_CSV) {
    const wanted = new Set(SLUGS_CSV.split(',').map((s) => s.trim()).filter(Boolean));
    files = files.filter((f) => wanted.has(f.replace(/\.json$/, '')));
  }

  console.log(`\n${APPLY ? 'RESTORE' : 'DRY-RUN (restore)'} — from snapshot run ${from}`);
  console.log(`  target DB: ${SUPABASE_URL}`);
  console.log(`  pages: ${files.length}`);
  console.log('');

  let restored = 0;
  let failed = 0;
  for (const f of files) {
    const snap = JSON.parse(readFileSync(resolve(runDir, f), 'utf8'));
    console.log(`  ${APPLY ? '→' : '·'} ${snap.slug} (page ${snap.pageId})`);
    if (!APPLY) continue;
    try {
      await writeDesign(snap.pageId, snap.canvas_design);
      const after = await readDesign(snap.pageId);
      const check = verifyContentPreserved(snap.canvas_design, after);
      if (!check.ok) throw new Error(`post-restore verification failed: ${check.diffs.join('; ')}`);
      restored++;
      console.log(`    ✓ restored`);
    } catch (e) {
      failed++;
      console.error(`    ✗ ${snap.slug}: ${e.message}`);
    }
  }

  console.log('');
  if (APPLY) {
    console.log(`Restore complete. restored=${restored} failed=${failed}`);
  } else {
    console.log(`Dry-run complete. Re-run with --apply to restore.`);
  }
  if (failed) process.exit(1);
}

function runListBackups() {
  const runs = listRuns();
  if (!runs.length) {
    console.log('No snapshot runs found under scripts/backups/canvas-spacing/.');
    return;
  }
  console.log('Snapshot runs (oldest first):');
  for (const r of runs) {
    const dir = resolve(BACKUP_ROOT, r);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
    console.log(`  ${r}  (${files.length} page(s): ${files.map((f) => f.replace(/\.json$/, '')).join(', ')})`);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  if (LIST_BACKUPS) return runListBackups();
  if (RESTORE) return runRestore();
  return runApply();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
