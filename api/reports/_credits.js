import { currencyFactor } from '../_lib/bookingCreditEvidence.js';

export function projectCredits(rows, { historicalUnknown = false, partialScope = false } = {}) {
  const breakdown = rows.map(r => ({
    type: r.leg, provider: r.provider, providerId: r.provider_id,
    amount: r.amount_minor == null || !r.currency ? null : Number(r.amount_minor) / currencyFactor(r.currency),
    currency: r.currency, status: r.status, operationKey: r.operation_key,
  }));
  // Absence of a ledger row is not proof that no historic provider reversal
  // exists (including on active bookings). Only actual zero evidence is zero.
  if (!rows.length) return { amount: null, currency: null, status: 'unavailable', breakdown };
  const currencies = new Set(rows.filter(r => r.status !== 'failed').map(r => r.currency).filter(Boolean));
  const operations = new Map();
  for (const row of rows) {
    if (!operations.has(row.operation_key)) operations.set(row.operation_key, []);
    operations.get(row.operation_key).push(row);
  }
  let cents = 0;
  let ambiguous = partialScope || currencies.size > 1 || historicalUnknown;
  let refundOnly = false;
  let noteOnly = false;
  for (const legs of operations.values()) {
    const refunds = legs.filter(r => r.leg === 'refund' && r.status === 'confirmed');
    const notes = legs.filter(r => r.leg === 'credit_note' && r.status === 'confirmed');
    const sum = list => list.reduce((n, r) => n + Number(r.amount_minor), 0);
    if (refunds.length && notes.length && sum(refunds) !== sum(notes)) ambiguous = true;
    if (refunds.length && !notes.length) refundOnly = true;
    if (notes.length && !refunds.length) noteOnly = true;
    cents += refunds.length ? sum(refunds) : sum(notes);
  }
  if (refundOnly && noteOnly) ambiguous = true;
  // Historical independently discovered instruments cannot establish overlap.
  if (rows.some(r => r.detail?.historical) && rows.some(r => r.leg === 'refund') && rows.some(r => r.leg === 'credit_note') && operations.size > 1) ambiguous = true;
  const statuses = new Set(rows.map(r => r.status));
  const status = ambiguous || statuses.has('unavailable') ? 'unavailable'
    : statuses.size > 1 ? 'mixed' : [...statuses][0];
  return { amount: status === 'confirmed' ? cents / (currencyFactor([...currencies][0]) || 100) : null, currency: currencies.size === 1 ? [...currencies][0] : null, status, breakdown };
}

export async function attachReportCredits({ db, tenantId, bookings, groups }) {
  const rows = [];
  try {
    // Only query relevant IDs, with bounded filters and stable full pagination.
    for (const source of ['booking', 'complex_event_booking']) {
      const ids = bookings.filter(b => (b._report_booking_source === 'complex' ? 'complex_event_booking' : 'booking') === source).map(b => b.id);
      for (let i = 0; i < ids.length; i += 100) {
        for (let offset = 0; ; ) {
          const { data, error } = await db.from('booking_reversal_evidence').select('*')
            .eq('tenant_id', tenantId).eq('booking_source', source)
            .overlaps('booking_ids', ids.slice(i, i + 100)).order('id').range(offset, offset + 499);
          if (error) throw new Error(`Failed to load post-booking credits: ${error.message}`);
          if (!data?.length) break;
          rows.push(...data);
          offset += data.length;
        }
      }
    }
  } catch (error) {
    for (const group of groups) group.credits = { amount: null, currency: null, status: 'unavailable', breakdown: [], error: error.message };
    return;
  }
  const unique = [...new Map(rows.map(r => [r.id, r])).values()];
  for (const group of groups) {
    const source = group.bookingSource || (group.isComplexEvent ? 'complex_event_booking' : 'booking');
    const ids = new Set(group.attendees.map(a => a.id));
    const evidence = unique.filter(r => r.booking_source === source && r.booking_ids.some(id => ids.has(id)));
    const originals = bookings.filter(b => ids.has(b.id) && (b._report_booking_source === 'complex' ? 'complex_event_booking' : 'booking') === source);
    group.credits = projectCredits(evidence, {
      historicalUnknown: originals.some(b => b.status === 'cancelled' && !evidence.some(r => r.booking_ids.includes(b.id))),
      partialScope: evidence.some(r => r.booking_ids.some(id => !ids.has(id))),
    });
  }
}