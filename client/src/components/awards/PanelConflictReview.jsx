import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { appointmentLabel, roundAdminRequest } from './useRoundAdministration';

export default function PanelConflictReview({ round, tenant, applications, appointments, labels, choicesReady, disabled, onDirtyChange, onBusyChange, onUncertainChange, onChanged }) {
  const [page, setPage] = useState(1), [selected, setSelected] = useState(null);
  const [state, setState] = useState(''), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(false), callbacks = useRef({});
  callbacks.current = { onDirtyChange, onBusyChange, onUncertainChange, onChanged };
  const dirty = !!(selected || reason || blocked);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { callbacks.current.onUncertainChange(blocked); }, [blocked]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const query = useQuery({
    queryKey: ['award-panel-conflicts', tenant.scopeKey, round.id, page],
    queryFn: async ({ signal }) => {
      const data = await roundAdminRequest(tenant, `/api/awards/assignment-controls?roundId=${encodeURIComponent(round.id)}&scope=panel&page=${page}`, { signal });
      if (!Array.isArray(data.conflicts) || !Number.isSafeInteger(data.total) || data.total < 0 || data.page !== page || data.pageSize !== 50
        || data.conflicts.length !== Math.min(50, Math.max(0, data.total - (page - 1) * 50))
        || new Set(data.conflicts.map(row => row.id)).size !== data.conflicts.length
        || data.conflicts.some(row => !row.id || !row.appointment_id || !row.application_id || !Number.isSafeInteger(row.version) || row.version < 1 || !['none', 'potential', 'confirmed', 'cleared'].includes(row.state))) throw new Error('The panel-conflict page is incomplete. No partial page can be reviewed.');
      return data;
    }, retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const ready = query.isSuccess && !query.isFetching && !query.isError && choicesReady;
  const rows = ready ? query.data.conflicts : [], fresh = rows.find(row => row.id === selected?.id);
  const stale = !!selected && fresh?.version !== selected.version;
  const actionReady = state === 'cleared' ? !['none', 'cleared'].includes(selected?.state)
    : state === 'confirmed' ? selected?.state !== 'confirmed' : false;
  const reference = id => applications.find(row => row.id === id)?.reference || id;
  const reload = async () => {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await query.refetch(); tenant.assertCurrent();
      if (result.error || !result.data) throw result.error || new Error('Panel conflicts could not be reloaded.');
      await callbacks.current.onChanged();
      const row = result.data.conflicts.find(item => item.id === selected?.id);
      if (selected && !row) throw new Error('The selected conflict is no longer on this page. Your reason is retained; review the current catalog before another action.');
      if (alive.current) { if (row) setSelected(row); setBlocked(false); setNotice('Current versions loaded. Chosen review and reason were retained; confirm explicitly again.'); }
    } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="rounded-lg border p-4 space-y-4">
    <div className="flex flex-wrap justify-between gap-3"><div><h4 className="font-semibold">Panel conflict review</h4><p className="awards-help mt-2">Assign-capability administration, separate from panel appointment powers. A separate administrator must review their own panel conflict; the server checks linked identities.</p></div><Button type="button" size="sm" variant="outline" disabled={disabled || busy || query.isFetching} onClick={reload}>Reload panel conflicts (keep reason)</Button></div>
    <p className="text-sm rounded-lg border border-amber-200 bg-amber-50 p-3">Clearing a panel conflict does NOT clear a judge-assignment conflict, restore a recused assignment or include a prior score. Confirming a panel conflict may also recuse the matching judge assignment. Review those controls separately.</p>
    {query.isFetching ? <Skeleton className="h-24 w-full" /> : query.isError ? <p role="alert" className="text-sm text-red-800">{query.error.message}</p> : ready && !rows.length ? <p className="awards-help">No panel declarations were returned on this page. Undeclared applications do not have a declaration row yet.</p> : <ul className="divide-y">{rows.map(row => <li key={row.id} className="py-4 space-y-2"><h5 className="text-sm font-semibold">{reference(row.application_id)} · {appointmentLabel(appointments.find(item => item.id === row.appointment_id), labels)}</h5><p className="awards-help">{row.state} · version {row.version}</p><p className="text-sm whitespace-pre-wrap break-words">{row.reason}</p><Button type="button" size="sm" variant="outline" disabled={disabled || busy || blocked} onClick={() => {
      if (selected && !window.confirm('Discard the unsaved panel-conflict review and reason?')) return;
      setSelected(row); setState(''); setReason(''); setError('');
    }}>Review declaration</Button></li>)}</ul>}
    {query.isSuccess && <nav className="flex flex-wrap justify-between gap-3" aria-label="Panel conflict pages"><Button type="button" size="sm" variant="outline" disabled={page <= 1 || disabled || busy || query.isFetching || !!selected || blocked} onClick={() => setPage(value => value - 1)}>Previous conflicts</Button><span className="awards-help">Requested page {page} · {query.data.total} total · up to 50 per page</span><Button type="button" size="sm" variant="outline" disabled={page * 50 >= query.data.total || page >= 10000 || disabled || busy || query.isFetching || !!selected || blocked} onClick={() => setPage(value => value + 1)}>Next conflicts</Button></nav>}
    {selected && <form className="border-t pt-4 space-y-3" onSubmit={async event => {
      event.preventDefault();
      if (pending.current || disabled || blocked || !ready || stale || !actionReady || !reason.trim()) return;
      if (!window.confirm(`Record panel conflict as ${state} for ${reference(selected.application_id)}? Clearing does not clear judge-assignment conflicts or restore/include scores. Confirming may recuse the matching assignment.`)) return;
      pending.current = true; setBusy(true); setError(''); setNotice('');
      try {
        const result = await roundAdminRequest(tenant, '/api/awards/assignment-controls', { body: { command: 'panel_conflict', id: selected.id, version: selected.version, state, reason: reason.trim() } });
        if (result.id !== selected.id || result.state !== state || !Number.isSafeInteger(result.version) || result.version <= selected.version) throw new Error('The server did not confirm this panel-conflict review. Reconcile before retrying.');
        if (!alive.current) return;
        setSelected(null); setReason(''); setState(''); setBlocked(true);
        setNotice('The server confirmed the panel-conflict review. Refreshing current panel and judge-assignment records.');
        await callbacks.current.onChanged();
        const resultList = await query.refetch(); tenant.assertCurrent();
        if (resultList.error) throw new Error('Panel conflict review saved, but the latest catalog could not be reloaded.');
        if (alive.current) { setBlocked(false); setNotice('Panel conflict review confirmed. Judge-assignment conflicts remain a separate review gate.'); }
      } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
      finally { pending.current = false; if (alive.current) setBusy(false); }
    }}>
      <h5 className="font-semibold text-sm">{reference(selected.application_id)} · selected version {selected.version}</h5>
      <label className="block text-sm">Review decision<select className="awards-select mt-1" value={state} disabled={disabled || busy} onChange={event => setState(event.target.value)}><option value="">Choose explicitly</option><option value="cleared" disabled={['none', 'cleared'].includes(selected.state)}>Clear panel conflict only</option><option value="confirmed" disabled={selected.state === 'confirmed'}>Confirm panel conflict</option></select></label>
      <label className="block text-sm">Review reason (required)<Textarea required maxLength={20000} value={reason} disabled={disabled || busy} onChange={event => setReason(event.target.value)} /></label>
      {stale && <p role="alert" className="awards-help">The selected version is stale or not currently verified. Reload while keeping this reason.</p>}
      {state && !actionReady && <p className="awards-help">The retained review is already satisfied by the current declaration. It will not be repeated automatically.</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled || busy || blocked || !ready || stale || !actionReady || !reason.trim()}>Confirm panel-conflict review…</Button><Button type="button" variant="outline" disabled={busy || blocked} onClick={() => { if (!reason || window.confirm('Discard the unsaved panel review reason?')) { setSelected(null); setState(''); setReason(''); } }}>Cancel review</Button></div>
    </form>}
    {blocked && <p role="alert" className="text-sm text-amber-900">Reconcile current conflict and assignment versions before another action. No failed or ambiguous request is automatically retried.</p>}
    {error && <p role="alert" className="text-sm text-red-800">{error} {notice ? 'Review the confirmation/refresh status above before issuing any further command.' : 'Unconfirmed selections and reasons remain here.'}</p>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
  </section>;
}
