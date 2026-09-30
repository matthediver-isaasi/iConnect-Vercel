/** Persist reporting evidence only. This module never invokes a provider write. */
export function currencyFactor(currency) {
  if (!/^[A-Za-z]{3}$/.test(currency || '')) return null;
  return 10 ** new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
}

export async function persistBookingCreditEvidence({
  db, tenantId, source, operationKey, bookings, leg, provider, providerId = null,
  amountMinor = null, currency = null, status = 'unavailable',
  paymentReference = null, detail = {}, evidenceKey,
}) {
  if (!tenantId || !['booking', 'complex_event_booking'].includes(source) || !bookings?.length) {
    throw new Error('Invalid credit evidence scope');
  }
  const bookingIds = [...new Set(bookings.map(b => b.id))].sort();
  currency = currency?.toUpperCase() || null;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) amountMinor = null;
  if (!/^[A-Z]{3}$/.test(currency || '')) currency = null;
  if (status === 'confirmed' && (amountMinor === null || !currency || !providerId)) status = 'unavailable';
  const refs = [...new Set(bookings.map(b => b.booking_group_reference).filter(Boolean))];
  const { error } = await db.from('booking_reversal_evidence').upsert({
    tenant_id: tenantId, booking_source: source,
    evidence_key: evidenceKey || `${operationKey}:${leg}`,
    operation_key: operationKey, leg, provider, provider_id: providerId,
    amount_minor: amountMinor, currency, status, booking_ids: bookingIds,
    group_reference: refs.length === 1 ? refs[0] : null,
    payment_reference: paymentReference, detail, updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,booking_source,evidence_key' });
  if (error) throw new Error(`Credit evidence persistence failed: ${error.message}`);
}

export async function captureCancellationCredits({ db, tenantId, source, operationKey, bookings, results }) {
  for (const [leg, result] of [['refund', results.stripeRefund], ['credit_note', results.xeroCreditNote]]) {
    if (!result) continue;
    // Requested amounts on failures/alreadyRefunded are not provider evidence.
    const providerId = result.refundId || result.creditNoteId || null;
    if (!providerId) {
      const { data, error } = await db.from('booking_reversal_evidence').select('provider_id, status')
        .eq('tenant_id', tenantId).eq('booking_source', source)
        .eq('evidence_key', `${operationKey}:${leg}`).limit(1);
      if (error) throw new Error(`Credit evidence lookup failed: ${error.message}`);
      if (data?.[0]?.provider_id) continue;
    }
    const actual = providerId && result.success && !result.alreadyRefunded;
    const paymentBooking = bookings.find(b => leg === 'refund'
      ? b.stripe_payment_intent_id : (b.accounting_invoice_id || b.xero_invoice_id)) || bookings[0];
    const status = !result.success ? (result.skipped || result.requiresManualRefund || result.requiresManualAction ? 'unavailable' : 'failed')
      : !actual ? 'unavailable'
        : ['pending', 'requires_action', 'DRAFT', 'SUBMITTED'].includes(result.status) ? 'pending'
          : ['failed', 'canceled', 'cancelled', 'VOIDED', 'DELETED'].includes(result.status) ? 'failed'
            : ['succeeded', 'AUTHORISED', 'PAID'].includes(result.status) ? 'confirmed' : 'unavailable';
    await persistBookingCreditEvidence({
      db, tenantId, source, operationKey, bookings, leg,
      provider: leg === 'refund' ? 'stripe' : (result.provider || 'xero'),
      providerId, amountMinor: actual && result.currency && result.amount != null && Number.isFinite(Number(result.amount))
        ? (result.amountMinor ?? Math.round(Number(result.amount) * currencyFactor(result.currency))) : null,
      currency: actual ? result.currency : null, status,
      paymentReference: leg === 'refund' ? paymentBooking.stripe_payment_intent_id : (paymentBooking.accounting_invoice_id || paymentBooking.xero_invoice_id),
      detail: { providerStatus: result.status || null, error: result.error || result.reason || null, historical: false },
    });
  }
}

export async function prepareCancellationCredits({ db, tenantId, source, operationKey, bookings, skipStripeRefund = false, skipXeroCreditNote = false }) {
  for (const leg of ['refund', 'credit_note']) {
    const booking = bookings.find(b => leg === 'refund'
      ? !skipStripeRefund && b.payment_method === 'card' && b.stripe_payment_intent_id
      : !skipXeroCreditNote && b.payment_method !== 'public_invoice_po' && (b.accounting_invoice_id || b.xero_invoice_id));
    if (!booking) continue;
    // Insert-only: a reporting retry must never downgrade confirmed evidence.
    const { error } = await db.from('booking_reversal_evidence').upsert({
      tenant_id: tenantId, booking_source: source,
      evidence_key: `${operationKey}:${leg}`, operation_key: operationKey, leg,
      provider: leg === 'refund' ? 'stripe' : (booking.accounting_provider || 'xero'),
      status: 'unavailable', booking_ids: [...new Set(bookings.map(b => b.id))].sort(),
      group_reference: booking.booking_group_reference || null,
      payment_reference: leg === 'refund' ? booking.stripe_payment_intent_id : (booking.accounting_invoice_id || booking.xero_invoice_id),
      detail: { historical: false, awaitingProviderEvidence: true },
    }, { onConflict: 'tenant_id,booking_source,evidence_key', ignoreDuplicates: true });
    if (error) throw new Error(`Cannot retain reversal operation identity: ${error.message}`);
  }
}