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
  return <article className="space-y-3 rounded-md border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Badge variant="outline">{labels[record.state] || "Unknown state — reload history"}</Badge>
      <span className="text-xs text-muted-foreground">Requested {requestDate(record.createdAt)}</span>
    </div>
    <MemberChangeRequestSummary summary={record.summary} />
    {record.reviewReason && <p className="whitespace-pre-wrap break-words text-sm">Review / withdrawal reason: {record.reviewReason}</p>}
    {record.state === "approved" && <p className="text-sm text-muted-foreground">Approval authorises separate administrator financial processing. It is not evidence of payment, refund or an applied membership change.</p>}
    <p className="break-all text-xs text-muted-foreground">Request reference: {record.id}</p>
    {children}
  </article>;
}
