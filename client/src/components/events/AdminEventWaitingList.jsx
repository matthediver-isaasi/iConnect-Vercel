import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useEventWaitingList } from "@/hooks/useEventWaitingList";
import { waitingListPrice, waitingListDate } from "@/pages/WaitingList";

export default function AdminEventWaitingList({ memberInfo, eventId, eventKind }) {
  const query = useEventWaitingList(memberInfo, { admin: true, eventId, eventKind });
  return <Card className="mt-6 border-slate-200" data-testid="admin-event-waiting-list">
    <CardHeader><CardTitle>Waiting list expressions of interest</CardTitle><p className="text-sm text-slate-600">Separate from confirmed attendees, capacity and revenue. Advertised prices are not payments.</p></CardHeader>
    <CardContent>{!eventId ? <p className="text-sm text-slate-500">Select a specific event and generate the report to view its waiting list.</p>
      : query.isLoading ? <div className="h-24 bg-slate-100 animate-pulse rounded" aria-label="Loading waiting entries" />
      : query.isError ? <div role="alert" className="space-y-3"><p>{query.error.message}</p><Button variant="outline" onClick={() => query.refetch()}>Retry waiting list</Button></div>
      : !query.data?.entries?.length ? <p className="text-sm text-slate-500">No active waiting list entries for this event.</p>
      : <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr className="border-b">{['Attendee', 'Email', 'Ticket', 'Advertised price', 'Added', 'Selected sessions'].map(label => <th key={label} className="py-3 pr-4">{label}</th>)}</tr></thead><tbody>{query.data.entries.map(entry => <tr key={entry.id} className="border-b"><td className="py-3 pr-4">{entry.first_name} {entry.last_name}</td><td className="pr-4">{entry.email}</td><td className="pr-4">{entry.ticket_name}</td><td className="pr-4">{waitingListPrice(entry)}</td><td className="pr-4">{waitingListDate(entry.created_at)}</td><td>{(entry.attendee_details?.sessions || []).map(session => session.title).join(', ') || '—'}</td></tr>)}</tbody></table></div>}
    </CardContent>
  </Card>;
}
