import { supabase } from '../_lib/database.js';
import { syncAdzunaFeed } from '../_lib/adzunaFeed.js';

const BATCH_SIZE = 100;
const TIME_BUDGET_MS = 50_000;

export async function listEnabledTenantBatch(db, afterTenantId = null) {
  let query = db
    .from('tenant_integrations')
    .select('tenant_id')
    .eq('integration_type', 'adzuna')
    .eq('is_enabled', true)
    .order('tenant_id', { ascending: true })
    .limit(BATCH_SIZE);
  if (afterTenantId) query = query.gt('tenant_id', afterTenantId);
  const { data, error } = await query;
  if (error) throw new Error('Unable to list enabled feeds');
  return data || [];
}

async function saveCursor(lastTenantId) {
  const { error } = await supabase.from('job_feed_sync_cursor').upsert({
    provider: 'adzuna',
    last_tenant_id: lastTenantId,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error('Unable to save Adzuna sync cursor');
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: cursor, error: cursorError } = await supabase
    .from('job_feed_sync_cursor')
    .select('last_tenant_id')
    .eq('provider', 'adzuna')
    .maybeSingle();
  if (cursorError) return res.status(500).json({ error: 'Unable to load Adzuna sync cursor' });

  let afterTenantId = cursor?.last_tenant_id || null;
  let rows;
  try {
    rows = await listEnabledTenantBatch(supabase, afterTenantId);
    // A completed pass wraps to the start. The durable cursor means tenants
    // after a slow one are picked up first on the next hourly invocation.
    if (rows.length === 0 && afterTenantId) {
      afterTenantId = null;
      await saveCursor(null);
      rows = await listEnabledTenantBatch(supabase, null);
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  const results = [];
  const start = Date.now();
  let lastProcessedTenantId = afterTenantId;
  for (const { tenant_id } of rows) {
    if (Date.now() - start > TIME_BUDGET_MS) break;
    try {
      results.push({ tenantId: tenant_id, ...(await syncAdzunaFeed(tenant_id)) });
    } catch (err) {
      const safeError = String(err.message || 'Adzuna sync failed').slice(0, 500);
      await supabase.from('tenant_job_feed_config').upsert({
        tenant_id,
        provider: 'adzuna',
        last_sync_at: new Date().toISOString(),
        last_error: safeError,
        updated_at: new Date().toISOString(),
      });
      results.push({ tenantId: tenant_id, error: safeError });
    }
    lastProcessedTenantId = tenant_id;
  }

  try {
    const completedAvailableBatch = results.length === rows.length && rows.length < BATCH_SIZE;
    await saveCursor(completedAvailableBatch ? null : lastProcessedTenantId);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message, results });
  }
  return res.json({ ok: true, results, deferred: Math.max(0, rows.length - results.length) });
}