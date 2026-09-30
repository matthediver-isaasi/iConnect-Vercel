import { currencyFactor, persistBookingCreditEvidence } from './bookingCreditEvidence.js';
import { projectCredits } from '../reports/_credits.js';

const checked = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data || [];
};
const providerStatus = status => ['succeeded', 'AUTHORISED', 'PAID'].includes(status) ? 'confirmed'
  : ['pending', 'requires_action', 'DRAFT', 'SUBMITTED'].includes(status) ? 'pending'
    : ['failed', 'canceled', 'VOIDED', 'DELETED'].includes(status) ? 'failed' : 'unavailable';

async function boundedRows(query, maximum = 500) {
  const rows = [];
  for (let offset = 0; ; ) {
    const page = checked(await query.order('id').range(offset, Math.min(offset + 99, maximum)));
    if (!page.length) return rows;
    rows.push(...page);
    if (rows.length > maximum) throw new Error(`Evidence allocation exceeds ${maximum} rows; manual review required`);
    offset += page.length;
  }
}

/**
 * One booking/payment reference per invocation, at most 100 refunds and 500
 * allocation rows. Cursor resumes provider pagination before advancing booking.
 * Provider dependencies expose reads only; caller never supplies provider IDs.
 */
export async function reconcileBookingCredits({ db, tenantId, source, bookingIds, cursor = {}, readRefunds, readCreditNote }) {
  if (!tenantId || !['booking', 'complex_event_booking'].includes(source)
    || !Array.isArray(bookingIds) || !bookingIds.length || bookingIds.length > 25
    || bookingIds.some(id => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error('Provide 1–25 booking UUIDs and a valid source');
  const index = Number(cursor.index || 0);
  if (!Number.isInteger(index) || index < 0 || index >= bookingIds.length) throw new Error('Invalid reconciliation cursor');
  if (cursor.after && !/^re_[a-zA-Z0-9]+$/.test(cursor.after)) throw new Error('Invalid refund cursor');
  if (cursor.noteIndex !== undefined && (!Number.isInteger(cursor.noteIndex) || cursor.noteIndex < 0 || cursor.noteIndex > 25 || cursor.after)) {
    throw new Error('Invalid credit note cursor');
  }
  const selected = checked(await db.from(source).select('*').eq('tenant_id', tenantId).eq('id', bookingIds[index]).limit(1))[0];
  if (!selected) throw new Error('Booking not found in this tenant');
  const existing = await boundedRows(db.from('booking_reversal_evidence').select('*')
    .eq('tenant_id', tenantId).eq('booking_source', source).contains('booking_ids', [selected.id]));
  let written = 0;
  let more = null;
  const completion = async nextCursor => {
    // Re-read durable evidence across the entire requested batch, not merely
    // this provider page. Earlier pending/ambiguous rows remain unresolved.
    const finalRows = await boundedRows(db.from('booking_reversal_evidence').select('*')
      .eq('tenant_id', tenantId).eq('booking_source', source).overlaps('booking_ids', bookingIds));
    const statuses = bookingIds.map(id => projectCredits(finalRows.filter(row => row.booking_ids.includes(id))).status);
    return { written, nextCursor, unresolved: !!nextCursor || statuses.some(status => status !== 'confirmed'), evidenceStatuses: [...new Set(statuses)] };
  };
  const save = async ({ leg, provider, providerId, amountMinor, currency, status, allocations, paymentReference, detail = {} }) => {
    const persisted = checked(await db.from('booking_reversal_evidence').select('*')
      .eq('tenant_id', tenantId).eq('booking_source', source).eq('provider', provider).eq('leg', leg).eq('provider_id', providerId).limit(1))[0];
    const allocationIds = new Set(allocations.map(b => b.id));
    const placeholders = existing.filter(r => !r.provider_id && r.leg === leg && r.provider === provider
      && (detail.knownOperationKey
        ? r.operation_key === detail.knownOperationKey
        : leg === 'credit_note' && paymentReference && r.payment_reference === paymentReference
          && r.booking_ids.length === allocationIds.size && r.booking_ids.every(id => allocationIds.has(id))));
    const prior = persisted || existing.find(r => r.provider === provider && r.provider_id === providerId && r.leg === leg)
      || (placeholders.length === 1 ? placeholders[0] : null);
    const ambiguousOperation = !!prior?.detail?.ambiguousOperation || (!prior && placeholders.length > 1);
    // A known operation/precise allocation wins over historical discovery.
    await persistBookingCreditEvidence({
      db, tenantId, source,
      operationKey: prior?.operation_key || `historical:${provider}:${providerId}`,
      evidenceKey: prior?.evidence_key || `provider:${provider}:${leg}:${providerId}`,
      bookings: prior ? prior.booking_ids.map(id => ({ id, booking_group_reference: prior.group_reference })) : allocations,
      leg, provider, providerId, amountMinor, currency, status: ambiguousOperation ? 'unavailable' : status,
      paymentReference,
      detail: { ...prior?.detail, historical: prior?.detail?.historical ?? true, ...detail, ambiguousOperation },
    });
    written++;
  };
  const findScope = async (column, reference) => {
    const scope = await boundedRows(db.from(source).select('*').eq('tenant_id', tenantId).eq(column, reference));
    if (!scope.length) throw new Error('Provider reference has no tenant-scoped booking');
    return scope;
  };
  if (selected.stripe_payment_intent_id && cursor.noteIndex === undefined) {
    const pi = selected.stripe_payment_intent_id;
    const scope = await findScope('stripe_payment_intent_id', pi);
    const page = await readRefunds(pi, cursor.after || undefined);
    for (const refund of page.data) {
      if ((typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id) !== pi) {
        throw new Error('Refund payment identity mismatch');
      }
      const id = refund.metadata?.booking_id;
      const group = refund.metadata?.booking_group_reference;
      const known = existing.find(r => r.leg === 'refund' && r.provider_id === refund.id);
      const requestIds = refund.metadata?.cancellation_request_ids?.split(',').sort().join('-');
      const knownOperationKey = requestIds ? `cancel-group:${requestIds}`
        : id ? `cancel:${refund.metadata?.cancellation_request_id || refund.metadata?.cancellation_reason}:${id}` : null;
      let allocations = id ? scope.filter(b => b.id === id)
        : group ? scope.filter(b => b.booking_group_reference === group) : scope;
      let exactRequests = false;
      const requestList = refund.metadata?.cancellation_request_ids?.split(',').filter(Boolean) || [];
      if (!id && requestList.length && requestList.length <= 100 && requestList.every(value => /^[0-9a-f-]{36}$/i.test(value))) {
        const requests = checked(await db.from('booking_cancellation_request').select('id, booking_id, booking_source')
          .eq('tenant_id', tenantId).in('id', requestList).limit(101));
        const requestBookingIds = new Set(requests.map(r => r.booking_id));
        const matched = scope.filter(book => requestBookingIds.has(book.id));
        exactRequests = requests.length === new Set(requestList).size
          && requests.every(r => (r.booking_source || 'booking') === source)
          && matched.length === requestBookingIds.size;
        if (exactRequests) allocations = matched;
      }
      const fullGroup = group && allocations.length > 0 && Number(refund.metadata?.booking_count) === allocations.length;
      const attributionKnown = (known && !known.detail?.ambiguousAttribution) || exactRequests || (id && allocations.length === 1) || fullGroup || scope.length === 1;
      if (!allocations.length) allocations = scope;
      await save({
        leg: 'refund', provider: 'stripe', providerId: refund.id,
        amountMinor: refund.amount, currency: refund.currency,
        status: attributionKnown ? providerStatus(refund.status) : 'unavailable',
        allocations, paymentReference: pi, detail: { providerStatus: refund.status, ambiguousAttribution: !attributionKnown, knownOperationKey },
      });
    }
    if (page.has_more) {
      if (!page.data.length) throw new Error('Provider returned an invalid pagination response');
      more = { index, after: page.data[page.data.length - 1].id };
    }
  }
  if (more) return completion(more);
  // Persisted evidence permits refresh even if a legacy booking link is absent.
  const creditIds = new Map(existing.filter(r => r.leg === 'credit_note' && r.provider_id).map(r => [r.provider_id, r.provider]));
  const bookingNoteId = selected.accounting_credit_note_id || selected.xero_credit_note_id;
  if (bookingNoteId) creditIds.set(bookingNoteId, selected.accounting_provider || 'xero');
  if (creditIds.size > 25) throw new Error('Credit note read limit exceeded; manual review required');
  const noteEntries = [...creditIds].sort(([a], [b]) => String(a).localeCompare(String(b)));
  const noteStart = cursor.noteIndex || 0;
  for (const [noteId, provider] of noteEntries.slice(noteStart, noteStart + 5)) {
    const prior = existing.find(r => r.provider_id === noteId && r.provider === provider);
    const allocations = prior ? prior.booking_ids.map(id => ({ id }))
      : await findScope(selected.accounting_credit_note_id ? 'accounting_credit_note_id' : 'xero_credit_note_id', noteId);
    const note = await readCreditNote(provider, noteId);
    if (note.providerId !== noteId) throw new Error('Credit note identity mismatch');
    await save({
      leg: 'credit_note', provider, providerId: noteId,
      amountMinor: Number.isFinite(note.amount) && note.currency ? Math.round(note.amount * currencyFactor(note.currency)) : null,
      currency: note.currency, status: providerStatus(note.status), allocations,
      paymentReference: selected.accounting_invoice_id || selected.xero_invoice_id,
      detail: { providerStatus: note.status },
    });
  }
  if (noteStart + 5 < noteEntries.length) more = { index, noteIndex: noteStart + 5 };
  return completion(more || (index + 1 < bookingIds.length ? { index: index + 1 } : null));
}