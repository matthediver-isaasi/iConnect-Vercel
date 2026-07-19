/**
 * Seed the BNMS "I'm having a scan" V2 proof fixture (Task #2904, Phase 0).
 *
 * Runs the hand-authored fixture package through the FULL safety pipeline
 * (schema → HTML/SVG sanitise → manifest cross-check → CSS scope → leak
 * check) and stores the result as an ai_composition (renderer_version 2)
 * with one immutable ai_composition_version.
 *
 * Dry-run by default — prints the pipeline report without writing.
 *
 * Usage:
 *   node scripts/seed-bnms-scan-fixture.mjs --tenant=<slug-or-uuid>            # dry run
 *   node scripts/seed-bnms-scan-fixture.mjs --tenant=<slug-or-uuid> --apply    # write
 *
 * Idempotent: if a composition named exactly like the fixture already exists
 * for the tenant (renderer_version 2), re-running with --apply refuses to
 * duplicate it (use --force to add another version to the same composition).
 */
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { runAiCodePipeline } from '../api/_lib/aiCodePipeline.js';
import { BNMS_SCAN_FIXTURE } from '../api/_lib/fixtures/bnmsScanFixture.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const tenantArg = (args.find((a) => a.startsWith('--tenant=')) || '').split('=')[1];

if (!tenantArg) {
  console.error('Usage: node scripts/seed-bnms-scan-fixture.mjs --tenant=<slug-or-uuid> [--apply]');
  process.exit(1);
}

const supabase = createClient(
  process.env.DEST_SUPABASE_URL,
  process.env.DEST_SUPABASE_KEY,
  { auth: { persistSession: false } },
);

const COMPOSITION_NAME = "BNMS fixture — I'm having a scan (V2 Phase 0)";

async function resolveTenant() {
  const isUuid = /^[0-9a-f-]{36}$/i.test(tenantArg);
  const q = supabase.from('tenant').select('id, slug, name');
  const { data, error } = isUuid ? await q.eq('id', tenantArg).maybeSingle() : await q.eq('slug', tenantArg).maybeSingle();
  if (error || !data) throw new Error(`Tenant not found: ${tenantArg} ${error?.message || ''}`);
  return data;
}

async function main() {
  const tenant = await resolveTenant();
  console.log(`Tenant: ${tenant.name} (${tenant.slug}, ${tenant.id})`);

  // The composition id doubles as the CSS scope, so mint it up front and run
  // the pipeline against the REAL id (never a placeholder).
  const compositionId = crypto.randomUUID();
  const result = runAiCodePipeline(BNMS_SCAN_FIXTURE, compositionId);
  if (!result.ok) {
    console.error('Pipeline FAILED:');
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const { document, report } = result;
  console.log('Pipeline OK:');
  console.log(`  data-ai-id elements: ${report.aiIds.length}`);
  console.log(`  actions: ${report.actionKeys.join(', ') || '(none)'}`);
  console.log(`  slots: ${report.slotKeys.join(', ') || '(none)'}`);
  console.log(`  headings: ${report.headings.join(', ')}`);
  console.log(`  HTML removed by sanitiser: ${report.htmlRemoved.length}`);
  console.log(`  CSS rejections: ${report.cssRejections.filter((r) => !r.warning).length} hard, ${report.cssRejections.filter((r) => r.warning).length} notes`);
  console.log(`  html bytes: ${Buffer.byteLength(document.html)}, css bytes: ${Buffer.byteLength(document.css)}`);

  const { data: existing } = await supabase
    .from('ai_composition')
    .select('id, current_version_id')
    .eq('tenant_id', tenant.id)
    .eq('name', COMPOSITION_NAME)
    .maybeSingle();

  if (!APPLY) {
    console.log(existing
      ? `\nDry run. Composition already exists (${existing.id}); --apply --force would add a new version.`
      : `\nDry run. Would create composition ${compositionId}. Re-run with --apply to write.`);
    return;
  }

  if (existing && !FORCE) {
    console.error(`Composition already seeded (${existing.id}). Use --force to add a new version.`);
    process.exit(1);
  }

  let compId = existing?.id || compositionId;
  if (existing) {
    // Re-run the pipeline against the EXISTING id so the scope matches.
    const rerun = runAiCodePipeline(BNMS_SCAN_FIXTURE, existing.id);
    if (!rerun.ok) throw new Error(rerun.errors.join('; '));
    Object.assign(document, rerun.document);
  } else {
    const { error } = await supabase.from('ai_composition').insert({
      id: compId,
      tenant_id: tenant.id,
      name: COMPOSITION_NAME,
      composition_type: document.compositionType,
      status: 'draft',
      renderer_version: 2,
    });
    if (error) throw new Error(`Failed to create composition: ${error.message}`);
  }

  const { data: version, error: verErr } = await supabase
    .from('ai_composition_version')
    .insert({
      composition_id: compId,
      tenant_id: tenant.id,
      document,
      change_summary: 'Phase 0 hand-authored BNMS proof fixture',
      operation_type: 'generation',
      validation_result: { pipeline: 'aiCodePipeline', ok: true, report },
      generation_metadata: { source: 'scripts/seed-bnms-scan-fixture.mjs' },
    })
    .select('id')
    .single();
  if (verErr) throw new Error(`Failed to create version: ${verErr.message}`);

  const { error: curErr } = await supabase
    .from('ai_composition')
    .update({ current_version_id: version.id, updated_at: new Date().toISOString() })
    .eq('id', compId)
    .eq('tenant_id', tenant.id);
  if (curErr) throw new Error(`Failed to set current version: ${curErr.message}`);

  console.log(`\nSeeded. compositionId=${compId} versionId=${version.id}`);
  console.log('Attach it to an "AI Composition (V2)" canvas block via the inspector.');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
