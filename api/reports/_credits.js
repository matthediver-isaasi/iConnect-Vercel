import { currencyFactor } from '../_lib/bookingCreditEvidence.js';

export function creditVerificationFingerprint(booking) {
  return JSON.stringify(['payment_method', 'stripe_payment_intent_id', 'accounting_provider',
    'accounting_invoice_id', 'xero_invoice_id', 'accounting_credit_note_id', 'xero_credit_note_id']
    .map(key => booking[key] || null));
}

export function projectCredits(rows, { historicalUnknown = false, partialScope = false, verifications = [], bookingIds = [] } = {}) {
  const breakdown = rows.map(r => ({
    type: r.leg, provider: r.provider, providerId: r.provider_id,
    amount: r.amount_minor == null || !r.currency ? null : Number(r.amount_minor) / currencyFactor(r.currency),
    currency: r.currency, status: r.status, operationKey: r.operation_key,
  }));
  // Absence of a ledger row is not proof that no historic provider reversal
  // exists (including on active bookings). Only actual zero evidence is zero.
  if (!rows.length) {
    const outcomes = bookingIds.map(id => verifications.find(v => v.booking_id === id));
    const complete = outcomes.length > 0 && outcomes.every(v => v?.reason_code === 'verified_empty'
      && v.verified_at && v.coverage?.allApplicableScopes === true && v.coverage?.paginationComplete === true);
    if (complete && !partialScope) return {
      amount: 0, currency: null, status: 'confirmed', reasonCode: 'verified_empty', breakdown,
      verifiedAt: outcomes.map(v => v.verified_at).sort()[0],
      coverage: outcomes.map(v => ({ bookingId: v.booking_id, ...v.coverage })),
    };
    const failure = outcomes.find(v => v && v.reason_code !== 'verified_empty');
    if (failure && !partialScope) return {
      amount: null, currency: null, status: 'unavailable', reasonCode: failure.reason_code, breakdown,
      verifiedAt: null, checkedAt: failure.checked_at,
      coverage: outcomes.filter(Boolean).map(v => ({ bookingId: v.booking_id, ...v.coverage })),
      error: verificationMessage(failure.reason_code),
    };
    const ambiguous = historicalUnknown || partialScope;
    return {
      amount: null,
      currency: null,
      status: 'unavailable',
      reasonCode: ambiguous ? 'ambiguous' : 'no_evidence',
      breakdown,
      ...(ambiguous ? { error: 'Historical credit evidence is incomplete. Review the booking before relying on this value.' } : {}),
    };
  }
  const currencies = new Set(rows.filter(r => r.status !== 'failed').map(r => r.currency).filter(Boolean));
  const operations = new Map();
  for (const row of rows) {
    if (!operations.has(row.operation_key)) operations.set(row.operation_key, []);
    operations.get(row.operation_key).push(row);
  }
  let cents = 0;
  let ambiguous = partialScope || currencies.size > 1 || historicalUnknown
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
  const statuses = new Set(rows.map(r => r.status));
  const status = ambiguous || statuses.has('unavailable') ? 'unavailable'
    : statuses.size > 1 ? 'mixed' : [...statuses][0];
  const hasLookupFailure = rows.some(r => r.detail?.reconciliationError || r.detail?.lookupError);
  const reasonCode = ambiguous ? 'ambiguous'
    : statuses.has('pending') ? 'pending'
      : hasLookupFailure || statuses.has('unavailable') ? 'lookup_failure'
        : statuses.has('failed') ? 'provider_failed'
          : null;
  const error = reasonCode === 'ambiguous'
    ? 'Credit evidence cannot be attributed safely. Review the provider records for this booking.'
    : reasonCode === 'pending'
      ? 'Provider confirmation is pending. Refresh the credit evidence later.'
      : reasonCode === 'lookup_failure'
        ? 'Credit evidence could not be verified with the provider. Check the provider connection and retry.'
        : reasonCode === 'provider_failed'
          ? 'The provider reports that the credit operation failed. Review the provider record.'
          : null;
  return {
    amount: status === 'confirmed' ? cents / (currencyFactor([...currencies][0]) || 100) : null,
    currency: currencies.size === 1 ? [...currencies][0] : null,
    status,
    reasonCode,
    breakdown,
    ...(error ? { error } : {}),
  };
}

function verificationMessage(reason) {
  return ({
    missing_reference: 'No provider reference is available to verify post-booking credits.',
    unsupported_route: 'This payment route cannot yet be fully verified.',
    incomplete_coverage: 'Not all applicable payment and accounting scopes were verified. Review coverage details before relying on an amount.',
    lookup_failure: 'Provider lookup failed. Check the connection and refresh again.',
    storage_failure: 'Verification could not be stored safely. Retry or contact support.',
  })[reason] || 'Credits have not yet been fully verified.';
}

export async function attachReportCredits({ db, tenantId, bookings, groups }) {
  const rows = [];
  const verifications = [];
  try {
    // Only query relevant IDs, with bounded filters and stable full pagination.
    for (const source of ['booking', 'complex_event_booking']) {
      const ids = bookings.filter(b => (b._report_booking_source === 'complex' ? 'complex_event_booking' : 'booking') === source).map(b => b.id);
      for (let i = 0; i < ids.length; i += 100) {
        const verificationResult = await db.from('booking_credit_verification').select('*')
          .eq('tenant_id', tenantId).eq('booking_source', source).in('booking_id', ids.slice(i, i + 100));
        if (verificationResult.error) throw new Error(`Failed to load credit verification: ${verificationResult.error.message}`);
        verifications.push(...(verificationResult.data || []));
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
    const originals = bookings.filter(b => ids.has(b.id) && (b._report_booking_source === 'complex' ? 'complex_event_booking' : 'booking') === source);
    group.credits = projectCredits(evidence, {
      bookingIds: [...ids],
      verifications: verifications.filter(v => v.booking_source === source
        && (v.reason_code !== 'verified_empty' || originals.some(b => b.id === v.booking_id
          && v.coverage?.referenceFingerprint === creditVerificationFingerprint(b)))),
      historicalUnknown: originals.some(b => b.status === 'cancelled' && !evidence.some(r => r.booking_ids.includes(b.id))),
      partialScope: evidence.some(r => r.booking_ids.some(id => !ids.has(id))),
    });
  }
}