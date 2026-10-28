import { Badge } from "@/components/ui/badge";
import { requestDate, requestMoney } from "@/lib/memberChangeRequests";

export function MemberChangeRequestSummary({ summary = {} }) {
  return <div className="space-y-3 text-sm">
    <p className="font-medium">{summary.targetName || "Membership structure not supplied"}</p>
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div><dt className="text-muted-foreground">Effective date</dt><dd>{requestDate(summary.effectiveDate)}</dd></div>
      <div><dt className="text-muted-foreground">Renewal date</dt><dd>{requestDate(summary.renewalDate)}</dd></div>
      <div><dt className="text-muted-foreground">Payment due for review</dt><dd>{requestMoney(summary.paymentDueMinor, summary.currency)}</dd></div>
      <div><dt className="text-muted-foreground">Eligible surplus for review</dt><dd>{requestMoney(summary.surplusMinor, summary.currency)}</dd></div>
      {typeof summary.monthlyAmountMinor === "number" && Number.isFinite(summary.monthlyAmountMinor) && <div>
        <dt className="text-muted-foreground">Current monthly amount</dt>
        <dd>{requestMoney(summary.monthlyAmountMinor, summary.currency)}</dd>
        <dd className="mt-1 text-xs text-muted-foreground">Quoted monthly amount, not a guaranteed total. Any processing requires separate administrator action.</dd>
      </div>}
    </dl>
    {summary.reason && <p className="whitespace-pre-wrap break-words"><span className="text-muted-foreground">Member reason: </span>{summary.reason}</p>}
  </div>;
}

export function MemberChangeRequestRecord({ record, children }) {
  const labels = { pending: "Pending review", approved: "Approved for processing", rejected: "Rejected", withdrawn: "Withdrawn" };
  // Only the safe server status is used. Never render provider evidence, errors
  // or URLs from a progress response, including for an unrecognised status.
  const progressLabels = {
    approved: ["Approved for processing", "Approved, but financial processing has not started. Approval alone does not confirm payment, refund or membership application."],
    processing: ["Processing change", "Financial processing is in progress. Payment, refund and membership application are not yet confirmed by this status."],
    applying: ["Applying membership change", "Settlement is recorded, but membership application is not yet confirmed. The change is still being applied."],
    awaiting_payment: ["Awaiting payment", "Payment settlement is still awaited. Payment and membership application are not yet confirmed."],
    awaiting_refund: ["Awaiting refund", "Refund settlement is still awaited. A completed refund and membership application are not yet confirmed."],
    awaiting_reconciliation: ["Awaiting reconciliation", "Finance needs to verify the existing processing outcome. Payment, refund and membership application are not confirmed by this status. Contact your membership team for help."],
    applied: ["Membership change applied", "Membership application is confirmed. This status does not by itself confirm a cash refund."],
    unavailable: ["Processing status unavailable", "The latest processing status could not be verified. Reload the request history or contact your membership team. Do not assume payment, refund or membership application is complete."],
  };
  const progress = record.state === "approved" && record.progress
    ? progressLabels[Object.hasOwn(progressLabels, record.progress.state) ? record.progress.state : "unavailable"]
    : null;
  return <article className="space-y-3 rounded-md border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Badge variant="outline">{progress?.[0] || labels[record.state] || "Unknown state — reload history"}</Badge>
      <span className="text-xs text-muted-foreground">Requested {requestDate(record.createdAt)}</span>
    </div>
    <MemberChangeRequestSummary summary={record.summary} />
    {record.reviewReason && <p className="whitespace-pre-wrap break-words text-sm">Review / withdrawal reason: {record.reviewReason}</p>}
    {record.state === "approved" && <p className="text-sm text-muted-foreground">{progress?.[1] || "Approval authorises separate administrator financial processing. It is not evidence of payment, refund or an applied membership change."}</p>}
    <p className="break-all text-xs text-muted-foreground">Request reference: {record.id}</p>
    {children}
  </article>;
}
