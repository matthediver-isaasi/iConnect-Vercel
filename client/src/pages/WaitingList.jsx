import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Calendar, MapPin, Clock, Ticket } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useEventWaitingList, waitingListRequest } from "@/hooks/useEventWaitingList";
import { withdrawWaitingListEntries } from "@/lib/eventWaitingList.mjs";

export const waitingListDate = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date to be confirmed';
export function waitingListPrice(entry) {
  if (entry.advertised_price == null) return 'Price to be confirmed';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: entry.currency || 'GBP' }).format(Number(entry.advertised_price)); }
  catch { return `${entry.currency || ''} ${entry.advertised_price}`; }
}

export default function WaitingList({ hasBanner }) {
  const { memberInfo, isAccessReady, isFeatureExcluded } = useMemberAccess();
  const allowed = isAccessReady && !isFeatureExcluded('page_MyTickets');
  const query = useEventWaitingList(allowed ? memberInfo : null);
  const queryClient = useQueryClient();
  const [target, setTarget] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const entries = query.data?.entries || [];
  async function withdraw() {
    if (!target || pending || (target.scope === 'registration' && !target.entry.can_manage_registration)) return;
    setPending(true);
    setError('');
    try {
      await waitingListRequest('/api/member/event-waiting-list', { method: 'PATCH', body: JSON.stringify({ entry_id: target.entry.id, scope: target.scope }) }, memberInfo.tenant_id);
      queryClient.setQueriesData({ queryKey: ['event-waiting-list', memberInfo.tenant_id, memberInfo.id, false] }, old => old ? { ...old, entries: withdrawWaitingListEntries(old.entries, target) } : old);
      setTarget(null);
    } catch (err) { setError(err.message); }
    finally { setPending(false); }
  }
  if (isAccessReady && !allowed) return <div className="p-8" role="alert">You do not have permission to view My Waiting Lists.</div>;
  return <div className="min-h-[100dvh] p-4 md:p-8"><div className="max-w-7xl mx-auto space-y-6">
    {!hasBanner && <h1 className="text-3xl md:text-4xl font-bold text-slate-900">My Waiting Lists</h1>}
    <Card className="border-blue-200 bg-blue-50/50"><CardContent className="p-6 space-y-2">
      <h2 className="font-semibold text-lg text-slate-900">Your Event Waiting Lists</h2>
      <p className="text-sm text-slate-600">Here you'll find events you've expressed an interest in attending. Joining a waiting list means we'll keep you informed about news, updates and registration opportunities for that event. It doesn't guarantee a place, and there's nothing to pay until you make a confirmed booking.</p>
      <p className="text-sm text-slate-600">You can remove yourself from a waiting list at any time.</p>
    </CardContent></Card>
    {!isAccessReady || !memberInfo || query.isLoading ? <div aria-label="Loading waiting lists" className="space-y-4">{[0, 1, 2].map(i => <div key={i} className="h-40 rounded-lg border bg-slate-100 animate-pulse" />)}</div>
      : query.isError ? <Card><CardContent className="p-8 space-y-4"><p role="alert">{query.error.message}</p><Button onClick={() => query.refetch()}>Retry</Button></CardContent></Card>
      : !entries.length ? <Card><CardContent className="p-10 text-center space-y-4"><Clock className="h-12 w-12 mx-auto text-slate-400" /><h2 className="text-xl font-semibold">You're not currently on any event waiting lists.</h2><p className="text-slate-600">When you join a waiting list, the event will appear here so you can keep track of your interests.</p><Link className="inline-block text-blue-700 underline font-medium" to="/Events">Browse upcoming events</Link></CardContent></Card>
      : entries.map(entry => <Card key={entry.id} className="border-slate-200 shadow-sm">
        <CardHeader className="border-b border-slate-200"><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle className="text-xl">{entry.event_title}</CardTitle><Badge variant="secondary">Interest registered · not a booking</Badge></div></CardHeader>
        <CardContent className="pt-6 grid md:grid-cols-2 gap-6"><div className="space-y-3 text-sm text-slate-600">
          <p className="flex gap-2"><Calendar className="w-4 h-4 shrink-0" />{waitingListDate(entry.event_start_date)}{entry.event_end_date && ` – ${waitingListDate(entry.event_end_date)}`}</p>
          {entry.event_location && <p className="flex gap-2"><MapPin className="w-4 h-4 shrink-0" />{entry.event_location}</p>}
          <p className="flex gap-2"><Ticket className="w-4 h-4 shrink-0" />{entry.ticket_name} · {waitingListPrice(entry)} advertised</p>
          <p>Attendee: <strong>{entry.first_name} {entry.last_name}</strong><br />{entry.email}</p>
          <p className="text-xs">Added {waitingListDate(entry.created_at)}</p>
        </div><div className="flex flex-col items-start gap-3">
          <Link className="text-blue-700 underline text-sm font-medium" to={`/${entry.event_kind === 'complex' ? 'ComplexEventDetail' : 'EventDetails'}?id=${encodeURIComponent(entry.event_id)}`}>View event details</Link>
          <Button variant="outline" onClick={() => { setTarget({ entry, scope: 'attendee' }); setError(''); }}>Remove from waiting list</Button>
          {entry.can_manage_registration === true && <Button variant="ghost" onClick={() => { setTarget({ entry, scope: 'registration' }); setError(''); }}>Remove entire registration (all attendees)</Button>}
        </div></CardContent>
      </Card>)}
    <Dialog open={!!target} onOpenChange={open => { if (!open && !pending) setTarget(null); }}><DialogContent>
      <DialogHeader><DialogTitle>Remove from waiting list?</DialogTitle><DialogDescription>
        {target?.scope === 'registration' ? `This removes ALL attendees in this registration for ${target.entry.event_title}, including colleagues. They will no longer receive waiting list updates.`
          : `Are you sure you want to remove ${target?.entry.first_name || 'yourself'} ${target?.entry.last_name || ''} from the waiting list for ${target?.entry.event_title || ''}? This attendee will no longer receive waiting list updates. Other attendees will stay on the list.`}
      </DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <DialogFooter className="gap-2"><Button variant="outline" disabled={pending} onClick={() => setTarget(null)}>Keep me on the waiting list</Button><Button variant="destructive" disabled={pending} onClick={withdraw}>{pending ? 'Removing…' : target?.scope === 'registration' ? 'Remove all attendees' : 'Remove me'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div></div>;
}
