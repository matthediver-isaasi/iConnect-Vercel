// Daily cron that turns voucher expiry into an auditable
// ledger event. For every voucher past its expiry date that still has
// remaining value, it writes an `expiry` voucher_transaction for exactly
// the unused remaining value, flips the voucher status to `expired` and
// zeroes the remaining value.
//
// Idempotency: a voucher is only processed while it still has value > 0,
// and before writing we double-check that no `expiry` transaction already
// exists for it. Running the cron twice never double-deducts.
//
// Tenant safety: rows without a tenant_id are skipped (never write a
// voucher_transaction with NULL tenant_id — it would be invisible to every
// tenant-scoped surface while still zeroing the voucher).

import { supabase } from '../_lib/database.js';
import { computeExpiryBreakdown } from '../_lib/voucherOrdering.js';

const MAX_VOUCHERS_PER_RUN = 500;
const PAGE_SIZE = 200;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  // Fail closed: this job mutates voucher balances/statuses, so it must
  // never run unauthenticated. Require CRON_SECRET to be configured AND match.
  if (!cronSecret) {
    console.error('[cron/process-voucher-expiries] CRON_SECRET is not configured; refusing to run');
    return res.status(500).json({ error: 'Cron secret not configured' });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/process-voucher-expiries] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const nowIso = new Date().toISOString();
  const results = { processed: 0, skipped: 0, errors: 0, details: [] };

  try {
    // Vouchers past expiry with remaining value. Status may be 'active' or
    // already 'expired' (e.g. flipped by a bulk expiry adjustment without a
    // ledger entry); only 'used' vouchers are excluded. value > 0 is the
    // primary idempotency guard — processed vouchers are zeroed.
    const candidates = [];
    let from = 0;
    while (candidates.length < MAX_VOUCHERS_PER_RUN) {
      const { data, error } = await supabase
        .from('voucher')
        .select('id, tenant_id, organization_id, code, value, expires_at, status, issued_at')
        .lt('expires_at', nowIso)
        .gt('value', 0)
        .neq('status', 'used')
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        console.error('[cron/process-voucher-expiries] Voucher query error:', error);
        return res.status(500).json({ error: 'Failed to query vouchers', details: error.message });
      }
      if (data && data.length > 0) candidates.push(...data);
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    for (const v of candidates.slice(0, MAX_VOUCHERS_PER_RUN)) {
      const remaining = parseFloat(v.value);
      if (isNaN(remaining) || remaining <= 0) {
        results.skipped++;
        continue;
      }
      if (!v.tenant_id) {
        console.warn('[cron/process-voucher-expiries] Skipping voucher with NULL tenant_id:', v.id);
        results.skipped++;
        results.details.push({ voucher_id: v.id, skipped: 'null_tenant_id' });
        continue;
      }

      // Secondary idempotency check: never write a second expiry entry.
      const { data: existing, error: existErr } = await supabase
        .from('voucher_transaction')
        .select('id')
        .eq('voucher_id', v.id)
        .eq('type', 'expiry')
        .limit(1);
      if (existErr) {
        console.error('[cron/process-voucher-expiries] Existing-expiry check failed:', v.id, existErr.message);
        results.errors++;
        results.details.push({ voucher_id: v.id, error: existErr.message });
        continue;
      }
      if (existing && existing.length > 0) {
        // Ledger entry already exists but the voucher still holds value —
        // finish the flip without a second deduction entry.
        const { error: fixErr } = await supabase
          .from('voucher')
          .update({ value: 0, status: 'expired' })
          .eq('id', v.id);
        if (fixErr) {
          console.error('[cron/process-voucher-expiries] Voucher zero-out failed:', v.id, fixErr.message);
          results.errors++;
          results.details.push({ voucher_id: v.id, error: fixErr.message });
        } else {
          results.skipped++;
          results.details.push({ voucher_id: v.id, skipped: 'expiry_txn_already_exists' });
        }
        continue;
      }

      // Reconstruct the original/used breakdown from the ledger for the
      // notes (best effort, non-blocking): used = usage debits minus
      // refunds; original = remaining + used. See computeExpiryBreakdown.
      let usedValue = null;
      let originalValue = null;
      {
        const { data: txns, error: txErr } = await supabase
          .from('voucher_transaction')
          .select('amount, type')
          .eq('voucher_id', v.id);
        if (!txErr && Array.isArray(txns)) {
          const breakdown = computeExpiryBreakdown(remaining, txns);
          originalValue = breakdown.originalValue;
          usedValue = breakdown.usedValue;
        }
      }

      const noteParts = [
        `Voucher expired on ${String(v.expires_at).split('T')[0]}`,
        originalValue !== null ? `original value £${originalValue.toFixed(2)}` : null,
        usedValue !== null ? `previously used £${usedValue.toFixed(2)}` : null,
        `unused value expired £${remaining.toFixed(2)}`,
        `processed ${nowIso}`,
      ].filter(Boolean);

      // Write the ledger entry FIRST, then zero the voucher. If the voucher
      // update fails the value>0 guard picks it up again next run and the
      // existing-expiry check completes the flip without double-deducting.
      const { error: insertErr } = await supabase
        .from('voucher_transaction')
        .insert({
          voucher_id: v.id,
          organization_id: v.organization_id || null,
          amount: remaining,
          balance_before: remaining,
          balance_after: 0,
          type: 'expiry',
          notes: noteParts.join('; '),
          created_at: nowIso,
          tenant_id: v.tenant_id,
        });
      if (insertErr) {
        console.error('[cron/process-voucher-expiries] Expiry transaction insert failed:', v.id, insertErr.message);
        results.errors++;
        results.details.push({ voucher_id: v.id, error: insertErr.message });
        continue;
      }

      const { error: updateErr } = await supabase
        .from('voucher')
        .update({ value: 0, status: 'expired' })
        .eq('id', v.id)
        .gt('value', 0);
      if (updateErr) {
        console.error('[cron/process-voucher-expiries] Voucher update failed:', v.id, updateErr.message);
        results.errors++;
        results.details.push({ voucher_id: v.id, error: `txn written but voucher update failed: ${updateErr.message}` });
        continue;
      }

      results.processed++;
      results.details.push({ voucher_id: v.id, code: v.code, expired_value: remaining });
    }

    console.log('[cron/process-voucher-expiries] Done:', {
      processed: results.processed,
      skipped: results.skipped,
      errors: results.errors,
    });
    return res.status(200).json(results);
  } catch (err) {
    console.error('[cron/process-voucher-expiries] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
