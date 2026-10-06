#!/usr/bin/env node
// Pinned one-event reporting-only reconciliation. No financial/booking writes.
// Usage: node scripts/reconcile-gfi-unpacked-credits.mjs --apply
import pg from 'pg';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const PROJECT = 'lvmzliemqnieeoruhkik';
const TENANT = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const EVENT = 'e5dd3f1f-f28e-475c-b0c8-143191c289df';
const url = process.env.DEST_DATABASE_URL;
const rest = process.env.DEST_SUPABASE_URL;
if (process.argv.slice(2).join(' ') !== '--apply') throw new Error('Explicit --apply required; reporting tables only');
if (!url || !rest || !process.env.DEST_SUPABASE_KEY
  || new URL(url).hostname !== 'aws-1-eu-central-1.pooler.supabase.com'
  || !new URL(url).username.endsWith(`.${PROJECT}`)
  || new URL(rest).hostname !== `${PROJECT}.supabase.co`) throw new Error('Pinned DEST identity mismatch');

// Must happen before importing modules with module-level Supabase clients.
process.env.SUPABASE_URL = rest;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const [{ getStripeCredentials }, { readXeroInvoiceCreditEvidence },
  { reconcileBookingCredits }, { attachReportCredits }] = await Promise.all([
  import('../api/_lib/stripeCredentials.js'), import('../api/_lib/xero.js'),
  import('../api/_lib/bookingCreditReconciliation.js'), import('../api/reports/_credits.js'),
]);
const sql = new pg.Client({ connectionString: url });
let bookings, xeroToken;
try {
  await sql.connect();
  await sql.query('BEGIN READ ONLY');
  bookings = (await sql.query(`SELECT id, tenant_id, event_id, booking_group_reference, booking_reference,
      status, payment_method, stripe_payment_intent_id, xero_invoice_id
    FROM public.booking WHERE tenant_id=$1 AND event_id=$2 ORDER BY id`, [TENANT, EVENT])).rows;
  const outside = (await sql.query(`SELECT count(*)::int count FROM public.booking b
    JOIN public.booking e ON b.tenant_id=e.tenant_id AND e.event_id=$2 AND b.event_id<>$2
      AND ((e.stripe_payment_intent_id IS NOT NULL AND e.stripe_payment_intent_id=b.stripe_payment_intent_id)
        OR (e.xero_invoice_id IS NOT NULL AND e.xero_invoice_id=b.xero_invoice_id))
    WHERE b.tenant_id=$1`, [TENANT, EVENT])).rows[0].count;
  if (outside || bookings.length !== 93 || new Set(bookings.map(b => b.booking_group_reference)).size !== 64) {
    throw new Error('Event scope changed or provider reference shared; no writes');
  }
  const tokens = (await sql.query(`SELECT access_token, tenant_id, expires_at
    FROM public.xero_token WHERE app_tenant_id=$1 AND tenant_id<>'PENDING_SELECTION'
    AND expires_at>now()+interval '5 minutes'`, [TENANT])).rows;
  if (tokens.length !== 1) throw new Error('Exactly one unexpired Xero token required; refresh would write');
  [xeroToken] = tokens;
  await sql.query('ROLLBACK');
} finally {
  await sql.end().catch(() => {});
}

const allowed = new Set(bookings.map(b => b.id));
const realDb = createClient(rest, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
// The reconciler receives no ability to mutate any table except these two
// reporting tables, and cannot persist evidence outside this one event.
const db = {
  from(table) {
    if (!['booking', 'booking_cancellation_request', 'booking_reversal_evidence', 'booking_credit_verification'].includes(table)) {
      throw new Error('Audit DB table outside allowlist');
    }
    return {
      select: (...args) => realDb.from(table).select(...args),
      upsert: (value, options) => {
        if (!['booking_reversal_evidence', 'booking_credit_verification'].includes(table)
          || value.tenant_id !== TENANT || value.booking_source !== 'booking'
          || (table === 'booking_credit_verification' && !allowed.has(value.booking_id))
          || (table === 'booking_reversal_evidence'
            && (!Array.isArray(value.booking_ids) || !value.booking_ids.length
              || value.booking_ids.some(id => !allowed.has(id))))) {
          throw new Error('Reporting-write event boundary rejected');
        }
        return realDb.from(table).upsert(value, options);
      },
    };
  },
};

const credentials = await getStripeCredentials(TENANT, 'events');
if (!credentials?.is_enabled || !credentials.secret_key || credentials.mode !== 'live') {
  throw new Error('Event Stripe credential not ready; no reporting writes');
}
const stripe = new Stripe(credentials.secret_key, { timeout: 12_000, maxNetworkRetries: 0 });
const refs = new Set(bookings.map(b => b.stripe_payment_intent_id).filter(Boolean));
const invoices = new Set(bookings.map(b => b.xero_invoice_id).filter(Boolean));
if (refs.size !== 7 || invoices.size !== 27) throw new Error('Provider-reference count changed; no writes');

const ensureToken = () => {
  if (Date.now() + 5 * 60_000 >= new Date(xeroToken.expires_at).getTime()) {
    throw new Error('Xero token nearing expiry: stop without refreshing');
  }
  return { accessToken: xeroToken.access_token, tenantId: xeroToken.tenant_id };
};
const safeGet = async (address, options) => {
  if (options?.method !== 'GET' || !address.startsWith('https://api.xero.com/api.xro/2.0/')) {
    throw new Error('Xero provider request outside GET allowlist');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    ensureToken();
    const response = await fetch(address, { ...options, signal: AbortSignal.timeout(12_000) });
    if (response.status !== 429 || attempt === 2) return response;
    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(Math.max(retryAfter * 1000, 1_000), 65_000) : 60_000;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
};
const xeroFetch = (resource) => {
  const auth = ensureToken();
  return safeGet(`https://api.xero.com/api.xro/2.0/${resource}`, {
    method: 'GET', headers: { Authorization: `Bearer ${auth.accessToken}`,
      'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
  });
};
const xeroNote = async (_, id) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid Xero note identity');
  const response = await xeroFetch(`CreditNotes/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Xero note read HTTP ${response.status}`);
  const note = (await response.json()).CreditNotes?.[0];
  if (note?.CreditNoteID !== id) throw new Error('Xero note identity mismatch');
  return { providerId: id, amount: note.Total == null ? null : Number(note.Total),
    currency: note.CurrencyCode, status: note.Status };
};
// Prefetch *all* exact event references before any reporting write. Cache
// the read-only provider responses for same-run replay and per-row reuse.
const refundPages = new Map();
for (const pi of refs) {
  if (!/^pi_[a-zA-Z0-9]+$/.test(pi)) throw new Error('Invalid Stripe reference');
  const piObj = await stripe.paymentIntents.retrieve(pi);
  if (piObj.id !== pi) throw new Error('Stripe intent identity mismatch');
  let after, page = 0;
  do {
    const response = await stripe.refunds.list({ payment_intent: pi, limit: 100,
      ...(after ? { starting_after: after } : {}) });
    if (!Array.isArray(response.data) || typeof response.has_more !== 'boolean'
      || response.data.some(r => (typeof r.payment_intent === 'string' ? r.payment_intent : r.payment_intent?.id) !== pi)) {
      throw new Error('Stripe refund identity/pagination mismatch');
    }
    refundPages.set(`${pi}:${after || ''}`, response);
    if (++page > 5 || (response.has_more && !response.data.length)) throw new Error('Stripe refund pagination limit');
    after = response.has_more ? response.data.at(-1).id : null;
  } while (after);
}
const discoveries = new Map();
for (const id of invoices) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid Xero invoice reference');
  discoveries.set(id, await readXeroInvoiceCreditEvidence(TENANT, id, {
    loadToken: async () => ensureToken(),
    fetcher: safeGet,
  }));
}
const noteResults = new Map();
for (const discovery of discoveries.values()) {
  for (const note of discovery.notes) {
    if (!noteResults.has(note.providerId)) {
      noteResults.set(note.providerId, await xeroNote('xero', note.providerId));
    }
  }
}
const stats = { provider: { stripeIntents: refs.size, xeroInvoices: invoices.size,
  xeroComplete: [...discoveries.values()].filter(v => v.complete && v.coverage?.paginationComplete).length,
  xeroUnknownCustomerCredits: [...discoveries.values()].filter(v => v.coverage?.unmatchedCustomerCredits).length,
  xeroLinkedNotes: [...discoveries.values()].reduce((n, v) => n + v.notes.length, 0) }, passes: [] };
const readRefunds = async (pi, after) => {
  if (!refs.has(pi) || !refundPages.has(`${pi}:${after || ''}`)) throw new Error('Stripe read outside prefetched scope');
  return refundPages.get(`${pi}:${after || ''}`);
};
const readInvoiceCredits = async (provider, id) => {
  if (provider !== 'xero' || !discoveries.has(id)) throw new Error('Accounting read outside prefetched scope');
  return discoveries.get(id);
};
const readCreditNote = async (provider, id) => {
  if (provider !== 'xero' || !noteResults.has(id)) throw new Error('Accounting note outside prefetched scope');
  return noteResults.get(id);
};
const ids = bookings.map(b => b.id);
const groupMap = new Map();
for (const b of bookings) {
  const key = b.booking_group_reference;
  if (!groupMap.has(key)) groupMap.set(key, {
    bookingSource: 'booking', attendees: [], method: b.payment_method,
  });
  groupMap.get(key).attendees.push({ id: b.id });
}
const groups = [...groupMap.values()];
const report = async () => {
  await attachReportCredits({
    db, tenantId: TENANT, bookings: bookings.map(b => ({ ...b, _report_booking_source: 'booking' })), groups,
  });
  const groupReasons = {}, groupStatuses = {};
  const known = {};
  for (const g of groups) {
    const credit = g.credits;
    const reason = credit.reasonCode || '(none)';
    groupReasons[reason] = (groupReasons[reason] || 0) + 1;
    groupStatuses[credit.status] = (groupStatuses[credit.status] || 0) + 1;
    if (credit.amount != null) {
      const key = `${credit.currency || '(none)'}:${credit.amount}`;
      known[key] = (known[key] || 0) + 1;
    }
  }
  return { groupReasons, groupStatuses, knownAmounts: known };
};
let calls = 0, writes = 0;
for (let offset = 0; offset < ids.length; offset += 25) {
  const batch = ids.slice(offset, offset + 25);
  let cursor = {};
  do {
    const result = await reconcileBookingCredits({
      db, tenantId: TENANT, source: 'booking', bookingIds: batch, cursor,
      readRefunds, readInvoiceCredits, readCreditNote,
    });
    writes += result.written;
    cursor = result.nextCursor || null;
    if (++calls > 110) throw new Error('Reconciliation iteration limit');
  } while (cursor);
}
const first = await report();
const reloaded = await report();
stats.passes.push({ pass: 1, calls, evidenceUpserts: writes,
  projection: first, reloadIdentical: JSON.stringify(first) === JSON.stringify(reloaded) });
console.log(JSON.stringify(stats, null, 2));