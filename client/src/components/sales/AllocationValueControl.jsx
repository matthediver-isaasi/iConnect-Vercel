import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { salesSettingsRequest, useSalesSettingsScope } from "./useSalesSettings";
import { allocationMoney, allocationNetMinor, currencyDigits } from "@/lib/allocationValue.mjs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Only mounted by the opportunity's admin surface, never by the member manager.
export default function AllocationValueControl({ allocationId }) {
  const { scopeKey, ready, tenant } = useSalesSettingsScope();
  const identity = useQuery({
    queryKey: ["allocation-value-dashboard-user", scopeKey],
    queryFn: ({ signal }) => salesSettingsRequest("/api/auth/tenant-user-me", {
      signal, headers: tenant ? { "X-Tenant-Id": tenant } : {},
    }),
    enabled: ready, retry: false,
  });
  const allowed = ready && identity.isSuccess && identity.data?.authenticated
    && Boolean(identity.data?.tenant?.id) && (!tenant || identity.data.tenant.id === tenant);
  if (!allowed || !allocationId) return null;
  return <AllocationValueEditor key={`${scopeKey}:${allocationId}`} allocationId={allocationId} tenant={identity.data.tenant.id} scopeKey={scopeKey} />;
}

function AllocationValueEditor({ allocationId, tenant, scopeKey }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  // Retain the exact payload and UUID after any uncertain response. Closing the
  // dialog does not discard it; retries must not create a second assignment.
  const attempt = useRef(null);
  const headers = { "X-Tenant-Id": tenant };
  const queryKey = ["sales-allocation-value", scopeKey, allocationId];
  const value = useQuery({
    queryKey, retry: false,
    queryFn: ({ signal }) => salesSettingsRequest(`/api/sales/allocation-values?id=${encodeURIComponent(allocationId)}`, { signal, headers }),
  });
  const save = useMutation({
    mutationFn: body => salesSettingsRequest("/api/sales/allocation-values", { method: "POST", headers, body: JSON.stringify(body) }),
    onSuccess: result => {
      qc.setQueryData(queryKey, result);
      qc.invalidateQueries({ queryKey: ["event-registration-report"] });
      attempt.current = null;
      setOpen(false);
      setAmount("");
      setReason("");
    },
  });
  if (value.isLoading) return <div role="status" aria-label="Loading ticket value" className="mt-3 h-6 w-40 animate-pulse rounded bg-slate-100" />;
  if (value.isError) return <div className="mt-3 text-sm text-rose-700" role="alert">Ticket value unavailable. <Button size="sm" variant="ghost" onClick={() => value.refetch()}>Retry</Button></div>;
  const data = value.data;
  if (!data) return null;
  if (data.status !== "pending") return <div className="mt-3 text-sm text-slate-600">
    {data.status === "historical" ? "Historical ticket value" : "Assigned ticket value"} · Total net {allocationMoney(data.netMinor, data.currency)} · VAT {allocationMoney(data.taxMinor, data.currency)}
  </div>;
  const netMinor = allocationNetMinor(amount, data.currency);
  const locked = save.isPending || Boolean(attempt.current);
  const submit = event => {
    event.preventDefault();
    if (save.isPending || (!attempt.current && (netMinor === null || !reason.trim()))) return;
    if (!attempt.current) attempt.current = { allocationId, netMinor, reason: reason.trim(), idempotencyKey: crypto.randomUUID() };
    save.mutate(attempt.current);
  };
  return <div className="mt-3 flex flex-wrap items-center gap-2">
    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800">Pending allocation</Badge>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Assign ticket value</Button>
    <Dialog open={open} onOpenChange={next => { if (!save.isPending) setOpen(next); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign ticket value</DialogTitle>
          <DialogDescription>Assign a total net value to all {data.places} places in this allocation, not a per-ticket price.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="rounded-lg border bg-slate-50 p-3 text-sm text-slate-600 space-y-2">
            <p>This creates no new invoice or payment. The original accepted proposal remains unchanged.</p>
            <p>VAT is derived by the server in proportion to the accepted line. Combined ticket allocations cannot exceed its net value. Any remaining bundle value represents non-ticket benefits.</p>
            <p>Accepted line: {allocationMoney(data.lineNetMinor, data.currency)} net · {allocationMoney(data.lineTaxMinor, data.currency)} VAT.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`allocation-net-${allocationId}`}>Total net value ({data.currency})</Label>
            <Input id={`allocation-net-${allocationId}`} inputMode="decimal" required value={amount} disabled={locked} onChange={e => setAmount(e.target.value)} aria-describedby={`allocation-net-help-${allocationId}`} />
            <p id={`allocation-net-help-${allocationId}`} className="text-xs text-slate-500">Enter a non-negative amount with up to {currencyDigits(data.currency)} decimal places. VAT is added separately.</p>
            {amount && netMinor === null && <p role="alert" className="text-sm text-rose-700">Enter a valid non-negative amount without rounding.</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`allocation-reason-${allocationId}`}>Reason</Label>
            <Textarea id={`allocation-reason-${allocationId}`} required value={reason} disabled={locked} onChange={e => setReason(e.target.value)} placeholder="Explain the ticket value assigned from this bundle" />
          </div>
          {save.isError && <div role="alert" className="text-sm text-rose-700">{save.error.message}<p className="mt-1">Retry submits the same value, reason and request key to prevent duplicates.</p>
            {[400, 409, 422].includes(save.error.status) && <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { attempt.current = null; save.reset(); }}>Revise rejected assignment</Button>}
          </div>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => setOpen(false)}>Close</Button>
            <Button type="submit" disabled={save.isPending || (!attempt.current && (netMinor === null || !reason.trim()))}>{save.isPending ? "Assigning…" : attempt.current ? "Retry assignment" : "Assign total net value"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
