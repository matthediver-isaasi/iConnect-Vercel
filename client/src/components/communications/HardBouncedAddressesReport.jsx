import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import BounceDetails from "./BounceDetails";
import { formatBounceDate } from "./bounceModel.mjs";
import { useBounceReport, useResolveBounce } from "./use-bounces";

export default function HardBouncedAddressesReport({ active = true }) {
  const [view, setView] = useState("active");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const query = useBounceReport({ view, page, search, active });
  const resolve = useResolveBounce();
  const rows = query.data?.items || [];
  const total = query.data?.total || 0;
  const pageSize = query.data?.pageSize || 50;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const openDetails = (item, resume = false) => {
    setSelected(item);
    setResolving(resume);
    setReason("");
    resolve.reset();
  };
  const close = () => {
    if (resolve.isPending) return;
    setSelected(null);
    setReason("");
    resolve.reset();
  };
  const submit = (event) => {
    event.preventDefault();
    if (!reason.trim() || resolve.isPending) return;
    resolve.mutate({ item: selected, reason }, { onSuccess: () => {
      setNotice("Bounce resolved. Future campaign eligibility will be checked normally. No email was sent and subscription preferences were not changed.");
      setSelected(null);
      setReason("");
      // The resolved row leaves the active view; return to a valid page.
      setPage(1);
    } });
  };
  if (!active) return null;
  return <section className="space-y-5" data-testid="hard-bounced-addresses-report">
    <div className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div><h2 className="text-lg font-semibold text-slate-900">Hard-bounced addresses</h2><p className="mt-1 max-w-3xl text-sm text-slate-700">Active hard bounces pause campaign emails to the address, including members who share it. Delivery restrictions are separate from subscription preferences.</p></div>
      <Button type="button" variant="outline" className="shrink-0" onClick={() => query.refetch()} disabled={query.isFetching}><RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />Refresh</Button>
    </div>
    <div className="flex flex-col gap-4 rounded-lg border border-slate-200 p-4 sm:flex-row sm:items-end">
      <div className="flex-1"><Label htmlFor="bounce-search">Search addresses</Label><div className="relative mt-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" aria-hidden="true" /><Input id="bounce-search" className="pl-9" placeholder="Search email or member" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></div></div>
      <div className="sm:w-52"><Label htmlFor="bounce-view">Bounce status</Label><Select value={view} onValueChange={(next) => { setView(next); setPage(1); }}><SelectTrigger id="bounce-view" className="mt-1"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">Active — paused</SelectItem><SelectItem value="resolved">Resolved</SelectItem><SelectItem value="all">All addresses</SelectItem></SelectContent></Select></div>
    </div>
    {notice && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</p>}
    {query.isError ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-6 text-center"><AlertTriangle aria-hidden="true" className="mx-auto h-6 w-6 text-red-600" /><h3 className="mt-2 font-medium text-red-900">Unable to load bounced addresses</h3><p className="mt-1 text-sm text-red-700">{query.error.message}</p><Button variant="outline" className="mt-4" onClick={() => query.refetch()} disabled={query.isFetching}>Try again</Button></div>
      : query.isLoading ? <div role="status" aria-label="Loading bounced addresses" className="space-y-3 rounded-lg border border-slate-200 p-4">{[1, 2, 3, 4].map((row) => <div key={row} className="h-16 animate-pulse rounded bg-slate-100" />)}</div>
      : rows.length === 0 ? <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center"><AlertTriangle aria-hidden="true" className="mx-auto mb-3 h-6 w-6 text-slate-400" /><h3 className="font-medium text-slate-800">{search ? "No addresses match your search" : view === "active" ? "No active hard bounces" : "No bounced addresses in this view"}</h3><p className="mt-1 text-sm text-slate-600">{search ? "Try another search or clear your filters." : "Recorded hard bounces will appear here when available."}</p>{(search || view !== "active" || page !== 1) && <Button variant="outline" className="mt-4" onClick={() => { setSearch(""); setView("active"); setPage(1); }}>Reset filters</Button>}</div>
      : <div className="overflow-x-auto rounded-lg border border-slate-200"><table className="w-full text-left text-sm"><caption className="sr-only">Addresses with recorded hard bounces</caption><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th scope="col" className="px-4 py-3">Address / members</th><th scope="col" className="px-4 py-3">Last bounced</th><th scope="col" className="px-4 py-3">Reason</th><th scope="col" className="px-4 py-3">Status</th><th scope="col" className="px-4 py-3">Actions</th></tr></thead><tbody className="divide-y divide-slate-100">{rows.map((item) => <tr key={item.id} className="hover:bg-slate-50">
        <td className="min-w-56 px-4 py-4"><div className="break-all font-medium text-slate-900">{item.email}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{item.members?.length ? item.members.map((member) => <Link key={member.id} to={`/members/${encodeURIComponent(member.id)}`} className="text-xs text-primary underline underline-offset-2">{member.name || "Unnamed member"}</Link>) : <span className="text-xs text-slate-500">No linked members</span>}</div></td>
        <td className="min-w-40 px-4 py-4 text-slate-600">{formatBounceDate(item.last_bounced_at)}</td>
        <td className="max-w-xs px-4 py-4"><p className="line-clamp-2 break-words text-slate-700">{item.reason || "No reason recorded"}</p>{item.smtp_code && <p className="mt-1 text-xs text-slate-500">SMTP {item.smtp_code}</p>}</td>
        <td className="px-4 py-4"><Badge variant="outline" className={item.resolved_at ? "border-slate-300 text-slate-600" : "whitespace-nowrap border-amber-300 bg-amber-50 text-amber-900"}>{item.resolved_at ? "Resolved" : "Campaign emails paused"}</Badge></td>
        <td className="px-4 py-4"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => openDetails(item)} aria-label={`View bounce details for ${item.email}`}>Details</Button>{!item.resolved_at && <Button size="sm" variant="outline" onClick={() => openDetails(item, true)} aria-label={`Review resuming campaign emails for ${item.email}`}>Resume campaign emails…</Button>}</div></td>
      </tr>)}</tbody></table></div>}
    {!query.isError && !query.isLoading && total > 0 && <div className="flex flex-col gap-3 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between"><p>{total.toLocaleString()} addresses · {pageSize} per page</p><div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={page === 1 || query.isFetching} onClick={() => setPage((current) => current - 1)}><ChevronLeft aria-hidden="true" className="mr-1 h-4 w-4" />Previous</Button><span>Page {page} of {pages}</span><Button size="sm" variant="outline" disabled={page >= pages || query.isFetching} onClick={() => setPage((current) => current + 1)}>Next<ChevronRight aria-hidden="true" className="ml-1 h-4 w-4" /></Button></div></div>}
    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) close(); }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" onEscapeKeyDown={(event) => { if (resolve.isPending) event.preventDefault(); }} onPointerDownOutside={(event) => { if (resolve.isPending) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{resolving ? "Resume campaign eligibility?" : "Hard bounce details"}</DialogTitle><DialogDescription>{resolving ? "Resolve the hard-bounce restriction only after the underlying issue has been addressed. Your reason is recorded for audit." : "Delivery history for this address. Subscription preferences are unchanged."}</DialogDescription></DialogHeader>
      {selected && <BounceDetails item={selected} />}
      {resolving ? <form onSubmit={submit} className="space-y-4"><p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">The email provider’s suppression state will be checked without changing it. If still suppressed, an administrator must resolve that with the provider first. This action does not send emails, replay missed campaigns, or resubscribe anyone; future campaigns still follow normal eligibility and consent checks.</p><div><Label htmlFor="bounce-resolution-reason">Reason for resolution <span aria-hidden="true">*</span></Label><Textarea id="bounce-resolution-reason" required value={reason} onChange={(event) => setReason(event.target.value)} disabled={resolve.isPending} className="mt-1" placeholder="Describe what was corrected and why campaign eligibility can resume." /></div>{resolve.isError && <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{resolve.error.message}{resolve.error.status === 409 && <Button type="button" variant="link" className="mt-2 h-auto p-0 text-red-800" onClick={() => { close(); query.refetch(); }}>Close and refresh report</Button>}</div>}<DialogFooter><Button type="button" variant="outline" onClick={close} disabled={resolve.isPending}>Cancel</Button><Button type="submit" disabled={!reason.trim() || resolve.isPending}>{resolve.isPending ? "Checking provider…" : "Confirm resolution"}</Button></DialogFooter></form>
        : <DialogFooter><Button variant="outline" onClick={close}>Close</Button>{selected && !selected.resolved_at && <Button onClick={() => setResolving(true)}>Resume campaign emails…</Button>}</DialogFooter>}
    </DialogContent></Dialog>
  </section>;
}
