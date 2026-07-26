// Task #3117 Phase 2: Month-end voucher snapshot cron.
//
// Runs early in the new month (scheduled on days 1-3 for catch-up) and
// closes the PREVIOUS calendar month for every tenant with voucher
// activity: computes the per-organisation rollup and writes immutable
// voucher_monthly_snapshot rows. Idempotent — tenants whose month is
// already closed are skipped, so re-runs (and the multi-day schedule)
// never duplicate or overwrite.
//
// Serverless time budget: work is bounded by wall-clock (~45s); the
// response reports remaining tenants and a resume cursor (?cursor=<tenantId>
// resumes AFTER that tenant id). Finance-mutating: fails CLOSED when
// CRON_SECRET is unset.
//
// Optional ?month=YYYY-MM closes a specific past month instead of the
// previous one (retrospective backfill).

import { supabase } from '../_lib/database.js';
import { isValidMonth, prevMonth, monthStartDate, snapshotTenantMonth } from '../_lib/voucherMonthlyRollup.js';

const TIME_BUDGET_MS = 45000;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[cron/close-voucher-month] CRON_SECRET is not configured; refusing to run');
    return res.status(500).json({ error: 'Cron secret not configured' });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const started = Date.now();
  const currentMonth = new Date().toISOString().slice(0, 7);
  let month = req.query?.month;
  if (month !== undefined) {
    if (!isValidMonth(month) || month >= currentMonth) {
      return res.status(400).json({ error: 'month must be a past YYYY-MM' });
    }
  } else {
    month = prevMonth(currentMonth);
  }
  const cursor = req.query?.cursor || null;

  const results = { month, closed: 0, skipped: 0, errors: 0, details: [], done: true, next_cursor: null };

  try {
    // Tenants with any vouchers (paged, distinct via Set).
    const tenantIds = new Set();
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('voucher')
          .select('tenant_id')
          .not('tenant_id', 'is', null)
          .order('id', { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) {
          console.error('[cron/close-voucher-month] Tenant scan error:', error);
          return res.status(500).json({ error: 'Failed to scan tenants', details: error.message });
        }
        (data || []).forEach((r) => { if (r.tenant_id) tenantIds.add(r.tenant_id); });
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
    }

    const ordered = Array.from(tenantIds).sort();
    const startIdx = cursor ? ordered.findIndex((t) => t > cursor) : 0;
    const queue = startIdx < 0 ? [] : ordered.slice(startIdx < 0 ? 0 : startIdx);

    for (let i = 0; i < queue.length; i++) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        results.done = false;
        results.next_cursor = i > 0 ? queue[i - 1] : cursor;
        break;
      }
      const tenantId = queue[i];
      try {
        // Cheap pre-check to avoid recomputing already-closed tenants.
        const { data: existing, error: exErr } = await supabase
          .from('voucher_monthly_snapshot')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('month', monthStartDate(month))
          .limit(1);
        if (exErr) throw new Error(exErr.message);
        if (existing && existing.length > 0) {
          results.skipped++;
          continue;
        }
        const r = await snapshotTenantMonth(tenantId, month, { mode: 'close', generatedBy: 'cron' });
        if (r.skipped) {
          results.skipped++;
        } else {
          results.closed++;
          results.details.push({ tenant_id: tenantId, org_count: r.orgCount });
        }
      } catch (err) {
        console.error('[cron/close-voucher-month] Tenant failed:', tenantId, err.message);
        results.errors++;
        results.details.push({ tenant_id: tenantId, error: err.message });
      }
    }

    console.log('[cron/close-voucher-month] Done:', {
      month, closed: results.closed, skipped: results.skipped, errors: results.errors, done: results.done,
    });
    return res.status(200).json(results);
  } catch (err) {
    console.error('[cron/close-voucher-month] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
