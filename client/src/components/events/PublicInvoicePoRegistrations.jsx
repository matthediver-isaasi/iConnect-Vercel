import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const PAGE_SIZE = 10;
const attendeeFields = {
  attendee_first_name: 'First name', attendee_last_name: 'Last name',
  attendee_email: 'Email', attendee_job_title: 'Job title',
  attendee_phone: 'Phone', attendee_organization: 'Submitted organisation',
  ticket_class_name: 'Ticket', ticket_price: 'Ticket price (£)',
  total_cost: 'Registration value (£)', status: 'Status',
  booking_reference: 'Booking reference', created_at: 'Registration date',
  purchase_order_number: 'Purchase Order Number', track_access: 'Track access',
  third_party_consent: 'Third-party consent', dietary_selections: 'Dietary requirements',
  allergy_selections: 'Allergies', accessibility_selections: 'Accessibility requirements',
  designation: 'Designation', buddy: 'Buddy', badge: 'Badge',
};

function display(value) {
  if (value == null || value === '') return 'Not supplied';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(v => typeof v === 'object' ? `${v.name || ''}${v.severity ? ` (${v.severity})` : ''}` : String(v)).join(', ') || 'None';
  return String(value);
}

function Details({ entries }) {
  return <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
    {entries.map(([label, value]) => <div key={label} className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap break-words">{display(value)}</dd>
    </div>)}
  </dl>;
}

export default function PublicInvoicePoRegistrations({ groups, allGroups, organizations, renderFormAnswers }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const matching = groups.filter(group => group.isPublicInvoicePo);
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  useEffect(() => { setPage(1); setSelected(null); }, [groups]);
  const date = value => value ? new Date(value).toLocaleString() : 'Not recorded';
  return <>
    <Card data-testid="public-invoice-po-registrations">
      <CardHeader><CardTitle>Public Invoice / PO Registrations</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">Invoice intentions only. No invoice or payment has been created by this registration method.</p>
        {matching.length === 0 ? <p className="text-sm">No public Invoice / PO registrations match the current filters.</p> :
          <div className="divide-y">{matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(group => {
            const first = group.attendees[0];
            const purchaser = group.publicInvoicePurchaser || {};
            return <button type="button" key={`${group.eventId}-${first.id}`} className="w-full text-left rounded-md p-3 hover:bg-muted focus-visible:outline focus-visible:outline-2" onClick={() => {
              // Filters may hide individual attendees. Details always show the complete booking.
              setSelected(allGroups.find(g => g.eventId === group.eventId && (group.groupRef ? g.groupRef === group.groupRef : g.attendees.some(a => a.id === first.id))) || group);
            }}>
              <p className="font-medium">{[purchaser.first_name, purchaser.last_name].filter(Boolean).join(' ') || [first.attendee_first_name, first.attendee_last_name].filter(Boolean).join(' ')}</p>
              <p className="text-sm break-words">{purchaser.email || first.attendee_email}</p>
              <p className="text-sm text-muted-foreground">{group.eventTitle} · {[...new Set(group.attendees.map(a => a.ticket_class_name).filter(Boolean))].join(', ')}</p>
              <p className="text-sm">PO: {group.groupPayment.purchaseOrderNumber || 'Not supplied'} · {date(first.created_at)}</p>
            </button>;
          })}</div>}
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>{matching.length} registrations · Page {page} of {pages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>
      </CardContent>
    </Card>
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Public Invoice / PO registration</DialogTitle>
          <DialogDescription>{selected?.eventTitle} — registration details and submitted form answers.</DialogDescription>
        </DialogHeader>
        {selected && <div className="space-y-6">
          <Details entries={[['Payment method', 'Invoice / PO'], ['Purchase Order Number', selected.groupPayment.purchaseOrderNumber], ['Booking group', selected.groupRef], ['Event', selected.eventTitle]]} />
          <section className="space-y-3"><h3 className="font-semibold">Purchaser contact details</h3>
            <Details entries={Object.entries(selected.publicInvoicePurchaser || {}).map(([key, value]) => [key.replaceAll('_', ' '), value])} />
            {renderFormAnswers(selected, selected.publicInvoicePurchaser?.email)}
          </section>
          {selected.attendees.map((attendee, index) => <section key={attendee.id} className="border-t pt-4 space-y-3">
            <h3 className="font-semibold">Attendee {index + 1}</h3>
            <Details entries={[...Object.entries(attendeeFields).map(([key, label]) => [label, attendee[key]]), ['Organisation', organizations[attendee.organization_id]], ['Payment method', attendee.payment_method === 'public_invoice_po' ? 'Invoice / PO' : attendee.payment_method]]} />
            {attendee.attendee_email?.toLowerCase() !== selected.publicInvoicePurchaser?.email?.toLowerCase() && renderFormAnswers(selected, attendee.attendee_email)}
          </section>)}
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}