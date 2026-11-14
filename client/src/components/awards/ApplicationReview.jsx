import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminFetch } from '@/lib/adminFetch';
import { listAwardRounds } from '@/lib/awardsApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import ModerationPanel from './ModerationPanel';
import ApplicantAccessRevocation from './ApplicantAccessRevocation';
import './awards.css';

const STATES = ['pending', 'eligible', 'ineligible', 'withdrawn', 'disqualified'];

export default function ApplicationReview({ award, tenant, canManageApplications = false, canModerate = false, canApprove = false, onDirtyChange, onBusyChange }) {
  return <ApplicationWorkspace key={`${tenant.scopeKey}:${award.id}`} award={award} tenant={tenant}
    canManageApplications={canManageApplications} canModerate={canModerate} canApprove={canApprove} onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} />;
}

function ApplicationWorkspace({ award, tenant, canManageApplications, canModerate, canApprove, onDirtyChange, onBusyChange }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [state, setState] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [moderationApplication, setModerationApplication] = useState(null);
  const [roundId, setRoundId] = useState('');
  const [moderationDirty, setModerationDirty] = useState(false);
  const [moderationBusy, setModerationBusy] = useState(false);
  const [accessApplication, setAccessApplication] = useState(null);
  const [accessDirty, setAccessDirty] = useState(false);
  const [accessBusy, setAccessBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const decisionDirty = Boolean(selected && (reason || state !== selected.eligibility));
  const dirty = decisionDirty || moderationDirty || accessDirty;
  const allBusy = busy || moderationBusy || accessBusy;
  const dirtyRef = useRef(dirty);
  const busyRef = useRef(allBusy);
  dirtyRef.current = dirty;
  busyRef.current = allBusy;
  useEffect(() => { callbacks.current.onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange?.(allBusy); }, [allBusy]);
  useEffect(() => {
    mounted.current = true;
    const unload = event => { if (dirtyRef.current || busyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    const link = event => {
      if (!event.target.closest?.('a[href]')) return;
      if (busyRef.current || (dirtyRef.current && !window.confirm('Discard unsaved application decision, moderation or external-access inputs? Accepted server operations are not undone.'))) event.preventDefault();
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', link, true);
    return () => {
      mounted.current = false;
      window.removeEventListener('beforeunload', unload); document.removeEventListener('click', link, true);
      callbacks.current.onDirtyChange?.(false); callbacks.current.onBusyChange?.(false);
    };
  }, []);
  const scope = ['award-applications', tenant.scopeKey, award.id];
  const request = async (url, options = {}) => {
    tenant.assertCurrent();
    const response = await adminFetch(url, options, tenant.tenantId);
    const result = await response.json();
    tenant.assertCurrent();
    if (!response.ok) throw new Error(result.error || 'Unable to process application request.');
    return result;
  };
  const applicationsQuery = useQuery({
    queryKey: [...scope, page],
    queryFn: () => request(`/api/awards/applications?awardId=${encodeURIComponent(award.id)}&page=${page}`),
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const roundsQuery = useQuery({
    queryKey: ['awards-moderation-round-options', tenant.scopeKey, award.id],
    enabled: Boolean(moderationApplication) && (canModerate || canApprove),
    queryFn: async () => {
      const rounds = [];
      let nextPage = 1;
      while (true) {
        tenant.assertCurrent();
        const result = await listAwardRounds(award.id, nextPage);
        tenant.assertCurrent();
        rounds.push(...result.rounds);
        if (rounds.length >= result.total) return rounds;
        if (!result.rounds.length || !result.pageSize || nextPage >= 10000) throw new Error('The full round list could not be loaded. Please retry.');
        nextPage += 1;
      }
    },
    refetchOnWindowFocus: false,
  });
  const leaveModeration = () => !moderationBusy && (!moderationDirty || window.confirm('Discard unsaved moderation inputs?'));
  const leaveAccess = () => !accessBusy && (!accessDirty || window.confirm('Discard only the current external applicant grant revocation reason/confirmation? Any accepted revocation is not undone. No automatic retry occurs.'));
  const changePage = next => {
    if (allBusy || !leaveModeration() || !leaveAccess()) return;
    setAccessApplication(null); setAccessDirty(false);
    setModerationApplication(null); setRoundId(''); setModerationDirty(false); setPage(next);
  };
  const applicationsReady = applicationsQuery.isSuccess && !applicationsQuery.isFetching && !applicationsQuery.isError && !!applicationsQuery.data;
  const applications = applicationsQuery.data?.applications || [];
  const { total = 0, pageSize = 50 } = applicationsQuery.data || {};
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const close = () => {
    if (busy || (decisionDirty && !window.confirm('Discard the unsaved application decision?'))) return;
    setSelected(null); setReason(''); setState(''); setError('');
  };
  const save = async event => {
    event.preventDefault();
    if (pending.current || accessBusy || !selected || !reason.trim() || !STATES.includes(state) || state === selected.eligibility) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await request('/api/awards/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' },
        body: JSON.stringify({ applicationId: selected.id, version: selected.version, state, reason: reason.trim() }),
      });
      if (!result.application?.id) throw new Error('The server did not return the updated application. Reload the list before retrying.');
      queryClient.setQueriesData({ queryKey: scope }, old => old ? {
        ...old, applications: old.applications.map(application => application.id === result.application.id ? { ...application, ...result.application } : application),
      } : old);
      if (mounted.current) {
        setSelected(null); setReason(''); setState('');
        setNotice('Application state updated. The reason has been saved.');
      }
    } catch (failure) {
      if (mounted.current) setError(failure.message || 'Unable to save the application decision.');
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <Card className="mt-6 min-w-0 shadow-sm">
    <CardHeader className="border-b"><p className="awards-kicker mb-2">Application administration</p><CardTitle className="text-xl">Application status</CardTitle>
      <p className="awards-help">Review application references, duplicate flags and eligibility states. Every state change requires a recorded reason.</p>
    </CardHeader>
    <CardContent className="pt-5">
      <div className="flex items-center justify-between gap-3 mb-4"><span className="awards-help">{applicationsQuery.data ? `${total} applications` : 'Applications'}</span>
        <Button size="sm" variant="outline" disabled={allBusy || applicationsQuery.isFetching} onClick={() => applicationsQuery.refetch()}>Refresh list</Button></div>
      {applicationsQuery.isLoading ? <div aria-label="Loading applications" className="space-y-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
        : applicationsQuery.isError ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4"><h3 className="font-medium text-sm">Unable to load applications</h3><p className="text-sm text-red-800 mt-2">{applicationsQuery.error.message}</p><Button variant="outline" className="mt-3" onClick={() => applicationsQuery.refetch()}>Retry applications</Button></div>
          : applications.length ? <ul className="divide-y rounded-lg border">{applications.map(application => <li key={application.id} className="p-4">
            <div className="flex flex-wrap justify-between items-start gap-3">
              <div className="min-w-0"><h3 className="font-medium text-sm break-words">Application {application.reference || application.id}</h3>
                <div className="flex flex-wrap gap-2 items-center mt-2"><span className="awards-status">{application.eligibility}</span>
                  {application.duplicate_flag && <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">Duplicate flagged</span>}
                  <span className="text-xs text-slate-500">Version {application.version}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">{canManageApplications && <Button size="sm" variant="outline" disabled={allBusy} onClick={() => {
                setSelected(application); setState(application.eligibility); setReason(''); setError(''); setNotice('');
              }}>Change state<span className="sr-only"> for application {application.reference || application.id}</span></Button>}
                {canManageApplications && <Button type="button" size="sm" variant="outline" disabled={allBusy || !applicationsReady} aria-pressed={accessApplication?.id === application.id} onClick={() => {
                  if (!leaveAccess()) return;
                  setAccessApplication(old => old?.id === application.id ? null : { ...application });
                  setAccessDirty(false);
                }}>{accessApplication?.id === application.id ? 'Close applicant access' : 'External applicant access…'}<span className="sr-only"> for application {application.reference || application.id}</span></Button>}
                {(canModerate || canApprove) && <Button size="sm" variant="outline" disabled={allBusy} onClick={() => {
                  if (moderationApplication?.id === application.id || !leaveModeration()) return;
                  setModerationApplication(application); setRoundId(''); setModerationDirty(false);
                }}>Moderation<span className="sr-only"> for application {application.reference || application.id}</span></Button>}</div>
            </div>
            {application.eligibility_reason && <div className="mt-3 text-sm"><p className="text-xs font-medium text-slate-500 mb-1">Recorded reason</p><p className="whitespace-pre-wrap break-words">{application.eligibility_reason}</p></div>}
          </li>)}</ul> : <div className="rounded-lg border bg-slate-50 p-7"><h3 className="font-medium">No applications on this page</h3><p className="awards-help mt-1">Applications received for this competition will appear here.</p></div>}
      {applicationsQuery.data && <div className="flex justify-between items-center gap-2 mt-5">
        <Button size="sm" variant="outline" disabled={allBusy || page <= 1} onClick={() => changePage(page - 1)}>Previous</Button>
        <span className="text-xs text-slate-500">Page {page} of {pages}</span>
        <Button size="sm" variant="outline" disabled={allBusy || page >= pages} onClick={() => changePage(page + 1)}>Next</Button>
      </div>}
      {accessApplication && canManageApplications && <ApplicantAccessRevocation tenant={tenant} awardId={award.id} application={accessApplication}
        available={applicationsReady && canManageApplications} disabled={busy || moderationBusy}
        onDirtyChange={setAccessDirty} onBusyChange={setAccessBusy}
        onClose={() => { setAccessApplication(null); setAccessDirty(false); }} />}
      {moderationApplication && (canModerate || canApprove) && <section className="border-t mt-6 pt-5">
        <div className="flex flex-wrap justify-between items-start gap-3"><h3 className="font-semibold">Moderation · Application {moderationApplication.reference || moderationApplication.id}</h3><Button size="sm" variant="outline" disabled={moderationBusy} onClick={() => { if (leaveModeration()) { setModerationApplication(null); setRoundId(''); setModerationDirty(false); } }}>Close moderation</Button></div>
        {roundsQuery.isLoading ? <Skeleton className="h-10 w-full mt-4" /> : roundsQuery.isError ? <div role="alert" className="mt-4 text-sm text-red-800">{roundsQuery.error.message}<Button size="sm" variant="outline" className="ml-3" onClick={() => roundsQuery.refetch()}>Retry rounds</Button></div>
          : roundsQuery.data?.length ? <div className="awards-field mt-4"><Label htmlFor="moderation-round">Assessment round</Label><select id="moderation-round" className="awards-select" value={roundId} disabled={moderationBusy} onChange={event => { if (leaveModeration()) { setRoundId(event.target.value); setModerationDirty(false); } }}><option value="">Choose a round</option>{roundsQuery.data.map(round => <option key={round.id} value={round.id}>{round.name} · {round.state}</option>)}</select></div>
            : <p className="awards-help mt-4">No assessment rounds are available for this competition.</p>}
        {roundId && <ModerationPanel roundId={roundId} applicationId={moderationApplication.id} tenant={tenant} canModerate={canModerate} canApprove={canApprove} onDirtyChange={setModerationDirty} onBusyChange={setModerationBusy} />}
      </section>}
      {notice && <p role="status" className="text-sm text-emerald-800 mt-4">{notice}</p>}
      <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) close(); }}>
        <DialogContent className="awards-workspace"><DialogHeader><DialogTitle>Change application state</DialogTitle><DialogDescription>Application {selected?.reference || selected?.id}. This records a status decision and its reason; it does not publish results or send messages.</DialogDescription></DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <div className="awards-field"><Label htmlFor="application-state">New state</Label><select id="application-state" className="awards-select capitalize" value={state} disabled={busy} onChange={event => setState(event.target.value)}>{STATES.map(value => <option value={value} key={value}>{value}</option>)}</select></div>
            <div className="awards-field"><Label htmlFor="application-state-reason">Reason (required)</Label><Textarea id="application-state-reason" required maxLength={10000} rows={4} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></div>
            {error && <div role="alert" className="text-sm text-red-800"><p>{error}</p><p className="mt-1">Your reason is retained. If the application version changed, copy your reason, cancel and refresh the list before retrying.</p></div>}
            <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" disabled={busy || accessBusy || !reason.trim() || state === selected?.eligibility}>{busy ? 'Saving…' : 'Confirm state change'}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </CardContent>
  </Card>;
}
