// Invalid and absent dates sort last; an import timestamp is never an invoice date.
export function validActivityDate(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return null;
  const day = String(value).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const parsed = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return null;
  }
  return value;
}

export function bookingActivityDate(event, booking) {
  return validActivityDate(event?.start_date)
    || validActivityDate(booking?.created_date)
    || validActivityDate(booking?.created_at);
}

export function mergeHistoricalInvoiceActivity(activity, records) {
  const invoices = records.map(record => ({
    key: `historical-invoice-${record.id}`,
    id: record.id,
    source: "historical_invoice",
    record,
    date: validActivityDate(record.invoice_date),
  }));
  const timestamp = value => validActivityDate(value) ? new Date(value).getTime() : -Infinity;
  return [...activity, ...invoices].sort((a, b) => {
    const left = timestamp(a.date);
    const right = timestamp(b.date);
    return left === right ? a.key.localeCompare(b.key) : left > right ? -1 : 1;
  });
}
