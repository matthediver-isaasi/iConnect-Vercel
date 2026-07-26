// Task #3118 Phase 3: Monthly voucher finance report — detail-row builder.
//
// Produces the per-transaction supporting detail behind the monthly rollup
// summary (Phase 2, api/_lib/voucherMonthlyRollup.js). Every row is
// attributed to a reporting month using EXACTLY the same recognition rules
// as buildMovements so the detail always reconciles to the summary:
//   - allocation (synthetic voucher_awarded row): voucher allocation month
//     (valid_from ?? issued_at ?? created_at), amount = original value.
//   - booking_usage: event start month (fallback: transaction month).
//   - cancellation_refund in/before the event month: negative usage in the
//     event month; after the event month: positive reinstatement in the
//     refund month.
//   - expiry / credit_adjustment / debit_adjustment: transaction month.
//
// Summary figures themselves come from Phase 2 (snapshots for closed months,
// computeTenantMonthRollup live otherwise) — never recomputed here.

import { supabase } from './database.js';
import {
  monthKey,
  allocationDate,
  deriveOriginalValue,
} from './voucherMonthlyRollup.js';

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

const PAGE_SIZE = 1000;

async function pageAll(build) {
  const out = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (data && data.length > 0) out.push(...data);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

// Voucher select with 42703 drop-and-retry: the dev workspace runtime DB is
// the stale legacy SOURCE and may lack the Task #3116 metadata columns.
async function loadVouchersDetailed(tenantId) {
  const optional = ['valid_from', 'issued_at', 'created_at', 'funding_source', 'notes', 'created_by'];
  let cols = ['id', 'organization_id', 'code', 'description', 'value', 'expires_at', ...optional];
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
      const msg = String(err?.message || '');
      const drop = optional.find((c) => cols.includes(c) && new RegExp(`\\b${c}\\b`).test(msg));
      if (drop && /does not exist|42703/i.test(msg)) {
        cols = cols.filter((c) => c !== drop);
        console.warn(`[VoucherMonthlyReport] voucher.${drop} missing; retrying without it.`);
        continue;
      }
      throw err;
    }
  }
}

async function loadTransactionsDetailed(tenantId) {
  let notesCol = true;
  while (true) {
    try {
      const cols = ['id', 'voucher_id', 'organization_id', 'booking_reference', 'event_id',
        'event_title', 'member_id', 'member_email', 'amount', 'type', 'created_at'];
      if (notesCol) cols.push('notes');
      return await pageAll((a, b) =>
        supabase
          .from('voucher_transaction')
          .select(cols.join(', '))
          .eq('tenant_id', tenantId)
          .order('id', { ascending: true })
          .range(a, b)
      );
    } catch (err) {
      const msg = String(err?.message || '');
      if (notesCol && /notes/.test(msg) && /does not exist|42703/i.test(msg)) {
        notesCol = false;
        console.warn('[VoucherMonthlyReport] voucher_transaction.notes missing; retrying without it.');
        continue;
      }
      throw err;
    }
  }
}

// Resolve event start dates for event ids (event first, complex_event for the
// rest) — same pattern as the rollup engine.
async function loadEventStarts(tenantId, eventIds) {
  const eventStartById = {};
  const batchSize = 100;
  const resolved = new Set();
  for (let i = 0; i < eventIds.length; i += batchSize) {
    const batch = eventIds.slice(i, i + batchSize);
    const { data, error } = await supabase
      .from('event')
      .select('id, start_date, title, tenant_id')
      .in('id', batch);
    if (error) {
      console.warn('[VoucherMonthlyReport] Event lookup error (non-blocking):', error.message);
      continue;
    }
    (data || [])
      .filter((e) => !e.tenant_id || e.tenant_id === tenantId)
      .forEach((e) => {
        resolved.add(e.id);
        eventStartById[e.id] = { start: e.start_date || null, title: e.title || null };
      });
  }
  const unresolved = eventIds.filter((id) => !resolved.has(id));
  for (let i = 0; i < unresolved.length; i += batchSize) {
    const batch = unresolved.slice(i, i + batchSize);
    const { data, error } = await supabase
      .from('complex_event')
      .select('id, start_date, title, tenant_id')
      .in('id', batch);
    if (error) {
      if (error.code !== '42703') {
        console.warn('[VoucherMonthlyReport] Complex event lookup error (non-blocking):', error.message);
      }
      continue;
    }
    (data || [])
      .filter((e) => !e.tenant_id || e.tenant_id === tenantId)
      .forEach((e) => {
        eventStartById[e.id] = { start: e.start_date || null, title: e.title || null };
      });
  }
  return eventStartById;
}

export async function loadReportData(tenantId) {
  const vouchers = await loadVouchersDetailed(tenantId);
  const transactions = await loadTransactionsDetailed(tenantId);
  const eventIds = Array.from(new Set(transactions.map((t) => t.event_id).filter(Boolean)));
  const eventInfoById = await loadEventStarts(tenantId, eventIds);

  const { data: orgs, error: orgErr } = await supabase
    .from('organization')
    .select('id, name')
    .eq('tenant_id', tenantId);
  if (orgErr) throw orgErr;
  const orgNameById = {};
  (orgs || []).forEach((o) => { orgNameById[o.id] = o.name || ''; });

  return { vouchers, transactions, eventInfoById, orgNameById };
}

export function voucherStatus(v, nowIso = new Date().toISOString()) {
  if (v.expires_at && v.expires_at < nowIso) return 'expired';
  if (num(v.value) <= 0) return 'exhausted';
  return 'active';
}

/**
 * Build the full detail-row set (all months). Rows mirror buildMovements'
 * recognition rules; callers filter by reporting_month / org / etc.
 */
export function buildDetailRows({ vouchers, transactions, eventInfoById = {} }) {
  const voucherById = {};
  const txnsByVoucher = {};
  for (const t of transactions || []) {
    if (t.voucher_id) (txnsByVoucher[t.voucher_id] ||= []).push(t);
  }

  const rows = [];
  const nowIso = new Date().toISOString();

  for (const v of vouchers || []) {
    voucherById[v.id] = v;
    if (!v.organization_id) continue;
    const allocDate = allocationDate(v);
    const allocMonth = monthKey(allocDate);
    if (!allocMonth) continue;
    const original = deriveOriginalValue(v, txnsByVoucher[v.id]);
    if (original <= 0) continue;
    rows.push({
      id: `alloc-${v.id}`,
      source: 'allocation',
      organization_id: v.organization_id,
      reporting_month: allocMonth,
      bucket: 'allocated',
      type: 'voucher_awarded',
      transaction_date: allocDate,
      amount: round2(original),
      voucher_id: v.id,
      voucher_code: v.code || null,
      voucher_status: voucherStatus(v, nowIso),
      voucher_expires_at: v.expires_at || null,
      allocation_date: allocDate,
      funding_source: v.funding_source || null,
      event_id: null,
      event_title: null,
      event_date: null,
      booking_reference: null,
      delegate: null,
      created_by: v.created_by || null,
      notes: v.notes || null,
      adjustment_reference: null,
    });
  }

  for (const t of transactions || []) {
    const v = t.voucher_id ? voucherById[t.voucher_id] : null;
    const orgId = t.organization_id || v?.organization_id || null;
    if (!orgId) continue;
    const txnMonth = monthKey(t.created_at);
    if (!txnMonth) continue;
    const amt = Math.abs(num(t.amount));
    if (amt === 0) continue;

    const eventInfo = t.event_id ? eventInfoById[t.event_id] : null;
    const eventMonth = monthKey(eventInfo?.start) || null;

    // Same recognition switch as buildMovements (voucherMonthlyRollup.js).
    let reportingMonth = txnMonth;
    let bucket;
    let signed;
    switch (t.type) {
      case 'booking_usage':
        reportingMonth = eventMonth || txnMonth;
        bucket = 'used';
        signed = -amt;
        break;
      case 'cancellation_refund': {
        const em = eventMonth || txnMonth;
        if (txnMonth <= em) {
          reportingMonth = em;
          bucket = 'used';
          signed = amt; // nets against used in the event month
        } else {
          reportingMonth = txnMonth;
          bucket = 'reinstated';
          signed = amt;
        }
        break;
      }
      case 'expiry':
        bucket = 'expired';
        signed = -amt;
        break;
      case 'credit_adjustment':
        bucket = 'adj_pos';
        signed = amt;
        break;
      case 'debit_adjustment':
        bucket = 'adj_neg';
        signed = -amt;
        break;
      default:
        bucket = num(t.amount) < 0 ? 'adj_neg' : 'adj_pos';
        signed = num(t.amount) < 0 ? -amt : amt;
        break;
    }

    const isAdjustment = bucket === 'adj_pos' || bucket === 'adj_neg' || bucket === 'reinstated';
    rows.push({
      id: `txn-${t.id}`,
      source: 'ledger',
      organization_id: orgId,
      reporting_month: reportingMonth,
      bucket,
      type: t.type,
      transaction_date: t.created_at,
      amount: round2(signed),
      voucher_id: t.voucher_id || null,
      voucher_code: v?.code || null,
      voucher_status: v ? voucherStatus(v, nowIso) : null,
      voucher_expires_at: v?.expires_at || null,
      allocation_date: v ? allocationDate(v) : null,
      funding_source: v?.funding_source || null,
      event_id: t.event_id || null,
      event_title: t.event_title || eventInfo?.title || null,
      event_date: eventInfo?.start || null,
      booking_reference: t.booking_reference || null,
      delegate: t.member_email || null,
      created_by: null,
      notes: t.notes || null,
      adjustment_reference: isAdjustment ? (t.booking_reference || t.notes || null) : null,
    });
  }

  return rows;
}

function inDateRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/**
 * Apply the brief's filter set to detail rows.
 * filters: { month, organizationId, voucherStatus, allocationFrom,
 *   allocationTo, expiryFrom, expiryTo, eventId, type, fundingSource }
 */
export function filterDetailRows(rows, filters = {}) {
  const {
    month, organizationId, voucherStatus: vStatus,
    allocationFrom, allocationTo, expiryFrom, expiryTo,
    eventId, type, fundingSource,
  } = filters;
  return rows.filter((r) => {
    if (month && r.reporting_month !== month) return false;
    if (organizationId && r.organization_id !== organizationId) return false;
    if (vStatus && r.voucher_status !== vStatus) return false;
    if ((allocationFrom || allocationTo) && !inDateRange(r.allocation_date, allocationFrom, allocationTo)) return false;
    if ((expiryFrom || expiryTo) && !inDateRange(r.voucher_expires_at, expiryFrom, expiryTo)) return false;
    if (eventId && r.event_id !== eventId) return false;
    if (type && r.type !== type) return false;
    if (fundingSource && (r.funding_source || '').toLowerCase() !== fundingSource.toLowerCase()) return false;
    return true;
  });
}

export function sortDetailRows(rows) {
  return [...rows].sort((a, b) => {
    const ad = a.transaction_date || '';
    const bd = b.transaction_date || '';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}
