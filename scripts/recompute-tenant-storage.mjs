#!/usr/bin/env node
/**
 * Recompute per-tenant cumulative storage usage by listing the actual
 * objects in Supabase Storage and summing their `metadata.size`, then
 * writing the total to `tenant.storage_used_bytes` (Task #1027).
 *
 * Used to (a) baseline existing tenants when the column is first added,
 * and (b) re-baseline if the incremental counter drifts (e.g. an admin
 * deleted files directly via the Supabase dashboard, or a signed-URL
 * upload was attributed optimistically but never actually completed).
 *
 * Walks the buckets that store tenant-scoped objects under a `tenantId/...`
 * prefix:
 *   - public-assets        (branding, pages, galleries, canvas-media …)
 *   - private-uploads      (form submissions, contracts, case studies …)
 *
 * The `file-repository` bucket used by /api/projects/cards attachments
 * stores under `project-attachments/<tenantId>/...` instead of
 * `<tenantId>/...` so it has its own listing branch.
 *
 * Usage:
 *   node scripts/recompute-tenant-storage.mjs                # all tenants
 *   node scripts/recompute-tenant-storage.mjs --tenant=<uuid>
 *   node scripts/recompute-tenant-storage.mjs --dry-run
 */

import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) acc[m[1]] = m[2] ?? true;
  return acc;
}, {});
const DRY_RUN = !!args['dry-run'];
const TENANT_FILTER = args.tenant || null;

const SUPABASE_URL = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY (or SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TENANT_PREFIXED_BUCKETS = ['public-assets', 'private-uploads'];
const PROJECT_ATTACHMENTS_BUCKET = 'file-repository';
const PAGE_SIZE = 1000;

async function listAllRecursive(bucket, prefix) {
  let total = 0;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) {
      console.warn(`[recompute] list ${bucket}/${prefix} failed: ${error.message}`);
      return total;
    }
    if (!data || data.length === 0) break;
    for (const entry of data) {
      // Folders have id === null in Supabase storage list output.
      if (entry.id === null) {
        const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        total += await listAllRecursive(bucket, childPrefix);
      } else {
        const size = Number(entry?.metadata?.size || 0);
        if (Number.isFinite(size) && size > 0) total += size;
      }
    }
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return total;
}

async function recomputeForTenant(tenantId) {
  let total = 0;
  for (const bucket of TENANT_PREFIXED_BUCKETS) {
    total += await listAllRecursive(bucket, tenantId);
  }
  total += await listAllRecursive(PROJECT_ATTACHMENTS_BUCKET, `project-attachments/${tenantId}`);
  return total;
}

async function main() {
  const tenantsQ = supabase.from('tenant').select('id, name, storage_used_bytes');
  const { data: tenants, error } = TENANT_FILTER
    ? await tenantsQ.eq('id', TENANT_FILTER)
    : await tenantsQ;
  if (error) {
    console.error('Failed to list tenants:', error.message);
    process.exit(1);
  }
  if (!tenants || tenants.length === 0) {
    console.log('No tenants found.');
    return;
  }

  console.log(`Recomputing storage for ${tenants.length} tenant(s)${DRY_RUN ? ' (dry-run)' : ''}…`);
  for (const t of tenants) {
    process.stdout.write(`- ${t.name} (${t.id}) … `);
    try {
      const computed = await recomputeForTenant(t.id);
      const prev = Number(t.storage_used_bytes || 0);
      const drift = computed - prev;
      process.stdout.write(
        `computed=${computed}B prev=${prev}B drift=${drift >= 0 ? '+' : ''}${drift}B`
      );
      if (!DRY_RUN) {
        const { error: updErr } = await supabase
          .from('tenant')
          .update({ storage_used_bytes: computed })
          .eq('id', t.id);
        if (updErr) {
          process.stdout.write(` — UPDATE FAILED: ${updErr.message}\n`);
          continue;
        }
        process.stdout.write(' — updated\n');
      } else {
        process.stdout.write(' — (dry-run)\n');
      }
    } catch (err) {
      process.stdout.write(` — ERROR: ${err?.message || err}\n`);
    }
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
