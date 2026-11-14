import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import ModerationPanel from './ModerationPanel';
import { judgingRequest } from './judgingClient';

function usePanelList(scope, authority, roundId, page) {
  const client = useQueryClient();
  const key = ['judging-workspace', scope, 'panel-catalog', authority.scopeKey, roundId || 'rounds', page];
  return useQuery({
    queryKey: key, enabled: authority.ready,
    queryFn: async ({ signal }) => {
      try {
        const params = new URLSearchParams({ page: String(page) });
        if (roundId) params.set('roundId', roundId);
        const data = await judgingRequest(`/api/judging/panel?${params}`, { authority, signal });
        if (signal.aborted) throw new DOMException('Panel read cancelled.', 'AbortError');
        const rows = roundId ? data.applications : data.panels, total = roundId ? data.applicationTotal : data.total;
        if (!Array.isArray(rows) || !Number.isSafeInteger(total) || total < 0 || data.page !== page || data.pageSize !== 25
          || rows.length !== Math.min(25, Math.max(0, total - (page - 1) * 25))
          || new Set(rows.map(row => roundId ? row.id : row.round_id)).size !== rows.length
          || rows.some(row => roundId ? !row.id || typeof row.reference !== 'string' || !['undeclared', 'none', 'cleared', 'potential', 'confirmed'].includes(row.conflict)
            || !Number.isSafeInteger(row.conflict_version) || row.conflict_version < 0
            : !row.round_id || typeof row.round_name !== 'string' || typeof row.award_name !== 'string')) throw new Error('The panel catalog is incomplete. No partial or cached list is displayed.');
        return { rows, total, page: data.page, pageSize: data.pageSize };
      } catch (failure) {
        if (!signal.aborted) client.setQueryData(key, null);
        throw failure;
      }
    }, retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}

export default function JudgingPanels(props) {
  return <PanelWorkspace key={props.authority.scopeKey} {...props} />;
}

function PanelWorkspace({ scope, authority, onDirtyChange, onBusyChange, onConflictSaved }) {
  const [roundPage, setRoundPage] = useState(1), [applicationPage, setApplicationPage] = useState(1);
  const [round, setRound] = useState(null), [applicationId, setApplicationId] = useState('');
  const [state, setState] = useState(''), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
  const [moderationDirty, setModerationDirty] = useState(false), [moderationBusy, setModerationBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(false), callbacks = useRef({});
  callbacks.current = { onDirtyChange, onBusyChange, onConflictSaved };
  const dirty = !!(state || reason || blocked || moderationDirty);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy || moderationBusy); }, [busy, moderationBusy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const rounds = usePanelList(scope, authority, null, roundPage);
  // Keep the hooks unconditional, but don't request applications without a
  // round: that second query can harmlessly share the existing rounds read.
  const applications = usePanelList(scope, authority, round?.round_id || null, round ? applicationPage : roundPage);
  const list = round ? applications : rounds;
  const ready = authority.ready && list.isSuccess && !list.isFetching && !!list.data;
  const rows = ready ? list.data.rows : [];
  const current = round && ready ? rows.find(row => row.id === applicationId) : null;
  const panelClear = ['none', 'cleared'].includes(current?.conflict);
  const assignmentClear = !['potential', 'confirmed'].includes(current?.assignment_conflict);
  const evidenceEnabled = !!(current && panelClear && assignmentClear && !blocked && !busy);
  const pages = ready ? Math.max(1, Math.ceil(list.data.total / 25)) : 1;
  const page = round ? applicationPage : roundPage;
  const leave = () => !pending.current && !moderationBusy && (!dirty || window.confirm('Discard unsaved panel declaration or moderation inputs? This does not change any independent assessment worksheet.'));
  const clearDraft = () => { setApplicationId(''); setState(''); setReason(''); setBlocked(false); setError(''); setNotice(''); };
  const reload = async () => {
    if (pending.current || moderationBusy) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await list.refetch(); authority.assertCurrent();
      if (result.error || !result.data) throw result.error || new Error('Current panel catalog was not returned.');
      if (!alive.current) return;
      setBlocked(false); setNotice('Current panel and conflict metadata reloaded. Inputs were retained; review again before confirming.');
    } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <Card className="shadow-sm">
    <CardHeader className="border-b"><div className="flex flex-wrap justify-between gap-3"><div><p className="awards-kicker">Accepted round appointment</p><CardTitle className="text-xl mt-2">Confidential panel review</CardTitle></div><Button type="button" size="sm" variant="outline" disabled={busy || moderationBusy || list.isFetching || !authority.ready} onClick={reload}>Reload panel access</Button></div><p className="awards-help">Panel access comes from your accepted appointment and explicit round policy, not an administrative role. A judge explicitly granted panel discussion may review panel evidence independently of ordinary blind peer visibility. No capability is inferred from the role label.</p></CardHeader>
    <CardContent className="pt-5 space-y-5">
      {round && <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-semibold">{round.award_name} · {round.round_name}</h3><p className="awards-help">Appointment role: {round.role} · round {round.state}</p></div><Button type="button" variant="outline" disabled={busy || moderationBusy} onClick={() => { if (leave()) { clearDraft(); setRound(null); setApplicationPage(1); } }}>Back to panel rounds</Button></div>}
      {!authority.ready ? <p role="alert" className="awards-help">Current judging authority must be verified before panel access.</p>
        : list.isFetching || list.isPending ? <Skeleton className="h-32 w-full" />
          : list.isError ? <p role="alert" className="text-sm text-red-800">{list.error.message} Previously loaded panel evidence is not displayed. Independent worksheets are unchanged.</p>
            : ready && !rows.length ? <p className="awards-help rounded-lg border p-5">{round ? 'No candidate applications were returned on this panel page.' : 'No accepted, policy-authorised panel appointments were returned on this page.'}</p>
              : <ul className="divide-y rounded-lg border">{rows.map(row => <li key={round ? row.id : row.round_id} className="p-4 flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium text-sm">{round ? row.reference : `${row.award_name} · ${row.round_name}`}</h3><p className="awards-help mt-1">{round ? `Panel conflict: ${row.conflict} · declaration version ${row.conflict_version} · Assignment conflict: ${row.assignment_conflict ?? 'no assignment conflict record returned'}` : `${row.state} · appointment role ${row.role}`}</p></div><Button type="button" size="sm" variant="outline" disabled={busy || moderationBusy} onClick={() => {
                if ((round ? row.id === applicationId : false) || !leave()) return;
                clearDraft();
                if (round) setApplicationId(row.id); else { setRound(row); setApplicationPage(1); }
              }}>{round ? row.id === applicationId ? 'Selected application' : 'Review conflict & panel access' : 'Open appointed panel'}</Button></li>)}</ul>}
      {ready && <nav aria-label={round ? 'Panel application pages' : 'Appointed panel pages'} className="flex flex-wrap justify-between items-center gap-3"><Button type="button" variant="outline" size="sm" disabled={page <= 1 || busy || moderationBusy} onClick={() => { if (leave()) { clearDraft(); if (round) setApplicationPage(page - 1); else setRoundPage(page - 1); } }}>Previous</Button><span className="awards-help">Requested page {page} · {pages} current pages · {list.data.total} total</span><Button type="button" variant="outline" size="sm" disabled={page >= pages || page >= 10000 || busy || moderationBusy} onClick={() => { if (leave()) { clearDraft(); if (round) setApplicationPage(page + 1); else setRoundPage(page + 1); } }}>Next</Button></nav>}
      {current && <section className="rounded-lg border bg-[#edf4f4] p-4 space-y-4">
        <h3 className="font-semibold text-sm">Conflict declaration · {current.reference}</h3>
        <p className="awards-help">Panel: {current.conflict}. Judge assignment: {current.assignment_conflict ?? 'no record returned'}. Both review gates may apply. Clearing a panel declaration does not clear an existing judge-assignment conflict, restore an assignment or include a prior score.</p>
        {['potential', 'confirmed'].includes(current.conflict) ? <p role="alert" className="text-sm">Administrator review is required. You cannot self-clear a potential or confirmed panel conflict.</p> : <form className="space-y-3" onSubmit={async event => {
          event.preventDefault();
          if (pending.current || moderationBusy || blocked || !ready || !state || !reason.trim()) return;
          if (!window.confirm(`${state === 'none' ? 'Explicitly confirm that you have no panel conflict' : `Declare ${state} panel conflict`} for ${current.reference}? Potential/confirmed declarations may also recuse a matching judge assignment. Independent saved assessment history remains retained.`)) return;
          pending.current = true; setBusy(true); setError(''); setNotice('');
          try {
            const result = await judgingRequest('/api/judging/panel', { authority, body: { command: 'conflict', roundId: round.round_id, applicationId, version: current.conflict_version, state, reason: reason.trim() } });
            if (!result.id || result.state !== state || !Number.isSafeInteger(result.version) || result.version <= current.conflict_version) throw new Error('The declaration result was not confirmed. Reload before retrying.');
            authority.assertCurrent(); if (!alive.current) return;
            setState(''); setReason(''); setBlocked(true);
            callbacks.current.onConflictSaved();
            const resultList = await applications.refetch(); authority.assertCurrent();
            if (resultList.error || !resultList.data) throw new Error('Declaration saved, but current panel access could not be reloaded.');
            if (alive.current) { setBlocked(false); setNotice('Panel conflict declaration saved and current access refreshed. No independent worksheet draft was changed.'); }
          } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
          finally { pending.current = false; if (alive.current) setBusy(false); }
        }}>
          <label className="block text-sm">Explicit declaration<select className="awards-select mt-1" value={state} disabled={busy || moderationBusy || blocked} onChange={event => setState(event.target.value)}><option value="">Choose a declaration</option><option value="none">No panel conflict</option><option value="potential">Potential conflict</option><option value="confirmed">Confirmed conflict</option></select></label>
          <label className="block text-sm">Reason (required)<Textarea value={reason} maxLength={20000} required disabled={busy || moderationBusy} onChange={event => setReason(event.target.value)} /></label>
          <Button type="submit" disabled={busy || moderationBusy || blocked || !state || !reason.trim()}>Confirm panel declaration…</Button>
        </form>}
        {!panelClear && <p className="awards-help">Undeclared, potential or confirmed panel conflicts block evidence. No assessment evidence has been loaded by this declaration form.</p>}
        {!assignmentClear && <p role="alert" className="text-sm text-amber-900">The separate judge-assignment conflict also blocks evidence. Ask an administrator to review that record independently.</p>}
      </section>}
      {blocked && <p role="alert" className="text-sm text-amber-900">Reload current panel/conflict metadata before another command. The previous request may have committed; it will not be automatically retried.</p>}
      {(state || reason) && <Button type="button" size="sm" variant="outline" disabled={busy || moderationBusy || blocked} onClick={() => {
        if (window.confirm('Discard only your local declaration choice and reason? This does NOT clear or change a saved potential/confirmed conflict.')) { setState(''); setReason(''); }
      }}>Discard local declaration inputs only</Button>}
      {error && <p role="alert" className="text-sm text-red-800">{error} Failed declaration inputs remain local.</p>}
      {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
      {round && applicationId && <ModerationPanel roundId={round.round_id} applicationId={applicationId}
        judgingContext={{ scope, authority, enabled: evidenceEnabled }} onDirtyChange={setModerationDirty} onBusyChange={setModerationBusy} />}
    </CardContent>
  </Card>;
}
