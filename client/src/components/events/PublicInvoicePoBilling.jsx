import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePublicInvoicePoBilling } from "@/hooks/usePublicInvoicePoBilling";

function money(amount, currency) {
  if (amount == null || !Number.isFinite(Number(amount))) return "Unavailable";
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "GBP" }).format(Number(amount)); }
  catch { return `${amount} ${currency || ""}`; }
}

function vatLabel(line) {
  const rate = line.taxPercentage;
  if (!line.taxType || typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return "VAT: rate unavailable";
  if (rate === 0) return "VAT: 0% (no VAT charged)";
  return `VAT: ${rate}% (included in the price)`;
}

export default function PublicInvoicePoBilling({ bookingId, isComplex, tenantId, viewerId, canCreateGuestMember = false, onCreateMember }) {
  const { billing, generate } = usePublicInvoicePoBilling({ bookingId, isComplex, tenantId, viewerId });
  const [confirmation, setConfirmation] = useState(false);
  const submitting = useRef(false);
  const data = billing.data;
  const status = data?.invoice?.status || data?.status;
  const queued = ["queued","pending","processing","retry"].includes(status);
  const blocked = status === "needs_review" || queued;
  const canGenerate = !!data?.member?.id && data?.canGenerate && !data?.invoice && !blocked;
  const confirm = async () => {
    if (submitting.current || !canGenerate || billing.isFetching) return;
    submitting.current = true;
    try { await generate.mutateAsync(data.fingerprint); setConfirmation(false); }
    catch { /* Mutation error is shown below; never retry a financial write automatically. */ }
    finally { submitting.current = false; }
  };
  return <section aria-label="Booking invoice" className="rounded-lg border bg-muted/20 p-4 space-y-4">
    <div><h3 className="font-semibold">Invoice for the whole booking</h3>
      <p className="text-sm text-muted-foreground">One invoice covers every attendee in this booking, including attendees hidden by report filters. It is billed to the original booker, not individual attendees.</p></div>
    {billing.isLoading && <div role="status" className="space-y-2"><span className="text-sm">Loading invoice details…</span><div className="h-16 rounded bg-muted animate-pulse" /></div>}
    {billing.isError && <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{billing.error.message}</p><Button variant="outline" onClick={() => billing.refetch()}>Retry invoice details</Button></div>}
    {data && <>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <div><dt className="text-muted-foreground">Original booker · billed to</dt><dd className="break-words">{[data.booker?.first_name, data.booker?.last_name].filter(Boolean).join(" ") || "Not supplied"}<br />{data.booker?.email}</dd></div>
        <div><dt className="text-muted-foreground">Whole-booking amount</dt><dd className="font-semibold">{money(data.amount, data.currency)}</dd></div>
        <div><dt className="text-muted-foreground">Booker account</dt><dd>{data.member?.id ? "Member account linked" : "No member account linked"}</dd></div>
      </dl>
      <div className="space-y-2"><h4 className="text-sm font-medium">Booking lines and tax summary</h4>
        {data.lines?.length ? <ul className="divide-y text-sm">{data.lines.map((line, index) => <li key={index} className="flex flex-wrap justify-between gap-2 py-2">
          <span className="min-w-0 break-words">{line.description}<span className="block text-xs text-muted-foreground">{vatLabel(line)}</span></span>
          <span>{money(line.amount, data.currency)}</span>
        </li>)}</ul> : <p className="text-sm text-muted-foreground">No invoice lines available. Review the booking before generating an invoice.</p>}
      </div>
      {!data.member?.id && <div className="space-y-2"><p className="text-sm">Create the original booker’s member account before generating the booking invoice.</p>
        {canCreateGuestMember && onCreateMember && <Button variant="outline" onClick={() => onCreateMember({ bookingId, isComplex: !!isComplex, identity: "purchaser" })}>Create booker account</Button>}</div>}
      {data.invoice && <div role="status" className="rounded-md border p-3 text-sm"><p className="font-medium">Invoice {data.invoice.number || data.invoice.id || "requested"}</p><p>Status: {data.invoice.status || "Pending"}{data.invoice.provider ? ` · ${data.invoice.provider}` : ""}</p></div>}
      {queued && <p role="status" className="text-sm">Invoice queued. No further generation is needed; status will refresh automatically.</p>}
      {data.invoice?.paymentStatus && <p className="text-sm">Payment status: {data.invoice.paymentStatus}</p>}
      {(data.reason || status === "needs_review") && <p role="status" className="text-sm">{status === "needs_review" && "Needs review: "}{data.reason || "An administrator must review this booking before an invoice can be generated."}</p>}
      {generate.isError && <p role="alert" className="text-sm text-destructive">{generate.error.message}</p>}
      {canGenerate && <Button disabled={billing.isFetching || generate.isPending} onClick={() => { generate.reset(); setConfirmation(true); }}>Generate invoice</Button>}
      {data.invoice && <p className="text-sm">Invoice email: {({sent:"Sent to the original booker",sent_external:"Already sent by the accounting provider",pending:"Awaiting automatic delivery",preparing:"Preparing",sending:"Sending",unknown:"Delivery uncertain — review before resending",needs_review:"Needs review",legacy_review:"Existing invoice — delivery needs review"})[data.invoice.emailStatus] || "Awaiting automatic delivery"}.</p>}
      <p className="text-xs text-muted-foreground">Once created, the invoice is emailed automatically to the original booker. No payment is recorded.</p>
    </>}
    <Dialog open={confirmation} onOpenChange={open => { if (!generate.isPending) setConfirmation(open); }}>
      <DialogContent onEscapeKeyDown={event => { if (generate.isPending) event.preventDefault(); }} onPointerDownOutside={event => { if (generate.isPending) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>Generate one invoice for this booking?</DialogTitle><DialogDescription>The invoice covers the whole booking and is billed to the original booker. Once created, it will be emailed to them automatically. No payment will be recorded.</DialogDescription></DialogHeader>
        <p className="text-sm">{data?.booker?.email} · {money(data?.amount, data?.currency)}</p>
        {generate.isError && <p role="alert" className="text-sm text-destructive">{generate.error.message}</p>}
        <DialogFooter><Button variant="outline" disabled={generate.isPending} onClick={() => setConfirmation(false)}>Cancel</Button><Button disabled={!canGenerate || billing.isFetching || generate.isPending} onClick={confirm}>{generate.isPending ? "Generating invoice…" : "Confirm generate invoice"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
