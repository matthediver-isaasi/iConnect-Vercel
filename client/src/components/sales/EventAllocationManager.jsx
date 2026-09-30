import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, CalendarDays, Loader2, Mail, RefreshCw, Ticket, UserPlus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { allocationPlacesAvailable, allocationRegistrationUrl, normalizeAllocationContext } from "@/lib/eventAllocation.mjs";
import { toast } from "sonner";

async function allocationRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || payload?.message || `Request failed (${response.status})`);
  return payload;
}

function Stat({ label, value, emphasis = false }) {
  return <div className={`rounded-lg border p-3 ${emphasis ? "border-blue-200 bg-blue-50" : "bg-white"}`}>
    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
    <p className={`mt-1 text-2xl font-bold ${emphasis ? "text-blue-700" : "text-slate-900"}`} data-testid={`allocation-${label.toLowerCase()}`}>{value}</p>
  </div>;
}

export function AllocationSummaryCard({ item }) {
  const allocation = normalizeAllocationContext(item);
  const available = allocationPlacesAvailable(allocation);
  return <Card>
    <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
      <div>
        <p className="font-semibold text-slate-900">{allocation.eventName}</p>
        <p className="text-sm text-slate-500">{allocation.ticketName} · {allocation.organizationName}</p>
      </div>
      <div className="flex items-center gap-3 text-sm"><span>{allocation.registered} registered</span><Badge variant={available ? "default" : "secondary"}>{available} remaining</Badge>
        <Button asChild size="sm" variant="outline"><Link to={`/sales/allocations/${allocation.id}`}>Manage</Link></Button>
      </div>
    </CardContent>
  </Card>;
}

export function OpportunityAllocations({ opportunityId }) {
  const query = useQuery({
    queryKey: ["sales-allocations", opportunityId],
    queryFn: () => allocationRequest("/api/sales/allocations"),
  });
  const items = (query.data?.items || []).filter((item) => {
    const sale = item.sales_commercial_sale || item.sale || {};
    return !opportunityId || item.opportunity_id === opportunityId || sale.opportunity_id === opportunityId;
  });
  if (query.isLoading) return <div className="grid h-32 place-items-center"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (query.error) return <Card className="border-rose-200"><CardContent className="p-5 text-rose-700">{query.error.message}</CardContent></Card>;
  if (!items.length) return <Card><CardContent className="p-10 text-center text-slate-500">No Event delegate allocations are linked to this opportunity.</CardContent></Card>;
  return <div className="space-y-3">{items.map((item) => <AllocationSummaryCard key={item.allocation_id || item.id} item={item} />)}</div>;
}

export default function EventAllocationManager() {
  const { allocationId } = useParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const detail = useQuery({
    queryKey: ["sales-allocation", allocationId],
    queryFn: () => allocationRequest(`/api/sales/allocations/${encodeURIComponent(allocationId)}`),
    enabled: Boolean(allocationId),
  });
  const allocation = useMemo(() => normalizeAllocationContext(detail.data), [detail.data]);
  const available = allocationPlacesAvailable(allocation);
  const createInvitation = async (sendEmail) => allocationRequest(`/api/sales/allocations/${encodeURIComponent(allocationId)}/invite`, {
      method: "POST", body: JSON.stringify({
        email: email.trim(), firstName: firstName.trim() || null, lastName: lastName.trim() || null,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        idempotencyKey: crypto.randomUUID(),
        sendEmail,
      }),
    });
  const registration = useMutation({
    mutationFn: () => createInvitation(false),
    onSuccess: (result) => {
      const url = result.registration_url || allocationRegistrationUrl(allocation, result.context_token || result.allocation_token || result.token);
      if (!url) throw new Error("The server did not return a registration handoff.");
      window.location.assign(url);
    },
    onError: (error) => toast.error(error.message),
  });
  const invite = useMutation({
    mutationFn: () => createInvitation(true),
    onSuccess: () => {
      toast.success("Delegate invitation sent");
      setEmail(""); setFirstName(""); setLastName("");
      qc.invalidateQueries({ queryKey: ["sales-allocation", allocationId] });
    },
    onError: (error) => toast.error(error.message),
  });

  if (detail.isLoading) return <div className="grid h-72 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-blue-600" /></div>;
  if (detail.error) return <Card className="border-rose-200"><CardContent className="p-6 text-rose-700"><AlertTriangle className="mr-2 inline h-4 w-4" />{detail.error.message}</CardContent></Card>;
  const invitations = allocation.invitations.length ? allocation.invitations : (detail.data?.delegate_invitations || []);
  return <div className="mx-auto max-w-5xl space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex gap-3"><Button asChild variant="outline" size="icon"><Link to="/sales/opportunities"><ArrowLeft className="h-4 w-4" /></Link></Button>
        <div><h1 className="text-2xl font-bold text-slate-950">Delegate allocation</h1><p className="text-slate-500">{allocation.organizationName}</p></div>
      </div>
      <Button variant="outline" onClick={() => detail.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
    </div>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><CalendarDays className="h-5 w-5 text-blue-600" />{allocation.eventName}</CardTitle></CardHeader>
      <CardContent className="flex flex-wrap gap-3 text-sm text-slate-600"><span className="flex items-center gap-1"><Ticket className="h-4 w-4" />{allocation.ticketName}</span><Badge variant="outline" className="capitalize">{allocation.status}</Badge></CardContent>
    </Card>
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5"><Stat label="Purchased" value={allocation.purchased} /><Stat label="Registered" value={allocation.registered} /><Stat label="Reserved" value={allocation.reserved} /><Stat label="Released" value={allocation.released} /><Stat label="Remaining" value={available} emphasis /></div>
    <div className="grid gap-5 lg:grid-cols-2">
      <Card><CardHeader><CardTitle className="text-lg">Register a delegate</CardTitle></CardHeader><CardContent className="space-y-3">
        <p className="text-sm text-slate-600">Continue into the normal Event registration flow. The Event, ticket and Organisation are fixed by this allocation.</p>
        <div><Label htmlFor="registration-email">Delegate email</Label><Input id="registration-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="delegate@example.com" /></div>
        <div className="grid grid-cols-2 gap-2"><Input aria-label="Registration first name" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" /><Input aria-label="Registration last name" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" /></div>
        <Button className="w-full" disabled={!available || !email.includes("@") || registration.isPending} onClick={() => registration.mutate()}>{registration.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}Register Delegate</Button>
        {!available && <p className="text-sm text-amber-700">There are no unreserved places remaining.</p>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-lg">Invite a delegate</CardTitle></CardHeader><CardContent className="space-y-3">
        <div><Label htmlFor="allocation-email">Email address</Label><Input id="allocation-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="delegate@example.com" /></div>
        <div className="grid grid-cols-2 gap-2"><Input aria-label="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" /><Input aria-label="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" /></div>
        <Button variant="outline" className="w-full" disabled={!available || !email.includes("@") || invite.isPending} onClick={() => invite.mutate()}>{invite.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}Send secure invitation</Button>
      </CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-lg"><Users className="h-5 w-5" />Delegates and invitations</CardTitle></CardHeader><CardContent>
      {!allocation.bookings.length && !invitations.length ? <p className="py-5 text-center text-sm text-slate-500">No delegates have registered or been invited yet.</p> :
        <div className="divide-y">{allocation.bookings.map((booking) => <div key={booking.id || booking.booking_id} className="flex justify-between py-3 text-sm"><span>{booking.delegate_name || booking.email || booking.booking_id}</span><Badge variant="secondary">Registered</Badge></div>)}
          {invitations.map((item) => <div key={item.id} className="flex justify-between py-3 text-sm"><span>{item.email || item.delegate_email}</span><Badge variant="outline" className="capitalize">{item.status || (item.claimed_at ? "registered" : item.released_at ? "released" : "reserved")}</Badge></div>)}</div>}
    </CardContent></Card>
  </div>;
}