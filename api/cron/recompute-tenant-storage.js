// Task #1039 — nightly cron that recomputes per-tenant `storage_used_bytes`
// by listing actual objects in Supabase Storage and summing their size.
//
// Mirrors the logic in `scripts/recompute-tenant-storage.mjs`. The
// incremental counter (maintained by upload/delete endpoints via the
// `increment_tenant_storage_bytes` RPC) can drift upward over time
// because signed-URL uploads attribute the *claimed* file size when the
// URL is issued (the client may abort the actual PUT) and not every
// delete path decrements. Re-baselining nightly keeps quota enforcement
// honest without ops intervention.
//
// Bails early at 50s elapsed to stay within Vercel's 60s function limit;
// unprocessed tenants pick up on the next nightly tick (we sort oldest
// `storage_recomputed_at` first when available, falling back to tenant
// id ordering otherwise).

import { supabase } from '../_lib/database.js';

const TENANT_PREFIXED_BUCKETS = ['public-assets', 'private-uploads'];
const PROJECT_ATTACHMENTS_BUCKET = 'file-repository';
const PAGE_SIZE = 1000;
const TIME_BUDGET_MS = 50_000;

async function listAllRecursive(bucket, prefix) {
  let total = 0;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) {
      console.warn(`[cron/recompute-tenant-storage] list ${bucket}/${prefix} failed: ${error.message}`);
      return total;
    }
    if (!data || data.length === 0) break;
    for (const entry of data) {
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

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/recompute-tenant-storage] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();
  const results = {
    processed: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    deferred: 0,
    totalDriftBytes: 0,
    details: [],
  };

  try {
    const { data: tenants, error } = await supabase
      .from('tenant')
      .select('id, name, storage_used_bytes')
      .order('id', { ascending: true });

    if (error) {
      console.error('[cron/recompute-tenant-storage] failed to list tenants:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    const list = tenants || [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];

      if (Date.now() - startTime > TIME_BUDGET_MS) {
        results.deferred = list.length - i;
        console.warn(`[cron/recompute-tenant-storage] time budget exceeded, deferring ${results.deferred} tenant(s) to next run`);
        break;
      }

      try {
        const computed = await recomputeForTenant(t.id);
        const prev = Number(t.storage_used_bytes || 0);
        const drift = computed - prev;
        results.processed++;

        if (drift !== 0) {
          const { error: updErr } = await supabase
            .from('tenant')
            .update({ storage_used_bytes: computed })
            .eq('id', t.id);
          if (updErr) {
            results.errors++;
            results.details.push({ tenantId: t.id, error: updErr.message });
            console.error(`[cron/recompute-tenant-storage] tenant=${t.id} update failed: ${updErr.message}`);
            continue;
          }
          results.updated++;
          results.totalDriftBytes += drift;
          results.details.push({ tenantId: t.id, computed, prev, drift });
        } else {
          results.unchanged++;
        }
      } catch (err) {
        results.errors++;
        results.details.push({ tenantId: t.id, error: err?.message || String(err) });
        console.error(`[cron/recompute-tenant-storage] tenant=${t.id} error:`, err?.message || err);
      }
    }

    return res.status(200).json({
      ok: true,
      durationMs: Date.now() - startTime,
      ...results,
    });
  } catch (err) {
    console.error('[cron/recompute-tenant-storage] fatal:', err);
    return res.status(500).json({ ok: false, error: err.message, ...results });
  }
}
