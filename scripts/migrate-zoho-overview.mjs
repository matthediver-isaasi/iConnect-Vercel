#!/usr/bin/env node

/**
 * Migrate gsf Zoho Accounts from broken `Organisation_overview` (rich-text,
 * gateway silently strips e.g. trailing `!BC`) to the new clean plain-text
 * `Overview` field, then re-point the iConnect mapping. See task #433.
 *
 * Usage:
 *   node scripts/migrate-zoho-overview.mjs --probe
 *     Print Zoho Accounts metadata for the source + target fields and exit.
 *
 *   node scripts/migrate-zoho-overview.mjs                 (DRY RUN — default)
 *     Walk every gsf Zoho Account, fetch Organisation_overview rich-text,
 *     print what would be written into Overview. No writes.
 *
 *   node scripts/migrate-zoho-overview.mjs --apply
 *     Same walk, but PUT each Overview value back to Zoho.
 *
 *   node scripts/migrate-zoho-overview.mjs --apply --force
 *     Overwrite Overview even when it already has a value (default skips).
 *
 *   node scripts/migrate-zoho-overview.mjs --update-mapping
 *     Re-point the gsf zoho_crm_sync_mapping row from
 *     Organisation_overview → Overview and clear the is_rich_text flag.
 *     Safe to run after --apply lands.
 *
 * Tenant defaults to gsf. Override with --tenant <uuid>.
 */

import { createClient } from '@supabase/supabase-js';

// Point the shared `api/_lib/database.js` Supabase singleton at the production
// destination DB BEFORE importing any zoho-client module — the client reads
// tenant Zoho credentials from `tenant_integrations`, which only exist in
// the production Supabase. SOURCE_DATABASE_URL / dev SUPABASE_URL has no
// integration rows for tenant gsf.
if (process.env.DEST_SUPABASE_URL && process.env.DEST_SUPABASE_KEY) {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
} else {
  console.error('Need DEST_SUPABASE_URL and DEST_SUPABASE_KEY to talk to the production DB.');
  process.exit(1);
}

const {
  zohoCrmApiCall,
  fetchZohoCrmRecordRichText,
  updateZohoCrmRecordById,
  getZohoCrmModuleFields
} = await import('../api/_lib/zohoCrmClient.js');

const GSF_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const MODULE = 'Accounts';
const SOURCE_FIELD = 'Organisation_overview';
const TARGET_FIELD = 'Overview';
const PER_PAGE = 200;
// Each record needs its own rich-text fetch (Zoho excludes rich-text from list
// payloads). Run a small batch in parallel to keep total wall-time bounded —
// ~10 concurrent calls is well under Zoho's per-org rate limits and finishes
// the gsf scan in under a minute.
const FETCH_CONCURRENCY = 10;
// Pattern that triggered the original silent-strip bug: `!` immediately
// followed by an uppercase letter. Flag any source value matching so the
// human spot-check focuses on the at-risk records first.
const RISKY_PATTERN = /![A-Z]/;

function parseArgs(argv) {
  const args = { apply: false, force: false, probe: false, updateMapping: false, tenant: GSF_TENANT_ID };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--force') args.force = true;
    else if (a === '--probe') args.probe = true;
    else if (a === '--update-mapping') args.updateMapping = true;
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a.startsWith('--tenant=')) args.tenant = a.split('=')[1];
  }
  return args;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.DEST_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.DEST_SUPABASE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL + SUPABASE_SERVICE_KEY (or DEST_* equivalents) must be set');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function probeFields(tenantId) {
  const fields = await getZohoCrmModuleFields(tenantId, MODULE);
  const findField = (apiName) => (fields || []).find(f => f?.api_name === apiName);
  const src = findField(SOURCE_FIELD);
  const tgt = findField(TARGET_FIELD);
  console.log(`\nField metadata for tenant ${tenantId}, module ${MODULE}:`);
  console.log(`  source: ${SOURCE_FIELD}`);
  console.log(src ? `    label="${src.field_label}" data_type="${src.data_type}"` : `    NOT FOUND in metadata`);
  console.log(`  target: ${TARGET_FIELD}`);
  console.log(tgt ? `    label="${tgt.field_label}" data_type="${tgt.data_type}"` : `    NOT FOUND in metadata`);
  return { src, tgt };
}

async function listAccountsPage(tenantId, page) {
  const fields = ['id', 'Account_Name', TARGET_FIELD].join(',');
  const path = `/${MODULE}?fields=${encodeURIComponent(fields)}&page=${page}&per_page=${PER_PAGE}`;
  const resp = await zohoCrmApiCall(tenantId, path);
  return {
    rows: Array.isArray(resp?.data) ? resp.data : [],
    moreRecords: !!resp?.info?.more_records
  };
}

async function migrate(args) {
  const tenantId = args.tenant;
  console.log(`\n=== Zoho Overview migration ===`);
  console.log(`tenant=${tenantId} module=${MODULE} apply=${args.apply} force=${args.force}\n`);

  const { src, tgt } = await probeFields(tenantId);
  if (!tgt) {
    console.error(`\nABORT: target field "${TARGET_FIELD}" not found on Zoho ${MODULE} for this tenant.`);
    console.error('Create the field in Zoho first (single-line text, no rich-text), then re-run.');
    process.exit(2);
  }
  if (!src) {
    console.warn(`\nWARN: source field "${SOURCE_FIELD}" not found in metadata. Will still attempt rich-text fetch per record.`);
  }

  const summary = {
    accountsScanned: 0,
    sourceEmpty: 0,
    targetAlreadyPopulatedSkipped: 0,
    targetAlreadyPopulatedOverwritten: 0,
    wouldWrite: 0,
    written: 0,
    failed: 0,
    riskyValues: [],
    errors: []
  };

  async function processOne(row) {
    summary.accountsScanned++;
    const recordId = row.id;
    const accountName = row.Account_Name || '(unnamed)';
    const existingOverview = row[TARGET_FIELD];

    let richText;
    try {
      richText = await fetchZohoCrmRecordRichText(tenantId, MODULE, recordId, [SOURCE_FIELD]);
    } catch (err) {
      summary.failed++;
      const msg = err?.message || String(err);
      summary.errors.push({ stage: 'fetch', recordId, accountName, msg });
      console.error(`  [FETCH-THREW] ${recordId} "${accountName}" — ${msg}`);
      return;
    }
    const sourceValue = richText?.[SOURCE_FIELD];

    if (!sourceValue || String(sourceValue).trim() === '') {
      summary.sourceEmpty++;
      console.log(`  [skipped-empty] ${recordId} "${accountName}" — Organisation_overview empty in Zoho`);
      return;
    }

    const sourceStr = String(sourceValue);

    if (existingOverview && String(existingOverview).trim() !== '' && !args.force) {
      summary.targetAlreadyPopulatedSkipped++;
      console.log(`  [skip-target-set] ${recordId} "${accountName}" — Overview already has ${String(existingOverview).length}ch (use --force to overwrite)`);
      return;
    }
    if (existingOverview && String(existingOverview).trim() !== '' && args.force) {
      summary.targetAlreadyPopulatedOverwritten++;
    }

    if (RISKY_PATTERN.test(sourceStr)) {
      summary.riskyValues.push({ recordId, accountName, length: sourceStr.length, preview: sourceStr.slice(0, 120) });
    }

    if (!args.apply) {
      summary.wouldWrite++;
      console.log(`  [dry-run] ${recordId} "${accountName}" — would write ${sourceStr.length}ch into Overview` +
        (RISKY_PATTERN.test(sourceStr) ? ' [RISKY: contains !<CAPITAL>]' : ''));
      return;
    }

    try {
      const result = await updateZohoCrmRecordById(tenantId, MODULE, recordId, { [TARGET_FIELD]: sourceStr });
      if (result?.success) {
        summary.written++;
        console.log(`  [ok] ${recordId} "${accountName}" — wrote ${sourceStr.length}ch`);
      } else {
        summary.failed++;
        const msg = result?.error || 'unknown error';
        summary.errors.push({ stage: 'update', recordId, accountName, msg });
        console.error(`  [FAIL] ${recordId} "${accountName}" — ${msg}`);
      }
    } catch (err) {
      summary.failed++;
      const msg = err?.message || String(err);
      summary.errors.push({ stage: 'update-threw', recordId, accountName, msg });
      console.error(`  [THREW] ${recordId} "${accountName}" — ${msg}`);
    }
  }

  let page = 1;
  while (true) {
    const { rows, moreRecords } = await listAccountsPage(tenantId, page);
    if (rows.length === 0) break;

    // Run in concurrent batches so wall-time scales with batch count, not row
    // count. Process within a batch is independent — Zoho's server-side state
    // for each Account is isolated.
    for (let i = 0; i < rows.length; i += FETCH_CONCURRENCY) {
      const batch = rows.slice(i, i + FETCH_CONCURRENCY);
      await Promise.all(batch.map(processOne));
    }

    if (!moreRecords) break;
    page++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  accounts scanned:                       ${summary.accountsScanned}`);
  console.log(`  source field empty (skipped):           ${summary.sourceEmpty}`);
  console.log(`  Overview already populated (skipped):   ${summary.targetAlreadyPopulatedSkipped}`);
  console.log(`  Overview overwritten via --force:       ${summary.targetAlreadyPopulatedOverwritten}`);
  if (args.apply) {
    console.log(`  written:                                ${summary.written}`);
    console.log(`  failed:                                 ${summary.failed}`);
  } else {
    console.log(`  would write (run with --apply):         ${summary.wouldWrite}`);
  }
  if (summary.riskyValues.length > 0) {
    console.log(`\n  Risky source values (contain !<CAPITAL>) — verify these post-migration:`);
    for (const r of summary.riskyValues) {
      console.log(`    - ${r.recordId} "${r.accountName}" (${r.length}ch): "${r.preview}"`);
    }
  } else {
    console.log(`\n  No risky source values detected.`);
  }
  if (summary.errors.length > 0) {
    const head = summary.errors.slice(0, 5);
    console.log(`\n  First ${head.length} of ${summary.errors.length} error(s):`);
    for (const e of head) {
      console.log(`    - [${e.stage}] ${e.recordId} "${e.accountName}" — ${e.msg}`);
    }
    if (summary.errors.length > head.length) {
      console.log(`    ...and ${summary.errors.length - head.length} more (see [FAIL]/[THREW]/[FETCH-THREW] log lines above).`);
    }
  }
  console.log('');

  return summary;
}

async function updateMapping(args) {
  const tenantId = args.tenant;
  console.log(`\n=== Update mapping (organization → ${MODULE}.${TARGET_FIELD}) ===`);
  console.log(`tenant=${tenantId} apply=${args.apply}\n`);

  const supabase = getSupabase();
  const { data: rows, error } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('id, entity_type, zoho_module, field_mappings')
    .eq('tenant_id', tenantId)
    .eq('entity_type', 'organization')
    .eq('zoho_module', MODULE);

  if (error) throw error;
  if (!rows || rows.length === 0) {
    console.error(`No organization/${MODULE} mapping row found for tenant ${tenantId}`);
    process.exit(2);
  }
  if (rows.length > 1) {
    console.error(`Expected exactly 1 organization/${MODULE} mapping row for tenant ${tenantId}, found ${rows.length}. Aborting to avoid surprise updates.`);
    process.exit(2);
  }

  for (const row of rows) {
    const fms = Array.isArray(row.field_mappings) ? row.field_mappings : [];
    let changed = false;
    const next = fms.map(m => {
      if (!m || !m.zoho_field) return m;
      // Path A: re-point a row still on the old source field.
      if (m.zoho_field === SOURCE_FIELD) {
        changed = true;
        // The new field is plain-text, not rich-text. Set is_rich_text
        // explicitly to `false` (rather than deleting the key) so the
        // mapping row carries unambiguous "this is plain text" intent and
        // doesn't rely on enrichMappingFlagsFromMetadata's missing-flag
        // back-fill to put the right value back later.
        return {
          ...m,
          zoho_field: TARGET_FIELD,
          zoho_field_label: TARGET_FIELD,
          is_rich_text: false
        };
      }
      // Path B: row is already on the target field but was migrated by an
      // older version of this script that left stale flags / label
      // behind. Repair it idempotently: set the canonical label and an
      // explicit `is_rich_text: false`. No-op if both are already
      // correct.
      if (m.zoho_field === TARGET_FIELD) {
        const labelStale = m.zoho_field_label !== TARGET_FIELD;
        const flagStale = m.is_rich_text !== false;
        if (labelStale || flagStale) {
          changed = true;
          return {
            ...m,
            zoho_field_label: TARGET_FIELD,
            is_rich_text: false
          };
        }
      }
      return m;
    });

    if (!changed) {
      console.log(`  [no-op] mapping ${row.id} (${row.entity_type}/${row.zoho_module}) — no row pointed at ${SOURCE_FIELD}`);
      continue;
    }

    console.log(`  [will update] mapping ${row.id} (${row.entity_type}/${row.zoho_module}) — re-point ${SOURCE_FIELD} → ${TARGET_FIELD}`);
    if (!args.apply) continue;

    const { error: updateErr } = await supabase
      .from('zoho_crm_sync_mapping')
      .update({ field_mappings: next, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (updateErr) {
      console.error(`  [FAIL] ${updateErr.message}`);
      process.exit(2);
    }
    console.log(`  [ok] mapping ${row.id} updated`);
  }

  if (args.apply) {
    await invalidateMappingCacheOnRunningApp(tenantId);
  }
  console.log('');
}

/**
 * After a mapping flip, ask the running app process to drop the
 * in-memory derived-flag + module-fields caches for this tenant so the
 * change takes effect on the very next sync (no waiting for the 5-min
 * TTL, no workflow restart).
 *
 * Talks to `POST /api/admin/zoho-crm-sync/invalidate-mapping-cache`,
 * which accepts either an admin session OR a `Bearer ${CRON_SECRET}`
 * header (matching the existing cron-auth pattern in `api/cron/*.js`).
 *
 * Configurable via env:
 *   APP_BASE_URL — default `http://localhost:5000` (the dev workflow).
 *                  Set to the Vercel deployment URL when running this
 *                  script against production.
 *   CRON_SECRET  — optional. If set in this shell, sent as the bearer
 *                  token. Required when targeting production.
 *
 * Failure is non-fatal: the mapping write itself already succeeded;
 * the operator can fall back to restarting the workflow.
 */
async function invalidateMappingCacheOnRunningApp(tenantId) {
  const baseUrl = (process.env.APP_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
  const url = `${baseUrl}/api/admin/zoho-crm-sync/invalidate-mapping-cache`;
  const cronSecret = process.env.CRON_SECRET;
  console.log(`\n  Invalidating mapping caches on running app at ${baseUrl} ...`);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cronSecret ? { authorization: `Bearer ${cronSecret}` } : {})
      },
      body: JSON.stringify({ tenantId, zohoModule: MODULE })
    });
    const text = await resp.text();
    if (resp.ok) {
      console.log(`  [ok] cache invalidated — ${text}`);
    } else {
      console.warn(`  [WARN] cache invalidation returned HTTP ${resp.status}: ${text}`);
      console.warn('         Restart the app workflow manually to drop the caches.');
    }
  } catch (err) {
    console.warn(`  [WARN] could not reach ${url}: ${err?.message || err}`);
    console.warn('         Restart the app workflow manually to drop the caches.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.probe) {
    await probeFields(args.tenant);
    return;
  }

  if (args.updateMapping) {
    await updateMapping(args);
    return;
  }

  await migrate(args);
}

main().catch(err => {
  console.error('FATAL:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
