#!/usr/bin/env node
// register-canvas-media-assets.mjs
//
// One-off, idempotent migration for Task #2706 (Canvas Builder Media Library
// removal). The Canvas Builder used to keep its own `media_asset` registry;
// the File Repository is now the single source of truth. This script copies
// every existing `media_asset` row into `file_repository`, filing it under a
// per-tenant "Imported from Canvas" folder so authors can still find and
// re-use previously uploaded canvas media.
//
// It is SAFE to run repeatedly:
//   * folders are matched by (tenant_id, name) before being created;
//   * assets are matched by (tenant_id, file_url) before being inserted,
//     so re-runs never duplicate.
//
// The underlying storage objects are left untouched — only the DB registry
// rows are created. The `media_asset` table and its stored files stay intact.
//
// Usage:
//   node scripts/register-canvas-media-assets.mjs            # dry-run (default)
//   node scripts/register-canvas-media-assets.mjs --apply    # actually write
//   node scripts/register-canvas-media-assets.mjs --tenant=<uuid> [--apply]
//
// Env (resolved defensively; prefer DEST_* — see replit.md "Database connection"):
//   DEST_SUPABASE_URL / DEST_SUPABASE_KEY  (service-role key; REST is IPv4-reachable)

import { createClient } from '@supabase/supabase-js';

const IMPORT_FOLDER_NAME = 'Imported from Canvas';
const PAGE_SIZE = 1000;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const tenantArg = args.find((a) => a.startsWith('--tenant='));
const ONLY_TENANT = tenantArg ? tenantArg.slice('--tenant='.length) : null;

const SUPABASE_URL =
  process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL || process.env.DEV_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY (service-role). Aborting.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// media_asset.kind → file_repository.file_type (enum: image|document|video|other)
function toFileType(kind, mimeType) {
  const k = String(kind || '').toLowerCase();
  if (k === 'image' || k === 'video' || k === 'document') return k;
  const m = String(mimeType || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (
    m === 'application/pdf' ||
    m.startsWith('application/vnd.') ||
    m === 'application/msword' ||
    m.startsWith('text/')
  ) {
    return 'document';
  }
  return 'other';
}

// Page through a table applying an optional tenant filter, returning all rows.
async function fetchAll(table, columns, tenantId) {
  const rows = [];
  let from = 0;
  for (;;) {
    let q = supabase
      .from(table)
      .select(columns)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { data, error } = await q;
    if (error) throw new Error(`Failed to read ${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function main() {
  console.log(`\n=== register-canvas-media-assets (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  if (ONLY_TENANT) console.log(`Scoped to tenant: ${ONLY_TENANT}`);

  const assets = await fetchAll(
    'media_asset',
    'id, tenant_id, name, url, kind, mime_type, byte_size',
    ONLY_TENANT,
  );
  console.log(`media_asset rows to consider: ${assets.length}`);
  if (assets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Group by tenant so we resolve/create one "Imported from Canvas" folder per tenant.
  const byTenant = new Map();
  for (const a of assets) {
    if (!a.tenant_id || !a.url) continue; // skip malformed rows (need tenant + url)
    if (!byTenant.has(a.tenant_id)) byTenant.set(a.tenant_id, []);
    byTenant.get(a.tenant_id).push(a);
  }

  let created = 0;
  let skipped = 0;
  let foldersCreated = 0;

  for (const [tenantId, tenantAssets] of byTenant) {
    // Resolve (or create) the per-tenant import folder.
    const { data: existingFolders, error: folderErr } = await supabase
      .from('file_repository_folder')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .eq('name', IMPORT_FOLDER_NAME)
      .limit(1);
    if (folderErr) throw new Error(`Folder lookup failed for tenant ${tenantId}: ${folderErr.message}`);

    let folderId = existingFolders && existingFolders[0] ? existingFolders[0].id : null;
    if (!folderId) {
      if (APPLY) {
        const { data: newFolder, error: insErr } = await supabase
          .from('file_repository_folder')
          .insert({ tenant_id: tenantId, name: IMPORT_FOLDER_NAME, display_order: 0 })
          .select('id')
          .single();
        if (insErr) throw new Error(`Folder create failed for tenant ${tenantId}: ${insErr.message}`);
        folderId = newFolder.id;
      }
      foldersCreated += 1;
      console.log(`  [tenant ${tenantId}] ${APPLY ? 'created' : 'would create'} folder "${IMPORT_FOLDER_NAME}"`);
    }

    // Existing file_repository URLs for this tenant → idempotency guard.
    const existingFiles = await fetchAll('file_repository', 'id, file_url', tenantId);
    const existingUrls = new Set(existingFiles.map((f) => f.file_url));

    const toInsert = [];
    for (const a of tenantAssets) {
      if (existingUrls.has(a.url)) {
        skipped += 1;
        continue;
      }
      // Guard against duplicate URLs within this same batch.
      existingUrls.add(a.url);
      toInsert.push({
        tenant_id: tenantId,
        folder_id: folderId, // null in dry-run when folder not yet created; fine — no write happens
        file_name: a.name || 'Untitled',
        file_url: a.url,
        file_type: toFileType(a.kind, a.mime_type),
        mime_type: a.mime_type || null,
        file_size: a.byte_size ?? null,
      });
    }

    console.log(
      `  [tenant ${tenantId}] assets=${tenantAssets.length} new=${toInsert.length} skipped(existing)=${tenantAssets.length - toInsert.length}`,
    );

    if (toInsert.length > 0 && APPLY) {
      const { error: insErr } = await supabase.from('file_repository').insert(toInsert);
      if (insErr) throw new Error(`Insert failed for tenant ${tenantId}: ${insErr.message}`);
    }
    created += toInsert.length;
  }

  console.log('\n--- Summary ---');
  console.log(`Tenants processed:      ${byTenant.size}`);
  console.log(`Folders ${APPLY ? 'created' : 'to create'}: ${foldersCreated}`);
  console.log(`Assets ${APPLY ? 'registered' : 'to register'}: ${created}`);
  console.log(`Assets skipped (already registered): ${skipped}`);
  if (!APPLY) console.log('\nDry-run only. Re-run with --apply to write changes.');
}

main().catch((err) => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
