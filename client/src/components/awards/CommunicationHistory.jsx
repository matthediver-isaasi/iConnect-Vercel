import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { appointmentMessageLabel, messageLabel, messageTime, useCommunicationHistory } from './useAwardCommunications';
import CommunicationDeliveryControl from './CommunicationDeliveryControl';

export default function CommunicationHistory(props) {
  return <HistoryWorkspace key={`${props.tenant.scopeKey}:${props.award.id}`} {...props} />;
}

function HistoryWorkspace({ tenant, award, choices, refreshVersion, disabled, onDirtyChange, onBusyChange }) {
  const [page, setPage] = useState(1), query = useCommunicationHistory(tenant, award.id, page);
  const [selected, setSelected] = useState(null), [controlDirty, setControlDirty] = useState(false), [controlBusy, setControlBusy] = useState(false);
  const callbacks = useRef({ onDirtyChange, onBusyChange }); callbacks.current = { onDirtyChange, onBusyChange };
  useEffect(() => () => { callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }, []);
  const ready = query.isSuccess && !query.isFetching && !query.isError && !!query.data;
  const data = ready ? query.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // Parent invalidation refreshes the active page without remounting or
  // discarding an open recovery reason when other communication writes finish.
  return <section className="space-y-4 border-t pt-5" data-refresh-version={refreshVersion}>
    <div className="flex justify-between items-start gap-3"><div><h3 className="font-semibold">Delivery history</h3><p className="awards-help">Queued/pending is not delivered. Processing and retries are shown as reported; only the server’s delivered state records delivery. Recovery actions require a separate server-capability read, not a guess from these status labels.</p></div><Button type="button" size="sm" variant="outline" disabled={query.isFetching || controlBusy || disabled} onClick={() => query.refetch()}>Refresh history</Button></div>
    {(query.isPending || query.isFetching) && <div role="status" aria-label="Loading delivery history"><Skeleton className="h-24" /></div>}
    {query.isError && <div role="alert"><p className="text-sm text-red-700">{query.error.message} No stale history rows are shown.</p><Button type="button" size="sm" variant="outline" disabled={query.isFetching || controlBusy || disabled} onClick={() => query.refetch()}>Retry this history page</Button></div>}
    {data && !data.deliveries.length && <div className="border border-dashed rounded-lg p-5 awards-help">No delivery records on this page. Configuring a category or authorising a release does not itself prove that a message was scheduled or delivered.</div>}
    {data && <ul className="divide-y">{data.deliveries.map(row => {
      const recipient = row.recipient || {}, app = choices.applications.find(item => item.id === recipient.applicationId), appointment = choices.appointments.find(item => item.id === recipient.appointmentId);
      const label = app ? `Application ${app.reference}` : recipient.applicationId ? `Application ID: ${recipient.applicationId}` : appointment ? appointmentMessageLabel(appointment) : recipient.appointmentId ? `Appointment ID: ${recipient.appointmentId}` : 'Recipient reference not supplied';
      return <li className="py-4 space-y-2 text-sm break-words" key={row.id}><div className="flex justify-between gap-3"><strong>{messageLabel(row.category)}</strong><span className="awards-status">{row.state === 'pending' ? 'Queued (pending)' : row.state}</span></div>
        <p>{label}</p>
        {recipient.issueId && <p className="awards-help">Certificate issue: {recipient.issueId}</p>}
        <p className="awards-help">Due: {messageTime(row.due_at, award.timezone)} · attempts: {row.attempts}</p>
        <p className="awards-help">Delivered at: {row.delivered_at ? messageTime(row.delivered_at, award.timezone) : 'Not recorded'}{row.last_error_code ? ` · Last error: ${row.last_error_code}` : ''}</p>
        <details><summary className="cursor-pointer awards-help">Delivery record ID</summary><p className="awards-help mt-1">{row.id}</p></details>
        <Button type="button" size="sm" variant="outline" disabled={disabled || controlBusy} aria-pressed={selected?.id === row.id} onClick={() => {
          if (controlDirty && !window.confirm('Discard only the current delivery-control action/reason and change the selected record? Any prior command is not undone. Ordinary settings, automation and manual scheduling drafts are preserved.')) return;
          setSelected(old => old?.id === row.id ? null : { id: row.id, category: row.category, label });
        }}>{selected?.id === row.id ? 'Close recovery controls' : 'Review server-authorised controls…'}</Button>
      </li>;
    })}</ul>}
    {data && <nav aria-label="Communication delivery pages" className="flex justify-between items-center gap-3"><Button type="button" size="sm" variant="outline" disabled={query.isFetching || controlBusy || disabled || page <= 1} onClick={() => setPage(value => value - 1)}>Previous</Button><span className="awards-help">Page {page} of {pages} · {data.total} records</span><Button type="button" size="sm" variant="outline" disabled={query.isFetching || controlBusy || disabled || page >= pages} onClick={() => setPage(value => value + 1)}>Next</Button></nav>}
    {selected && <CommunicationDeliveryControl tenant={tenant} award={award} delivery={selected} available={ready} disabled={disabled}
      onClose={() => setSelected(null)}
      onDirtyChange={value => { setControlDirty(value); callbacks.current.onDirtyChange(value); }}
      onBusyChange={value => { setControlBusy(value); callbacks.current.onBusyChange(value); }}
      onChanged={async () => {
        const result = await query.refetch(); tenant.assertCurrent();
        if (result.error || !result.data) throw result.error || new Error('The current delivery history page could not be refreshed.');
      }} />}
  </section>;
}
