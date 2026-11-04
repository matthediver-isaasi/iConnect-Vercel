import React from "react";
import { useQuery } from "@tanstack/react-query";

export default function ActivityCreditNoteActions({ booking, source, tenantId, request = fetch }) {
  const creditId = booking.accounting_credit_note_id || booking.xero_credit_note_id;
  const number = booking.accounting_credit_note_number || booking.xero_credit_note_number;
  const canRead = !!(creditId && booking.id && booking.booking_group_reference);
  const params = new URLSearchParams({ bookingId: booking.id, source: source === 'complex' ? 'complex_event_booking' : 'booking' });
  const url = `/api/booking-credit-note/${encodeURIComponent(booking.booking_group_reference || '')}?${params}`;
  const { data, isError, isLoading, refetch } = useQuery({
    queryKey: ['activity-credit-note', tenantId, source, booking.id, creditId],
    enabled: canRead,
    retry: false,
    queryFn: async () => {
      const response = await request(`${url}&format=json`, { credentials: 'include' });
      if (!response.ok) throw new Error('Credit-note details could not be loaded.');
      return response.json();
    },
  });
  if (!creditId) return null;
  let amount = null;
  if (data?.amount_minor != null && data.currency) {
    const formatter = new Intl.NumberFormat('en-GB', { style: 'currency', currency: data.currency });
    amount = formatter.format(data.amount_minor / 10 ** formatter.resolvedOptions().maximumFractionDigits);
  }
  const invoiceNumber = booking.accounting_invoice_number || booking.xero_invoice_number;
  return <section aria-label="Credit note" className="mt-2 rounded-md border border-green-200 bg-green-50 p-3 text-sm">
    <p className="font-medium text-green-900">Credit note raised{number ? `: ${number}` : ''}</p>
    {amount && <p>Credit note total: {amount}</p>}
    {invoiceNumber && <p className="text-xs">For invoice: {invoiceNumber}</p>}
    {canRead && isLoading && <p className="text-xs">Loading credit-note details…</p>}
    {data && !amount && <p className="text-xs">Amount not recorded locally. View the credit note for details.</p>}
    {isError && <p role="alert" className="text-xs">Credit-note details could not be loaded. <button type="button" className="underline" onClick={() => refetch()}>Retry</button></p>}
    {canRead ? <div className="mt-2 flex flex-wrap gap-3">
      <a className="underline font-medium" href={`${url}&inline=true`} target="_blank" rel="noopener noreferrer">View credit note</a>
      <a className="underline font-medium" href={url}>Download credit note</a>
    </div> : <p className="text-xs">The booking reference is missing, so the PDF cannot be retrieved.</p>}
  </section>;
}
