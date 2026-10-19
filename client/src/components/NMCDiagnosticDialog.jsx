import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NMC_DIAGNOSTIC_PAGE_SIZE, nmcDiagnosticIdentity, nmcDiagnosticRows, nmcReasonLabel, nmcReviewGuidance } from "@/lib/nmcMembershipReport.mjs";

export default function NMCDiagnosticDialog({ selection, report, onClose }) {
  const [page, setPage] = useState(0);
  const rows = nmcDiagnosticRows(report, selection.group, selection.reason);
  const reportedTotal = report?.[`${selection.group}Counts`]?.[selection.reason];
  const total = rows?.length ?? (Number.isInteger(reportedTotal) && reportedTotal >= 0 ? reportedTotal : undefined);
  const pages = rows ? Math.max(1, Math.ceil(total / NMC_DIAGNOSTIC_PAGE_SIZE)) : 1;
  const start = page * NMC_DIAGNOSTIC_PAGE_SIZE;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-w-4xl max-h-[85dvh] overflow-y-auto" data-testid="nmc-diagnostic-dialog"
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (selection.trigger?.isConnected && !selection.trigger.disabled) selection.trigger.focus();
      }}>
      <DialogHeader>
        <DialogTitle>{nmcReasonLabel(selection.reason)} — {total === undefined ? "total unavailable" : `${total.toLocaleString("en-GB")} members`}</DialogTitle>
        <DialogDescription>{nmcReviewGuidance(selection.reason)}</DialogDescription>
      </DialogHeader>
      {rows === null ? <p role="status">Member details are unavailable for this snapshot. Refresh the report and try again. No empty list can be inferred.</p> : <>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm" data-testid="table-nmc-diagnostics">
            <caption className="sr-only">Members: {nmcReasonLabel(selection.reason)}</caption>
            <thead><tr>{["Name", "Email", "Member class", "Member record"].map(label => <th key={label} scope="col" className="px-4 py-3 text-left font-medium">{label}</th>)}</tr></thead>
            <tbody>{rows.slice(start, start + NMC_DIAGNOSTIC_PAGE_SIZE).map(row => {
              const identity = nmcDiagnosticIdentity(row);
              return <tr key={row.memberId} className="border-t">
                <th scope="row" className="px-4 py-3 text-left font-medium">{identity.name}</th>
                <td className="px-4 py-3 break-all">{identity.email}</td>
                <td className="px-4 py-3">{identity.memberClass}</td>
                <td className="px-4 py-3"><Link className="underline underline-offset-4 focus-visible:outline focus-visible:outline-2" to={`/members/${encodeURIComponent(row.memberId)}`} aria-label={`View member: ${identity.name}`}>View member</Link></td>
              </tr>;
            })}{total === 0 && <tr><td colSpan={4} className="px-4 py-6">No members have this reason in this snapshot.</td></tr>}</tbody>
          </table>
        </div>
        <nav aria-label="Diagnostic member pages" className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-sm">{total ? `${start + 1}–${Math.min(start + NMC_DIAGNOSTIC_PAGE_SIZE, total)} of ${total}` : "0 members"} · Page {page + 1} of {pages}</p>
          <div className="flex gap-2"><Button variant="outline" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</Button><Button variant="outline" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>Next</Button></div>
        </nav>
      </>}
      <p className="text-xs text-muted-foreground">Read-only diagnostics. Viewing members does not change membership records, payments, addresses or report settings.</p>
    </DialogContent>
  </Dialog>;
}
