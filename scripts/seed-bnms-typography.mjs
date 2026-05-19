/**
 * Seed BNMS tenant fonts (Poppins + Urbanist) on TypographyStyle.
 *
 * Task #939 — tenant-isolated seed for tenant ff2df806-b321-4254-b651-3af11fccf1db.
 * Idempotent: looks up by (tenant_id, style_type, name) and upserts.
 * Only sets is_default=true on the new row for each style_type if no existing
 * default for that style_type already exists for this tenant.
 *
 * This script ONLY reads or writes rows where tenant_id matches the BNMS
 * tenant. Cross-tenant isolation verification lives in the separate audit
 * script `scripts/audit-typography-style-per-tenant.mjs`.
 *
 * Usage:
 *   node scripts/seed-bnms-typography.mjs [--dry-run]
 *
 * Recommended workflow:
 *   1) node scripts/audit-typography-style-per-tenant.mjs   # baseline
 *   2) node scripts/seed-bnms-typography.mjs
 *   3) node scripts/audit-typography-style-per-tenant.mjs   # confirm
 *      every tenant other than BNMS has unchanged count + max(updated_at)
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY');
  process.exit(1);
}

const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const DRY_RUN = process.argv.includes('--dry-run');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SEEDS = [
  {
    name: 'Hero H1',
    style_type: 'h1',
    font_family: 'Urbanist, sans-serif',
    font_size: 56,
    font_size_mobile: 36,
    font_weight: 800,
    line_height: 1.1,
    letter_spacing: 0,
    text_transform: 'none',
    margin_bottom: 24,
    is_active: true,
  },
  {
    name: 'Section H2',
    style_type: 'h2',
    font_family: 'Urbanist, sans-serif',
    font_size: 40,
    font_size_mobile: 28,
    font_weight: 700,
    line_height: 1.2,
    letter_spacing: 0,
    text_transform: 'none',
    margin_bottom: 20,
    is_active: true,
  },
  {
    name: 'Subsection H3',
    style_type: 'h3',
    font_family: 'Urbanist, sans-serif',
    font_size: 28,
    font_size_mobile: 22,
    font_weight: 700,
    line_height: 1.3,
    letter_spacing: 0,
    text_transform: 'none',
    margin_bottom: 16,
    is_active: true,
  },
  {
    name: 'Minor H4',
    style_type: 'h4',
    font_family: 'Poppins, sans-serif',
    font_size: 20,
    font_size_mobile: null,
    font_weight: 600,
    line_height: 1.4,
    letter_spacing: 0,
    text_transform: 'none',
    margin_bottom: 12,
    is_active: true,
  },
  {
    name: 'Body',
    style_type: 'paragraph',
    font_family: 'Poppins, sans-serif',
    font_size: 16,
    font_size_mobile: null,
    font_weight: 400,
    line_height: 1.6,
    letter_spacing: 0,
    text_transform: 'none',
    margin_bottom: 16,
    is_active: true,
  },
];

async function main() {
  // Read ONLY rows scoped to this tenant.
  const { data: existing, error: exErr } = await supabase
    .from('typography_style')
    .select('id, name, style_type, is_default, is_active')
    .eq('tenant_id', TENANT_ID);
  if (exErr) throw exErr;

  console.log(`Existing rows for tenant ${TENANT_ID}: ${existing.length}`);
  for (const r of existing) {
    console.log(`  - [${r.style_type}] ${r.name} (default=${r.is_default}, active=${r.is_active}, id=${r.id})`);
  }

  // Track defaults that already exist for this tenant per style_type.
  // Use is_default alone (regardless of is_active): the partial unique index
  // `idx_typography_style_default_per_tenant_type` enforces uniqueness over
  // is_default=true whether or not the row is active, so any existing default
  // — active or not — must be left alone to avoid a unique-constraint error.
  const tenantDefaultsByType = {};
  for (const r of existing) {
    if (r.is_default) tenantDefaultsByType[r.style_type] = r;
  }

  for (const seed of SEEDS) {
    const match = existing.find(
      (r) => r.style_type === seed.style_type && r.name === seed.name
    );
    const shouldBeDefault =
      !tenantDefaultsByType[seed.style_type] ||
      tenantDefaultsByType[seed.style_type].name === seed.name;

    const payload = {
      ...seed,
      tenant_id: TENANT_ID,
      is_default: shouldBeDefault,
    };

    if (match) {
      const updatePayload = { ...payload };
      // Only promote to default if no other default exists for this style_type
      // for this tenant; never demote.
      if (!shouldBeDefault) delete updatePayload.is_default;
      console.log(
        `\nUPDATE [${seed.style_type}] "${seed.name}" id=${match.id} default=${updatePayload.is_default ?? '(unchanged)'}`
      );
      if (!DRY_RUN) {
        // Scope to tenant id on both columns to make any cross-tenant write
        // structurally impossible.
        const { error: upErr } = await supabase
          .from('typography_style')
          .update(updatePayload)
          .eq('id', match.id)
          .eq('tenant_id', TENANT_ID);
        if (upErr) throw upErr;
      }
    } else {
      console.log(`\nINSERT [${seed.style_type}] "${seed.name}" default=${payload.is_default}`);
      if (!DRY_RUN) {
        const { error: insErr } = await supabase
          .from('typography_style')
          .insert(payload);
        if (insErr) throw insErr;
        if (payload.is_default) {
          tenantDefaultsByType[seed.style_type] = { name: seed.name };
        }
      }
    }
  }

  // Re-read this tenant's rows (only) for a final summary.
  const { data: finalRows } = await supabase
    .from('typography_style')
    .select('id, name, style_type, is_default, is_active, font_family, font_weight, font_size')
    .eq('tenant_id', TENANT_ID)
    .order('style_type');
  console.log(`\nFinal BNMS typography_style rows (${finalRows?.length || 0}):`);
  for (const r of finalRows || []) {
    console.log(
      `  - [${r.style_type}] ${r.name} ${r.font_family} ${r.font_weight}/${r.font_size}px default=${r.is_default} active=${r.is_active}`
    );
  }

  console.log(
    '\nNext: run `node scripts/audit-typography-style-per-tenant.mjs` ' +
      'and confirm every tenant_id other than the BNMS tenant has unchanged ' +
      'count + max(updated_at) vs. the baseline taken before seeding.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
