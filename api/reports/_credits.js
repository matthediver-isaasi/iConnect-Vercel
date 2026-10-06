import { currencyFactor } from '../_lib/bookingCreditEvidence.js';

export function creditVerificationFingerprint(booking) {
  return JSON.stringify(['payment_method', 'stripe_payment_intent_id', 'accounting_provider',
    'accounting_invoice_id', 'xero_invoice_id', 'accounting_credit_note_id', 'xero_credit_note_id']
    .map(key => booking[key] || null));
}

export function projectCredits(rows, { historicalUnknown = false, partialScope = false } = {}) {
  // Verification history is deliberately not authority for this local report.
  const allRows = rows;
  rows = rows.filter(r => r.status === 'confirmed');
  const missingAmount = historicalUnknown || allRows.some(r =>
    r.status !== 'pending' && r.status !== 'failed' && r.provider_id
    && (r.amount_minor == null || !currencyFactor(r.currency)));
  const unknownAllocation = allRows.some(r => !['pending', 'failed'].includes(r.status)
    && (r.detail?.ambiguousAttribution || r.detail?.ambiguousOperation));
  // A provider-linked record with an unrecognized/unavailable outcome is not
  // evidence of either success or failure, even when its amount is recorded.
  const unresolvedRecord = allRows.some(r => r.provider_id
    && !['confirmed', 'pending', 'failed'].includes(r.status));
  if (!rows.length) return {
    amount: missingAmount || unknownAllocation || partialScope || unresolvedRecord ? null : 0,
    currency: null,
    status: missingAmount || unknownAllocation || partialScope || unresolvedRecord ? 'unavailable' : 'confirmed',
    reasonCode: unknownAllocation || partialScope ? 'ambiguous' : missingAmount ? 'amount_not_recorded'
      : unresolvedRecord ? 'unresolved_record' : 'no_recorded_credits',
    breakdown: allRows.map(r => ({
      type: r.leg, provider: r.provider, providerId: r.provider_id,
      amount: r.status === 'confirmed' && r.amount_minor != null && currencyFactor(r.currency)
        ? Number(r.amount_minor) / currencyFactor(r.currency) : null,
      currency: r.currency, status: r.status, operationKey: r.operation_key,
    })),
  };
  // Deduplicate instruments even when encountered through several booking IDs.
  rows = [...new Map(rows.map(r => [
    r.provider_id ? `${r.tenant_id}:${r.booking_source}:${r.provider}:${r.leg}:${r.provider_id}` : r.id || r.evidence_key || `${r.operation_key}:${r.leg}`,
    r,
  ])).values()];
  const breakdown = rows.map(r => ({
    type: r.leg, provider: r.provider, providerId: r.provider_id,
    amount: r.amount_minor == null || !r.currency ? null : Number(r.amount_minor) / currencyFactor(r.currency),
    currency: r.currency, status: r.status, operationKey: r.operation_key,
  }));
  const currencies = new Set(rows.filter(r => r.status !== 'failed').map(r => r.currency).filter(Boolean));
  const operations = new Map();
  for (const row of rows) {
    if (!operations.has(row.operation_key)) operations.set(row.operation_key, []);
    operations.get(row.operation_key).push(row);
  }
  let cents = 0;
  let ambiguous = partialScope || currencies.size > 1 || unknownAllocation
    || rows.some(r => r.detail?.ambiguousAttribution || r.detail?.ambiguousOperation);
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
  const status = ambiguous || missingAmount || unresolvedRecord || !Number.isSafeInteger(cents) || rows.some(r => r.amount_minor == null || !Number.isSafeInteger(Number(r.amount_minor)) || Number(r.amount_minor) < 0 || !currencyFactor(r.currency)) ? 'unavailable'
    : 'confirmed';
  const reasonCode = missingAmount ? 'amount_not_recorded' : ambiguous ? 'ambiguous'
    : unresolvedRecord ? 'unresolved_record'
    : status === 'unavailable' ? 'amount_not_recorded' : null;
  const error = reasonCode === 'ambiguous'
    ? 'Recorded credits cannot be allocated or combined safely.'
    : reasonCode === 'amount_not_recorded' ? 'Amount not recorded' : null;
  return {
    amount: status === 'confirmed' ? cents / (currencyFactor([...currencies][0]) || 100) : null,
    currency: currencies.size === 1 ? [...currencies][0] : null,
    status,
    reasonCode,
    breakdown: [...breakdown, ...allRows.filter(r => r.status !== 'confirmed').map(r => ({
      type: r.leg, provider: r.provider, providerId: r.provider_id,
      amount: null, currency: r.currency, status: r.status, operationKey: r.operation_key,
    }))],
    ...(error ? { error } : {}),
  };
}

export async function attachReportCredits({ db, tenantId, bookings, groups }) {
  const rows = [];
  const references = [];
  try {
    // Only query relevant IDs, with bounded filters and stable full pagination.
    for (const source of ['booking', 'complex_event_booking']) {
      const ids = bookings.filter(b => (b._report_booking_source === 'complex' ? 'complex_event_booking' : 'booking') === source).map(b => b.id);
      for (let i = 0; i < ids.length; i += 100) {
        // Legacy booking links may predate monetary evidence. Read them locally;
        // cancellation status or an invoice/payment ID is not a credit reference.
        for (let offset = 0; ; ) {
          const { data, error } = await db.from(source)
            .select('id, accounting_provider, accounting_credit_note_id, xero_credit_note_id')
            .eq('tenant_id', tenantId).in('id', ids.slice(i, i + 100))
            .order('id').range(offset, offset + 499);
          if (error) throw new Error(`Failed to load local credit references: ${error.message}`);
          if (!data?.length) break;
          references.push(...data.map(b => ({ ...b, source })));
          offset += data.length;
        }
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
    console.error('[Event Registration Report] Credit evidence storage lookup failed:', error);
    for (const group of groups) group.credits = {
      amount: null,
      currency: null,
      status: 'unavailable',
      reasonCode: 'storage_failure',
      breakdown: [],
      error: 'Credit evidence storage is temporarily unavailable. Retry the report; contact support if the problem continues.',
    };
    return;
  }
  const unique = [...new Map(rows.map(r => [r.id, r])).values()];
  for (const group of groups) {
    const source = group.bookingSource || (group.isComplexEvent ? 'complex_event_booking' : 'booking');
    const ids = new Set(group.attendees.map(a => a.id));
    const evidence = unique.filter(r => r.booking_source === source && r.booking_ids.some(id => ids.has(id)));
    const originals = references.filter(b => ids.has(b.id) && b.source === source);
    group.credits = projectCredits(evidence, {
      bookingIds: [...ids],
      historicalUnknown: originals.some(b => {
        const reference = b.accounting_credit_note_id || b.xero_credit_note_id;
        return reference && !evidence.some(r => r.leg === 'credit_note' && r.provider_id === reference
          && r.provider === (b.accounting_provider || 'xero'));
      }),
      partialScope: evidence.some(r => !['pending', 'failed'].includes(r.status) && r.booking_ids.some(id => !ids.has(id))),
    });
  }
}