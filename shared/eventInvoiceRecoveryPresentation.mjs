const AUTOMATIC_RECOVERY = new Set(['pending', 'processing', 'retry']);

export function eventInvoiceId(record) {
  return record?.accounting_invoice_id || record?.accountingInvoiceId
    || record?.xero_invoice_id || record?.xeroInvoiceId || null;
}

export function eventInvoiceNumber(record) {
  return record?.accounting_invoice_number || record?.accountingInvoiceNumber
    || record?.xero_invoice_number || record?.xeroInvoiceNumber || null;
}

export function eventInvoiceRecoveryStatus(record) {
  return record?.invoice_recovery_status || record?.invoiceRecoveryStatus || null;
}

function recoveryApplicable(record) {
  const method = record?.payment_method || record?.paymentMethod;
  if (record?.status === 'cancelled' || method === 'public_invoice_po'
    || ['free', 'voucher', 'training_fund', 'program_ticket', 'program_tickets', 'ticket_balance'].includes(method)) return false;
  const rawTotal = record?.total_cost ?? record?.total_paid ?? record?.totalCost;
  if (rawTotal !== null && rawTotal !== undefined && rawTotal !== '' && Number.isFinite(Number(rawTotal))) {
    const total = Number(rawTotal);
    const funded = Number(record?.voucher_amount ?? record?.voucherAmount ?? 0)
      + Number(record?.training_fund_amount ?? record?.trainingFundAmount ?? 0);
    if (total <= 0 || (funded > 0 && funded >= total)) return false;
  }
  return true;
}

// Only durable, explicit recovery state is evidence of an awaited invoice.
// A blank legacy invoice or a provider error is not evidence of queued work.
export function eventInvoiceAwaited(record) {
  return !eventInvoiceId(record) && recoveryApplicable(record)
    && (AUTOMATIC_RECOVERY.has(eventInvoiceRecoveryStatus(record))
      || eventInvoiceRecoveryStatus(record) === 'needs_review');
}

export function eventInvoiceShouldPoll(record) {
  return eventInvoiceAwaited(record) && AUTOMATIC_RECOVERY.has(eventInvoiceRecoveryStatus(record));
}

export function eventInvoiceNeedsAttention(record) {
  return recoveryApplicable(record) && eventInvoiceRecoveryStatus(record) === 'needs_review';
}

// Invoice linkage can be on a later attendee in a historical group.
export function eventInvoiceGroupRecord(records = []) {
  return records.find(eventInvoiceId)
    || records.find(eventInvoiceNeedsAttention)
    || records.find(eventInvoiceAwaited)
    || records[0] || null;
}

export function eventInvoiceRetryAt(record) {
  const value = record?.invoice_recovery_next_attempt_at || record?.invoiceRecoveryNextAttemptAt;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function eventInvoiceRefetchInterval(query, records) {
  if (query.state?.status === 'error' || query.state?.fetchFailureCount > 0) return false;
  const groups = new Map();
  records.forEach((record, index) => {
    const reference = record?.booking_group_reference || record?.booking_reference || record?.id || index;
    const key = `${record?._source || ''}:${reference}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  return [...groups.values()].some(group => eventInvoiceShouldPoll(eventInvoiceGroupRecord(group))) ? 30000 : false;
}