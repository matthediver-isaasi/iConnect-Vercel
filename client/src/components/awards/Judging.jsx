import React, { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardCheck, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { usePopupUnsavedChanges } from '@/hooks/usePopupUnsavedChanges';
import { useMemberAccess } from '@/hooks/useMemberAccess';
import JudgingApplication from './JudgingApplication';
import JudgingAssessment from './JudgingAssessment';
import JudgingPeers from './JudgingPeers';
import JudgingPanels from './JudgingPanels';
import JudgeConflictDeclaration from './JudgeConflictDeclaration';
import JudgeAssignmentDecline, { canDeclineAssignment } from './JudgeAssignmentDecline';
import { useJudgingDownloadAuthority } from './useJudgingDownloadAuthority';
import { assignmentRestriction, clearJudgingCsrf, deadlineText, judgingRequest, storeJudgingCsrf } from './judgingClient';
import './awards.css';

// Called synchronously before the judging dashboard can mount/start a fetch.
// Memory only; cache handles React StrictMode's repeated initialisation.
// Do not strip unrelated pages' hashes when this module is eagerly imported.
function captureInvitation() {
  if (typeof window === 'undefined' || !window.location.hash) return { token: null };
  const fragment = window.location.hash.slice(1);
  try {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  } catch {
    return { token: null, error: 'The invitation token could not be removed from the address bar. Close this page and reopen your invitation in a supported browser.' };
  }
  try { return { token: fragment.startsWith('token=') ? new URLSearchParams(fragment).get('token') : decodeURIComponent(fragment) }; }
  catch { return { token: null, error: 'The invitation link could not be read. Request a new invitation.' }; }
}
let capturedInvitation = null;
function initialInvitation() {
  if (!capturedInvitation || (typeof window !== 'undefined' && window.location.hash)) capturedInvitation = captureInvitation();
  return capturedInvitation;
}

export default function Judging() {
  const [invitation, setInvitation] = useState(initialInvitation);
  const [responding, setResponding] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [terminal, setTerminal] = useState(false);
  const [expiry, setExpiry] = useState(null);
  const pending = useRef(false);
  const respond = async accept => {
    if (pending.current || !invitation.token || terminal) return;
    pending.current = true; setResponding(true); setError('');
    try {
      const result = await judgingRequest('/api/judging/session', { body: { token: invitation.token, accept } });
      if (typeof result.accepted !== 'boolean' || result.accepted !== accept) throw new Error('The server did not confirm your invitation response.');
      // The one-use credential is no longer retriable after a confirmed response.
      capturedInvitation = { token: null }; setTerminal(true); setInvitation({ token: null, closed: true });
      if (result.accepted) {
        storeJudgingCsrf(result.csrfToken);
        setExpiry(result.expiresAt); setInvitation({ token: null });
        setMessage('Invitation accepted. Your restricted judging session is active.');
      } else { setMessage('Invitation declined. No judging session was started.'); }
    } catch (failure) { setError(failure.message); }
    finally { pending.current = false; setResponding(false); }
  };
  const gated = invitation.token || invitation.error || invitation.closed;
  return <div className="awards-workspace min-h-[100dvh] p-4 md:p-8">
    <div className="max-w-7xl mx-auto space-y-6">
      <header><p className="awards-kicker mb-2">Confidential awards assessment</p><h1 className="text-3xl font-bold tracking-tight">Judging workspace</h1><p className="text-sm text-slate-600 mt-2">Review your assigned application versions and record your own assessment.</p></header>
      <div className="awards-intro px-5 py-4 flex items-start gap-3"><ShieldCheck className="h-5 w-5 mt-0.5 shrink-0" /><div><h2 className="font-semibold text-sm">Restricted to your assignments</h2><p className="awards-help mt-1">Only authorised review fields, your own assessment and peer responses allowed by the server’s visibility policy are shown. Save a draft before leaving; submission locks your responses.</p></div></div>
      {message && <p role="status" className="text-sm text-emerald-800">{message}{expiry ? ` Session expiry: ${deadlineText(expiry)}.` : ''}</p>}
      {gated ? <Card className="max-w-2xl shadow-sm"><CardHeader><CardTitle className="text-xl">Judging invitation</CardTitle><p className="awards-help">Accept to start a restricted judging session, or decline this invitation. Your response is recorded only after server confirmation.</p></CardHeader><CardContent>
        {(invitation.error || error) && <p role="alert" className="text-sm text-red-800 rounded-lg border border-red-200 bg-red-50 p-4 mb-5">{invitation.error || error}</p>}
        {invitation.token && !terminal && <div className="flex flex-wrap gap-3"><Button disabled={responding} onClick={() => respond(true)}>{responding ? 'Recording response…' : 'Accept invitation'}</Button><Button variant="outline" disabled={responding} onClick={() => { if (window.confirm('Decline this judging invitation?')) respond(false); }}>Decline invitation</Button></div>}
      </CardContent></Card> : <JudgingDashboard onRestrictedSignOut={() => { setMessage('Restricted judging session ended. Your normal member login has not been changed.'); setExpiry(null); }} />}
    </div>
  </div>;
}

function RequestError({ error, retry }) {
  return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-5">
    <h2 className="font-semibold text-base">{error.status === 401 ? 'Sign in or use a judging invitation' : error.status === 403 || error.status === 404 ? 'This judging record is unavailable' : 'Unable to load judging'}</h2>
    <p className="text-sm text-red-800 mt-2">{error.status === 401 ? 'Use your normal member sign-in, then retry here. External judges must open a current invitation link. No assessment access has been granted by this page.' : error.message}</p>
    <Button variant="outline" className="mt-4" onClick={retry}>Try again</Button>
  </div>;
}

function JudgingDashboard({ onRestrictedSignOut }) {
  const queryClient = useQueryClient();
  const { memberInfo, authResolved } = useMemberAccess();
  const [scope] = useState(() => crypto.randomUUID());
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [panelDirty, setPanelDirty] = useState(false);
  const [panelBusy, setPanelBusy] = useState(false);
  const [invitationBusy, setInvitationBusy] = useState(false);
  const [conflictDirty, setConflictDirty] = useState(false);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [declining, setDeclining] = useState(null);
  const [declineBusy, setDeclineBusy] = useState(false);
  const declineDirty = !!declining;
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const [cleanupError, setCleanupError] = useState('');
  const signOutPending = useRef(false);
  const invitationPending = useRef(false);
  const navigationGuard = usePopupUnsavedChanges({ dirty: dirty || busy || conflictDirty || conflictBusy || panelDirty || panelBusy || declineDirty || declineBusy || signingOut });
  // The HttpOnly cookie is verified by the server. A stored CSRF value alone
  // does not prove a restricted session, and member identity takes precedence.
  const restrictedSession = useQuery({
    queryKey: ['judging-workspace', scope, 'restricted-session'],
    queryFn: ({ signal }) => judgingRequest('/api/judging/session', { signal }),
    enabled: authResolved && !memberInfo && !signedOut,
    retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const restricted = authResolved && !memberInfo && restrictedSession.isSuccess && restrictedSession.data?.authenticated === true;
  const downloadAuthority = useJudgingDownloadAuthority({
    scope, memberInfo, authResolved, restrictedSession, restricted, signedOut, signingOut,
    isSigningOut: () => signOutPending.current,
  });
  const dashboardKey = ['judging-workspace', scope, 'dashboard', page];
  const dashboard = useQuery({
    queryKey: dashboardKey, queryFn: ({ signal }) => judgingRequest(`/api/judging?page=${page}`, { signal }),
    enabled: !signedOut,
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, gcTime: 0,
  });
  const leave = () => {
    if (busy || conflictBusy || panelBusy || declineBusy || signingOut) return false;
    if ((dirty || conflictDirty || panelDirty || declineDirty) && !window.confirm('Discard unsaved assessment, conflict declaration, assignment-decline or confidential panel inputs?')) return false;
    if (declineDirty) setDeclining(null);
    return true;
  };
  const signOut = async () => {
    if (signOutPending.current || !restricted || busy || conflictBusy || panelBusy || panelDirty || declineDirty || declineBusy || invitationBusy || invitationPending.current) return;
    if (!window.confirm(`End this restricted judging session? Server-saved drafts are retained.${dirty || conflictDirty ? ' Unsaved assessment responses or conflict declarations will be discarded only after confirmed sign-out.' : ''} Your normal member login will not be signed out.`)) return;
    signOutPending.current = true; setSigningOut(true); setSignOutError('');
    let confirmed = false;
    try {
      const result = await judgingRequest('/api/judging/session', { method: 'DELETE', body: {} });
      if (result.signedOut !== true) throw new Error('The server did not confirm restricted-session revocation. Access context has not been cleared.');
      confirmed = true;
      // No storage or query cleanup occurs before the confirmed server revoke.
      try { clearJudgingCsrf(); } catch (failure) { setCleanupError(failure.message); }
      setSignedOut(true); setSelected(null); setDirty(false); setConflictDirty(false); setError(null); setNotice('');
      onRestrictedSignOut();
      try { await queryClient.cancelQueries({ queryKey: ['judging-workspace', scope] }); }
      finally { queryClient.removeQueries({ queryKey: ['judging-workspace', scope] }); }
    } catch (failure) {
      if (confirmed) setCleanupError(`The server ended this restricted session, but local judging cleanup could not finish: ${failure.message}. Close this tab.`);
      else setSignOutError(`${failure.message} Stored verification, assessment inputs and judging queries have not been cleared.`);
    } finally { signOutPending.current = false; setSigningOut(false); }
  };
  const refresh = () => {
    if (!leave()) return;
    setSelected(null); setDirty(false); setNotice(''); dashboard.refetch();
  };
  const respond = async (invitation, accept) => {
    if (invitationPending.current || !leave() || (!accept && !window.confirm('Decline this judging invitation?'))) return;
    invitationPending.current = true; setInvitationBusy(true); setError(null); setNotice('');
    try {
      const result = await judgingRequest('/api/judging', { body: { appointmentId: invitation.id, version: invitation.version, accept } });
      if (result.id !== invitation.id || result.state !== (accept ? 'accepted' : 'declined')) throw new Error('The server did not confirm the invitation response. Refresh before retrying.');
      setSelected(null); setDirty(false);
      queryClient.setQueryData(dashboardKey, old => old ? { ...old, invitations: old.invitations.filter(item => item.id !== invitation.id) } : old);
      setNotice(accept ? 'Invitation accepted.' : 'Invitation declined.');
      dashboard.refetch();
    } catch (failure) { setError(failure); }
    finally { invitationPending.current = false; setInvitationBusy(false); }
  };
  const assignments = dashboard.data?.assignments || [];
  const invitations = dashboard.data?.invitations || [];
  const { total = 0, pageSize = 25 } = dashboard.data || {};
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const saved = result => {
    const update = assignment => assignment.id === selected.id ? { ...assignment, assessmentState: result.state, assessmentRevision: result.revision } : assignment;
    setSelected(old => update(old));
    queryClient.setQueriesData({ queryKey: ['judging-workspace', scope, 'dashboard'] }, old => old ? { ...old, assignments: old.assignments.map(update) } : old);
    queryClient.setQueryData(['judging-workspace', scope, 'assessment', selected.id], old => old ? { ...old, assessment: result } : old);
  };
  return <div className="space-y-6">
    {signedOut ? <Card><CardHeader><CardTitle>Restricted judging session ended</CardTitle></CardHeader><CardContent><p className="awards-help">The server confirmed revocation. Server-saved assessments remain available to authorised judges. Your normal member login was not signed out.</p>{cleanupError && <p role="alert" className="text-sm text-amber-800 mt-3">{cleanupError}</p>}</CardContent></Card> : <>
    {restricted && <div className="awards-intro p-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-sm">Restricted invitation session</h2><p className="awards-help">Sign-out ends this judging session only. Server-saved drafts are retained. Finish or explicitly discard panel and assignment-decline inputs before signing out.</p></div><Button type="button" variant="outline" disabled={signingOut || busy || conflictBusy || panelBusy || panelDirty || declineDirty || declineBusy || invitationBusy} onClick={signOut}>{signingOut ? 'Confirming sign-out…' : 'Sign out of judging'}</Button></div>}
    {authResolved && !memberInfo && restrictedSession.isLoading && <Skeleton className="h-12 w-full" aria-label="Checking restricted judging session" />}
    {authResolved && !memberInfo && restrictedSession.isError && ![401, 403].includes(restrictedSession.error.status) && <div role="alert" className="text-sm text-red-800">Restricted-session controls could not be verified: {restrictedSession.error.message}<Button type="button" size="sm" variant="outline" className="ml-3" onClick={() => restrictedSession.refetch()}>Retry session verification</Button></div>}
    {signOutError && <p role="alert" className="text-sm text-red-800">{signOutError}</p>}
    <fieldset disabled={signingOut || panelBusy || declineDirty || declineBusy} className="min-w-0 space-y-6">
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {error && <RequestError error={error} retry={() => { setError(null); refresh(); }} />}
    {selected ? <>
      <div className="flex flex-wrap justify-between items-center gap-3"><Button variant="outline" disabled={busy} onClick={() => { if (leave()) { setSelected(null); setDirty(false); } }}><ArrowLeft className="h-4 w-4 mr-2" />All assignments</Button>
        <Button variant="outline" disabled={busy} onClick={() => {
          if (!leave()) return;
          queryClient.removeQueries({ queryKey: ['judging-workspace', scope, 'assessment', selected.id], exact: true });
          setDirty(false); setSelected(null); dashboard.refetch();
        }}>Reload assignment list</Button></div>
      <div><p className="awards-kicker">{selected.awardName}</p><h2 className="text-xl font-semibold mt-2">{selected.roundName} · {selected.applicationReference}</h2></div>
      {canDeclineAssignment(selected) && <p className="awards-help">To decline this unsubmitted assignment, return to All assignments first. Save your draft or explicitly discard unsaved worksheet changes through the existing navigation guard; server-saved drafts remain stored.</p>}
      <AssignmentReview key={selected.id} summary={selected} scope={scope} authority={downloadAuthority} onDirtyChange={setDirty} onBusyChange={setBusy} onSaved={saved} />
    </> : <>
      <JudgingPanels scope={scope} authority={downloadAuthority} onDirtyChange={setPanelDirty} onBusyChange={setPanelBusy}
        onConflictSaved={() => { dashboard.refetch(); }} />
      {invitations.length > 0 && <section aria-labelledby="judging-invitations"><h2 id="judging-invitations" className="text-lg font-semibold mb-3">Invitations awaiting your response</h2>
        <div className="space-y-3">{invitations.map(invitation => <Card key={invitation.id} className="shadow-sm"><CardContent className="p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0"><p className="awards-kicker mb-1">{invitation.awardName}</p><h3 className="font-semibold break-words">{invitation.roundName}</h3></div>
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={invitationBusy} onClick={() => respond(invitation, false)}>Decline</Button><Button size="sm" disabled={invitationBusy} onClick={() => respond(invitation, true)}>Accept</Button></div>
        </CardContent></Card>)}</div>
      </section>}
      <Card className="shadow-sm"><CardHeader className="border-b"><div className="flex justify-between items-center gap-3"><div><CardTitle className="text-xl">Your assignments</CardTitle><p className="awards-help mt-2">{dashboard.data ? `${total} assigned applications` : 'Assigned applications'}</p></div><Button variant="outline" size="sm" disabled={dashboard.isFetching || invitationBusy} onClick={refresh}>Refresh</Button></div></CardHeader>
        <CardContent className="pt-5">
          {dashboard.isLoading ? <div aria-label="Loading judging assignments" className="space-y-4">{[1, 2, 3].map(index => <Skeleton key={index} className="h-24 w-full" />)}</div>
            : dashboard.isError ? <RequestError error={dashboard.error} retry={() => dashboard.refetch()} />
              : assignments.length ? <ul className="divide-y">{assignments.map(assignment => {
                const restriction = assignmentRestriction(assignment);
                return <li key={assignment.id} className="py-5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap justify-between items-start gap-4">
                    <div className="min-w-0 flex-1"><p className="awards-kicker break-words">{assignment.awardName}</p><h3 className="font-semibold mt-1 break-words">{assignment.applicationReference} · {assignment.roundName}</h3>
                      <div className="flex flex-wrap gap-2 mt-3"><span className="awards-status">{assignment.assessmentState || 'Not started'}</span><span className="awards-status">{assignment.roundState}</span>{assignment.conflict !== 'none' && <span className="awards-status">Conflict: {assignment.conflict}</span>}</div>
                      <p className="awards-help mt-2">Deadline: {deadlineText(assignment.deadline)}</p>
                      {assignment.state === 'assigned' && <JudgeConflictDeclaration key={`${assignment.id}:${assignment.version}`} assignment={assignment} disabled={invitationBusy || conflictBusy}
                        onDirtyChange={setConflictDirty} onBusyChange={setConflictBusy} onSaved={result => {
                          queryClient.setQueriesData({ queryKey: ['judging-workspace', scope, 'dashboard'] }, old => old ? {
                            ...old, assignments: old.assignments.map(item => item.id === result.assignment_id ? { ...item, version: result.version, conflict: result.conflict, state: result.state } : item),
                          } : old);
                          queryClient.removeQueries({ queryKey: ['judging-workspace', scope, 'assessment', assignment.id], exact: true });
                          setNotice('Conflict declaration saved. Refreshing your assignments.');
                          dashboard.refetch();
                        }} />}
                    </div>
                    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={invitationBusy || conflictBusy} onClick={() => { if (leave()) { setSelected(assignment); setDirty(false); setError(null); } }}>{restriction ? 'View status' : assignment.assessmentState === 'submitted' ? 'View assessment' : 'Review application'}</Button>
                      {canDeclineAssignment(assignment) && <Button type="button" variant="outline" disabled={!downloadAuthority.ready || invitationBusy || conflictBusy || panelBusy || panelDirty || conflictDirty || busy || dirty || declineBusy} onClick={() => {
                        if (!downloadAuthority.ready || invitationBusy || conflictBusy || panelBusy || panelDirty || conflictDirty || busy || dirty || declineBusy) return;
                        setDeclining(assignment);
                      }}>Decline assignment…</Button>}
                    </div>
                  </div>
                </li>;
              })}</ul> : <div className="py-10 text-center"><ClipboardCheck className="h-9 w-9 mx-auto text-slate-400 mb-4" /><h3 className="font-semibold">No assignments on this page</h3><p className="awards-help max-w-md mx-auto mt-2">Accepted invitations and assigned applications appear here when they are available to your judging identity.</p></div>}
          {dashboard.data && <div className="flex justify-between items-center gap-3 border-t pt-5 mt-5"><Button size="sm" variant="outline" disabled={page <= 1 || invitationBusy} onClick={() => { if (leave()) setPage(value => value - 1); }}>Previous</Button><span className="text-xs text-slate-500">Page {page} of {pages}</span><Button size="sm" variant="outline" disabled={page >= pages || invitationBusy} onClick={() => { if (leave()) setPage(value => value + 1); }}>Next</Button></div>}
        </CardContent>
      </Card>
    </>}
    </fieldset>
    </>}
    <Dialog open={Boolean(navigationGuard.pending)} onOpenChange={open => { if (!open) navigationGuard.stay(); }}>
      <DialogContent className="awards-workspace"><DialogHeader><DialogTitle>{busy || conflictBusy || panelBusy || declineBusy || signingOut ? 'Judging request in progress' : 'Leave this judging workspace?'}</DialogTitle>
        <DialogDescription>{busy || conflictBusy || panelBusy || declineBusy || signingOut ? 'Wait for the current request before leaving.' : 'Unsaved assessment responses, conflict declarations, assignment-decline or panel inputs will be discarded. Stay here to save before leaving.'}</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={navigationGuard.stay}>Stay here</Button><Button disabled={busy || conflictBusy || panelBusy || declineBusy || signingOut} onClick={navigationGuard.discard}>Discard and leave</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {declining && <JudgeAssignmentDecline key={`${downloadAuthority.scopeKey}:${declining.id}`} assignment={declining} authority={downloadAuthority}
      onClose={() => setDeclining(null)} onBusyChange={setDeclineBusy}
      onConfirmed={result => {
        queryClient.setQueriesData({ queryKey: ['judging-workspace', scope, 'dashboard'] }, old => old ? { ...old, assignments: old.assignments.map(row => row.id === result.id ? { ...row, state: result.state, version: result.version } : row) } : old);
        setNotice('Assignment decline confirmed. Saved drafts remain stored. No automatic replacement or score deletion was performed.');
      }}
      onRefresh={async () => {
        const result = await dashboard.refetch(); downloadAuthority.assertCurrent();
        if (result.error || !result.data) throw result.error || new Error('Your current assignment dashboard could not be reloaded.');
      }} />}
  </div>;
}

function AssignmentReview({ summary, scope, authority, onDirtyChange, onBusyChange, onSaved }) {
  const restriction = assignmentRestriction(summary);
  const detail = useQuery({
    queryKey: ['judging-workspace', scope, 'assessment', summary.id],
    enabled: !restriction,
    queryFn: ({ signal }) => judgingRequest(`/api/judging/assessment?assignmentId=${encodeURIComponent(summary.id)}`, { signal }),
    retry: false, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  if (restriction) return <Card><CardContent className="p-6"><h3 className="font-semibold">Read-only assignment status</h3><p className="awards-help mt-2">{restriction}</p></CardContent></Card>;
  if (detail.isLoading) return <div className="grid md:grid-cols-2 gap-6" aria-label="Loading application and assessment"><Skeleton className="h-96 w-full" /><Skeleton className="h-96 w-full" /></div>;
  if (detail.error) return <RequestError error={detail.error} retry={() => detail.refetch()} />;
  if (!detail.data?.assignment || detail.data.assignment.id !== summary.id || !detail.data?.application || !detail.data?.criteria) return <RequestError error={new Error('The assigned application or criteria could not be loaded.')} retry={() => detail.refetch()} />;
  return <div className="space-y-6"><div className="grid md:grid-cols-2 gap-6 items-start">
    <JudgingApplication application={detail.data.application} assignmentId={detail.data.assignment.id} authority={authority} />
    <JudgingAssessment data={detail.data} summary={summary} onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} onSaved={onSaved} />
  </div><JudgingPeers scope={scope} authority={authority} assignment={detail.data.assignment} assessment={detail.data.assessment} criteria={detail.data.criteria.definition?.criteria} /></div>;
}
