// Task #3117 Phase 2: Monthly voucher balance rollup engine.
//
// Computes a month-end voucher position per organisation from the
// voucher_transaction ledger + voucher allocation rows:
//
//   opening + allocated + adjustments_positive + reinstated
//     - used - expired - adjustments_negative = closing
//
// Recognition rules (all deterministic so re-running a month always
// reproduces the same figures):
//   - Allocation: recognised in the month of the voucher's allocation date
//     (valid_from ?? issued_at ?? created_at). The allocated amount is the
//     ORIGINAL voucher value, reconstructed from the current remaining
//     value plus the ledger (there is no real "voucher_awarded" ledger row;
//     the CSV export synthesises them the same way).
//   - Usage (booking_usage): recognised in the month of the EVENT's start
//     date (event or complex_event), never the booking/transaction date.
//     Falls back to the transaction month only when no event can be
//     resolved.
//   - Cancellation refunds (cancellation_refund): if the refund happens in
//     or before the event month, the value was released BEFORE the usage
//     month closed — it nets against `used` in the event month (so the
//     booking is not reported as used). If the refund happens AFTER the
//     event month, the closed month is never rewritten: the refund appears
//     as a correcting `reinstated` adjustment in the month it was approved,
//     referencing the original booking/event.
//   - Expiry: recognised in the month the expiry ledger entry was written
//     (the daily expiry cron writes it within a day of expires_at).
//   - credit_adjustment / debit_adjustment: recognised in the transaction
//     month.
//
// reserved_future: value already committed via booking_usage transactions
// written on or before the month end whose event takes place after the
// reporting month (net of refunds written on or before month end).
// available_balance = closing - reserved_future.
//
// Pure functions (no DB) are exported for unit tests; loadTenantVoucherData
// / computeTenantMonthRollup wire them to Supabase.

import { supabase } from './database.js';

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(month) {
  return typeof month === 'string' && MONTH_RE.test(month);
}

// 'YYYY-MM' of an ISO date string (UTC), or null.
export function monthKey(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 7);
}

export function prevMonth(month) {
  const [y, m] = month.split('-').map((n) => parseInt(n, 10));
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

export function nextMonth(month) {
  const [y, m] = month.split('-').map((n) => parseInt(n, 10));
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 7);
}

// Inclusive end-of-month ISO instant for 'YYYY-MM'.
export function monthEndIso(month) {
  const [y, m] = month.split('-').map((n) => parseInt(n, 10));
  return new Date(Date.UTC(y, m, 1) - 1).toISOString();
}

export function monthStartDate(month) {
  return `${month}-01`;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Reconstruct the original allocated value of a voucher from its current
// remaining value + ledger: original = remaining + debits - credits.
export function deriveOriginalValue(voucher, txns) {
  let original = num(voucher.value);
  for (const t of txns || []) {
    const amt = Math.abs(num(t.amount));
    if (t.type === 'booking_usage' || t.type === 'expiry' || t.type === 'debit_adjustment') {
      original += amt;
    } else if (t.type === 'cancellation_refund' || t.type === 'credit_adjustment') {
      original -= amt;
    }
  }
  return round2(Math.max(0, original));
}

export function allocationDate(voucher) {
  return voucher.valid_from ?? voucher.issued_at ?? voucher.created_at ?? null;
}

/**
 * Turn vouchers + transactions into signed movements, each attributed to a
 * recognition month and bucket.
 *
 * @param {object} args
 * @param {Array}  args.vouchers      voucher rows (id, organization_id, value,
 *                                    valid_from?, issued_at?, created_at?)
 * @param {Array}  args.transactions  voucher_transaction rows (voucher_id,
 *                                    organization_id, type, amount,
 *                                    created_at, event_id, booking_reference)
 * @param {object} args.eventStartById  map event_id -> event start ISO date
 * @returns {Array<{orgId, month, bucket, amount, txnCreatedAt?, eventMonth?, ref?}>}
 *   bucket ∈ allocated | used | expired | adj_pos | adj_neg | reinstated
 *   `used` movements may be negative (pre-event refund netting).
 */
export function buildMovements({ vouchers, transactions, eventStartById = {} }) {
  const orgByVoucher = {};
  const txnsByVoucher = {};
  for (const t of transactions || []) {
    if (t.voucher_id) {
      (txnsByVoucher[t.voucher_id] ||= []).push(t);
    }
  }

  const movements = [];

  for (const v of vouchers || []) {
    orgByVoucher[v.id] = v.organization_id || null;
    const orgId = v.organization_id || null;
    if (!orgId) continue;
    const allocMonth = monthKey(allocationDate(v));
    if (!allocMonth) continue;
    const original = deriveOriginalValue(v, txnsByVoucher[v.id]);
    if (original > 0) {
      movements.push({ orgId, month: allocMonth, bucket: 'allocated', amount: original });
    }
  }

  for (const t of transactions || []) {
    const orgId = t.organization_id || orgByVoucher[t.voucher_id] || null;
    if (!orgId) continue;
    const txnMonth = monthKey(t.created_at);
    if (!txnMonth) continue;
    const amt = Math.abs(num(t.amount));
    if (amt === 0) continue;

    const eventStart = t.event_id ? eventStartById[t.event_id] : null;
    const eventMonth = monthKey(eventStart) || null;

    switch (t.type) {
      case 'booking_usage': {
        movements.push({
          orgId,
          month: eventMonth || txnMonth,
          bucket: 'used',
          amount: amt,
          txnCreatedAt: t.created_at,
          eventMonth: eventMonth || txnMonth,
          ref: t.booking_reference || null,
        });
        break;
      }
      case 'cancellation_refund': {
        const em = eventMonth || txnMonth;
        if (txnMonth <= em) {
          // Released before the usage month closed: nets against `used`
          // in the event month — not reported as used.
          movements.push({
            orgId,
            month: em,
            bucket: 'used',
            amount: -amt,
            txnCreatedAt: t.created_at,
            eventMonth: em,
            ref: t.booking_reference || null,
          });
        } else {
          // Post-event reinstatement: correcting adjustment recognised in
          // the month the refund was approved; never rewrites the closed
          // usage month.
          movements.push({
            orgId,
            month: txnMonth,
            bucket: 'reinstated',
            amount: amt,
            eventMonth: em,
            ref: t.booking_reference || null,
          });
        }
        break;
      }
      case 'expiry':
        movements.push({ orgId, month: txnMonth, bucket: 'expired', amount: amt });
        break;
      case 'credit_adjustment':
        movements.push({ orgId, month: txnMonth, bucket: 'adj_pos', amount: amt });
        break;
      case 'debit_adjustment':
        movements.push({ orgId, month: txnMonth, bucket: 'adj_neg', amount: amt });
        break;
      default:
        // Unknown type: fall back to raw sign in the transaction month so
        // the balance identity still holds rather than silently dropping.
        movements.push({
          orgId,
          month: txnMonth,
          bucket: num(t.amount) < 0 ? 'adj_neg' : 'adj_pos',
          amount: amt,
        });
        break;
    }
  }

  return movements;
}

function signedDelta(m) {
  switch (m.bucket) {
    case 'allocated':
    case 'adj_pos':
    case 'reinstated':
      return m.amount;
    case 'used':
    case 'expired':
    case 'adj_neg':
      return -m.amount;
    default:
      return 0;
  }
}

function emptyRow() {
  return {
    opening_balance: 0,
    allocated: 0,
    used: 0,
    expired: 0,
    adjustments_positive: 0,
    adjustments_negative: 0,
    reinstated: 0,
    closing_balance: 0,
    reserved_future: 0,
    available_balance: 0,
  };
}

/**
 * Roll movements up into per-organisation rows for one calendar month.
 *
 * @param {object} args
 * @param {string} args.month            'YYYY-MM'
 * @param {Array}  args.movements        from buildMovements
 * @param {object} [args.openingByOrg]   org -> opening balance (from the
 *   prior month's snapshot). Orgs NOT present fall back to full-ledger
 *   replay of all movements before `month`.
 * @param {Array}  [args.includeOrgIds]  extra org ids to emit rows for even
 *   with no movements/balance (e.g. orgs snapshotted in prior months).
 * @returns {object} orgId -> row
 */
export function rollupMonth({ month, movements, openingByOrg = null, includeOrgIds = [] }) {
  const rows = {};
  const ensure = (orgId) => (rows[orgId] ||= emptyRow());

  // Openings: prior snapshot when supplied, otherwise replay.
  const replayOpening = {};
  for (const m of movements) {
    if (m.month < month) {
      replayOpening[m.orgId] = (replayOpening[m.orgId] || 0) + signedDelta(m);
    }
  }

  const orgIds = new Set([
    ...Object.keys(replayOpening),
    ...movements.filter((m) => m.month === month).map((m) => m.orgId),
    ...(openingByOrg ? Object.keys(openingByOrg) : []),
    ...includeOrgIds,
  ]);

  const endIso = monthEndIso(month);

  for (const orgId of orgIds) {
    const row = ensure(orgId);
    row.opening_balance =
      openingByOrg && Object.prototype.hasOwnProperty.call(openingByOrg, orgId)
        ? num(openingByOrg[orgId])
        : replayOpening[orgId] || 0;
  }

  for (const m of movements) {
    if (m.month !== month || !rows[m.orgId]) continue;
    const row = rows[m.orgId];
    switch (m.bucket) {
      case 'allocated': row.allocated += m.amount; break;
      case 'used': row.used += m.amount; break;
      case 'expired': row.expired += m.amount; break;
      case 'adj_pos': row.adjustments_positive += m.amount; break;
      case 'adj_neg': row.adjustments_negative += m.amount; break;
      case 'reinstated': row.reinstated += m.amount; break;
    }
  }

  // Reserved for future events: usage/pre-event-refund movements written on
  // or before month end whose event month is after the reporting month.
  for (const m of movements) {
    if (m.bucket !== 'used' || !m.txnCreatedAt) continue;
    if (!rows[m.orgId]) continue;
    if (m.txnCreatedAt <= endIso && m.eventMonth && m.eventMonth > month) {
      rows[m.orgId].reserved_future += m.amount;
    }
  }

  for (const orgId of Object.keys(rows)) {
    const r = rows[orgId];
    r.closing_balance = round2(
      r.opening_balance + r.allocated + r.adjustments_positive + r.reinstated
        - r.used - r.expired - r.adjustments_negative
    );
    for (const k of ['opening_balance', 'allocated', 'used', 'expired',
      'adjustments_positive', 'adjustments_negative', 'reinstated', 'reserved_future']) {
      r[k] = round2(r[k]);
    }
    r.reserved_future = round2(Math.max(0, r.reserved_future));
    r.available_balance = round2(r.closing_balance - r.reserved_future);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// DB wiring
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000;

async function pageAll(build) {
  const out = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message || 'query failed');
    if (data && data.length > 0) out.push(...data);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

// Voucher select with 42703 drop-and-retry: the dev workspace runtime DB is
// the stale legacy SOURCE and may lack valid_from / issued_at / created_at.
async function loadVouchers(tenantId) {
  const optional = ['valid_from', 'issued_at', 'created_at'];
  let cols = ['id', 'organization_id', 'value', 'expires_at', ...optional];
  while (true) {
    try {
      return await pageAll((a, b) =>
        supabase
          .from('voucher')
          .select(cols.join(', '))
          .eq('tenant_id', tenantId)
          .order('id', { ascending: true })
          .range(a, b)
      );
    } catch (err) {
      const msg = String(err.message || '');
      const drop = optional.find((c) => cols.includes(c) && new RegExp(`\\b${c}\\b`).test(msg));
      if (drop && /does not exist|42703/i.test(msg + '')) {
        cols = cols.filter((c) => c !== drop);
        console.warn(`[VoucherRollup] voucher.${drop} missing; retrying without it.`);
        continue;
      }
      throw err;
    }
  }
}

export async function loadTenantVoucherData(tenantId) {
  const vouchers = await loadVouchers(tenantId);
  const transactions = await pageAll((a, b) =>
    supabase
      .from('voucher_transaction')
      .select('id, voucher_id, organization_id, type, amount, created_at, event_id, booking_reference')
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true })
      .range(a, b)
  );

  // Resolve event start dates (event first, complex_event for the rest).
  const eventIds = Array.from(new Set(transactions.map((t) => t.event_id).filter(Boolean)));
  const eventStartById = {};
  const batchSize = 100;
  const resolved = new Set();
  for (let i = 0; i < eventIds.length; i += batchSize) {
    const batch = eventIds.slice(i, i + batchSize);
    const { data, error } = await supabase
      .from('event')
      .select('id, start_date, tenant_id')
      .in('id', batch);
    if (error) {
      console.warn('[VoucherRollup] Event lookup error (non-blocking):', error.message);
      continue;
    }
    (data || [])
      .filter((e) => !e.tenant_id || e.tenant_id === tenantId)
      .forEach((e) => {
        resolved.add(e.id);
        if (e.start_date) eventStartById[e.id] = e.start_date;
      });
  }
  const unresolved = eventIds.filter((id) => !resolved.has(id));
  for (let i = 0; i < unresolved.length; i += batchSize) {
    const batch = unresolved.slice(i, i + batchSize);
    const { data, error } = await supabase
      .from('complex_event')
      .select('id, start_date, tenant_id')
      .in('id', batch);
    if (error) {
      if (error.code !== '42703') {
        console.warn('[VoucherRollup] Complex event lookup error (non-blocking):', error.message);
      }
      continue;
    }
    (data || [])
      .filter((e) => !e.tenant_id || e.tenant_id === tenantId)
      .forEach((e) => {
        if (e.start_date) eventStartById[e.id] = e.start_date;
      });
  }

  return { vouchers, transactions, eventStartById };
}

/**
 * Compute the rollup for one tenant + month. Opening balances come from the
 * prior month's stored snapshots when they exist (carry-forward); orgs
 * without a prior snapshot fall back to full-ledger replay.
 */
export async function computeTenantMonthRollup(tenantId, month) {
  if (!isValidMonth(month)) throw new Error(`Invalid month: ${month}`);
  const data = await loadTenantVoucherData(tenantId);
  const movements = buildMovements(data);

  const { data: priorSnaps, error: priorErr } = await supabase
    .from('voucher_monthly_snapshot')
    .select('organization_id, closing_balance')
    .eq('tenant_id', tenantId)
    .eq('month', monthStartDate(prevMonth(month)));
  if (priorErr && priorErr.code !== '42P01') {
    throw new Error('Failed to load prior snapshots: ' + priorErr.message);
  }

  let openingByOrg = null;
  const includeOrgIds = [];
  if (priorSnaps && priorSnaps.length > 0) {
    openingByOrg = {};
    for (const s of priorSnaps) {
      openingByOrg[s.organization_id] = num(s.closing_balance);
      includeOrgIds.push(s.organization_id);
    }
  }

  const rows = rollupMonth({ month, movements, openingByOrg, includeOrgIds });
  return { rows, movements };
}

/**
 * Write (close) the month's snapshots. mode 'close' refuses to overwrite an
 * already-closed month; mode 'recompute' upserts over it.
 */
export async function snapshotTenantMonth(tenantId, month, { mode = 'close', generatedBy = null } = {}) {
  const { data: existing, error: exErr } = await supabase
    .from('voucher_monthly_snapshot')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('month', monthStartDate(month))
    .limit(1);
  if (exErr) throw new Error('Snapshot existence check failed: ' + exErr.message);
  const alreadyClosed = existing && existing.length > 0;
  if (alreadyClosed && mode === 'close') {
    return { skipped: true, reason: 'month_already_closed', orgCount: 0 };
  }

  const { rows } = await computeTenantMonthRollup(tenantId, month);
  const nowIso = new Date().toISOString();
  const records = Object.entries(rows).map(([orgId, r]) => ({
    tenant_id: tenantId,
    organization_id: orgId,
    month: monthStartDate(month),
    ...r,
    generated_at: nowIso,
    generated_by: generatedBy,
  }));

  if (mode === 'recompute' && alreadyClosed) {
    // Remove stale rows for orgs no longer present, then upsert.
    const { error: delErr } = await supabase
      .from('voucher_monthly_snapshot')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('month', monthStartDate(month));
    if (delErr) throw new Error('Failed to clear existing snapshots: ' + delErr.message);
  }

  if (records.length > 0) {
    const { error: insErr } = await supabase
      .from('voucher_monthly_snapshot')
      .insert(records);
    if (insErr) throw new Error('Failed to write snapshots: ' + insErr.message);
  }
  return { skipped: false, orgCount: records.length };
}

const SNAPSHOT_FIELDS = [
  'opening_balance', 'allocated', 'used', 'expired', 'adjustments_positive',
  'adjustments_negative', 'reinstated', 'closing_balance', 'reserved_future',
  'available_balance',
];

/**
 * Reconcile a closed month's stored snapshots against a fresh recompute from
 * the live ledger. Returns per-org differences (empty = clean).
 */
export async function reconcileTenantMonth(tenantId, month) {
  const { data: stored, error } = await supabase
    .from('voucher_monthly_snapshot')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('month', monthStartDate(month));
  if (error) throw new Error('Failed to load snapshots: ' + error.message);
  if (!stored || stored.length === 0) {
    return { closed: false, differences: [], carryForwardBreaks: [] };
  }

  const { rows } = await computeTenantMonthRollup(tenantId, month);
  const differences = [];
  const storedByOrg = {};
  for (const s of stored) storedByOrg[s.organization_id] = s;

  const allOrgIds = new Set([...Object.keys(rows), ...Object.keys(storedByOrg)]);
  for (const orgId of allOrgIds) {
    const live = rows[orgId];
    const snap = storedByOrg[orgId];
    if (!live) { differences.push({ organization_id: orgId, missing: 'live' }); continue; }
    if (!snap) { differences.push({ organization_id: orgId, missing: 'stored' }); continue; }
    const fieldDiffs = {};
    for (const f of SNAPSHOT_FIELDS) {
      const a = round2(num(snap[f]));
      const b = round2(num(live[f]));
      if (Math.abs(a - b) > 0.005) fieldDiffs[f] = { stored: a, recomputed: b };
    }
    if (Object.keys(fieldDiffs).length > 0) {
      differences.push({ organization_id: orgId, fields: fieldDiffs });
    }
  }

  // Carry-forward continuity: closing(N) must equal opening(N+1) when N+1
  // is also closed.
  const carryForwardBreaks = [];
  const { data: nextSnaps, error: nErr } = await supabase
    .from('voucher_monthly_snapshot')
    .select('organization_id, opening_balance')
    .eq('tenant_id', tenantId)
    .eq('month', monthStartDate(nextMonth(month)));
  if (!nErr && nextSnaps && nextSnaps.length > 0) {
    const nextByOrg = {};
    for (const s of nextSnaps) nextByOrg[s.organization_id] = num(s.opening_balance);
    for (const s of stored) {
      if (Object.prototype.hasOwnProperty.call(nextByOrg, s.organization_id)) {
        const closing = round2(num(s.closing_balance));
        const opening = round2(nextByOrg[s.organization_id]);
        if (Math.abs(closing - opening) > 0.005) {
          carryForwardBreaks.push({ organization_id: s.organization_id, closing, next_opening: opening });
        }
      }
    }
  }

  return { closed: true, differences, carryForwardBreaks };
}
