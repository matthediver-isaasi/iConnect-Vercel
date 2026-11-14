import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { calculateAssessment, formatScore, validateCriteria } from '../../../../api/_lib/assessment/scoring.js';
import { adminFetch } from '@/lib/adminFetch';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ResponseCriterion } from './JudgingAssessment';
import { judgingRequest, judgingPanelAttachmentRequest } from './judgingClient';
import ImmutableEvidence from './ImmutableEvidence';
import AdminModerationEvidence from './AdminModerationEvidence';
import AssessmentHistory from './AssessmentHistory';
import './awards.css';

function scoreText(score) {
  if (!score) return 'Not available';
  try { return `${formatScore(score)} / 100`; } catch { return 'Score unavailable'; }
}
function plainValue(value) {
  if (value === null || value === undefined || value === '') return 'No response recorded';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.every(item => ['string', 'number'].includes(typeof item))) return value.join(', ');
  return 'This response cannot be displayed';
}

export default function ModerationPanel(props) {
  return <ModerationWorkspace key={`${props.judgingContext?.authority.scopeKey || props.tenant?.scopeKey}:${props.roundId}:${props.applicationId}`} {...props} />;
}

function ModerationWorkspace({ roundId, applicationId, tenant, canModerate, canApprove, judgingContext, onDirtyChange, onBusyChange }) {
  const queryClient = useQueryClient();
  const judgingLive = useRef(judgingContext);
  judgingLive.current = judgingContext;
  const readReady = judgingContext ? !!judgingContext.authority.ready && !!judgingContext.enabled : Boolean(canModerate || canApprove);
  const evidenceKey = judgingContext
    ? ['judging-workspace', judgingContext.scope, 'panel-evidence', judgingContext.authority.scopeKey, roundId, applicationId]
    : ['awards-moderation', tenant.scopeKey, roundId, applicationId];
  const [page, setPage] = useState(1);
  const [method, setMethod] = useState('overall');
  const [overall, setOverall] = useState('');
  const [answers, setAnswers] = useState({});
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [action, setAction] = useState(null);
  const [actionReason, setActionReason] = useState('');
  const [actionVersion, setActionVersion] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const dirty = Boolean(overall || reason || message || actionReason || Object.keys(answers).length);
  useEffect(() => { callbacks.current.onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange?.(busy); }, [busy]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; callbacks.current.onDirtyChange?.(false); callbacks.current.onBusyChange?.(false); };
  }, []);
  const request = async (options = {}) => {
    if (judgingContext) {
      if (!judgingLive.current?.enabled || !judgingLive.current?.authority.ready) throw new Error('Panel evidence is blocked until current authority and both conflict gates are verified.');
      const result = await judgingRequest(options.method === 'POST' ? '/api/judging/panel'
        : `/api/judging/panel?roundId=${encodeURIComponent(roundId)}&applicationId=${encodeURIComponent(applicationId)}&page=${page}`,
      { authority: judgingContext.authority, signal: options.signal, ...(options.method === 'POST' ? { body: JSON.parse(options.body) } : {}) });
      judgingContext.authority.assertCurrent();
      if (!judgingLive.current?.enabled) throw new Error('Panel review authority changed during this request. Reload current conflict gates.');
      if (options.method !== 'POST' && (!result.application || !result.capabilities
        || ['propose', 'approve', 'message', 'reopen'].some(key => typeof result.capabilities[key] !== 'boolean')
        || !Array.isArray(result.assessments) || !Array.isArray(result.history) || !Array.isArray(result.messages))) throw new Error('The server did not return complete panel evidence and capabilities.');
      return result;
    }
    tenant.assertCurrent();
    const url = options.method === 'POST' ? '/api/awards/moderation' : `/api/awards/moderation?roundId=${encodeURIComponent(roundId)}&applicationId=${encodeURIComponent(applicationId)}&page=${page}`;
    const response = await adminFetch(url, options, tenant.tenantId);
    const result = await response.json();
    tenant.assertCurrent();
    if (!response.ok) throw new Error(result.error || 'Unable to load moderation evidence.');
    return result;
  };
  const evidence = useQuery({
    queryKey: [...evidenceKey, page],
    enabled: readReady,
    queryFn: async ({ signal }) => {
      try { return await request({ signal }); }
      catch (failure) {
        if (judgingContext && !signal.aborted) queryClient.setQueriesData({ queryKey: evidenceKey }, () => null);
        throw failure;
      }
    }, retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  useEffect(() => {
    if (judgingContext && !readReady) {
      queryClient.cancelQueries({ queryKey: evidenceKey });
      queryClient.setQueriesData({ queryKey: evidenceKey }, () => null);
    }
  // Scope changes remount this workspace; this effect never reinitialises drafts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readReady]);
  const data = judgingContext && (!readReady || evidence.isFetching || evidence.isError) ? undefined : evidence.data;
  const proposeAllowed = judgingContext ? data?.capabilities?.propose === true : canModerate;
  const approveAllowed = judgingContext ? data?.capabilities?.approve === true : canApprove;
  const messageAllowed = judgingContext ? data?.capabilities?.message === true : canModerate;
  const reopenAllowed = judgingContext ? data?.capabilities?.reopen === true : canModerate;
  let definition;
  let criteriaError = '';
  if (data?.criteria?.definition) {
    try { definition = validateCriteria(data.criteria.definition); }
    catch (failure) { criteriaError = failure.message; }
  }
  const moderation = data?.moderation;
  const actionAllowed = moderation?.version === actionVersion && (action === 'approve' ? approveAllowed && moderation?.state === 'proposed'
    : action === 'reopen' && reopenAllowed && ['proposed', 'approved'].includes(moderation?.state));
  const assertScope = () => judgingContext ? judgingContext.authority.assertCurrent() : tenant.assertCurrent();
  const reloadEvidence = async () => {
    if (busy) return;
    setError('');
    try {
      assertScope();
      const result = await evidence.refetch();
      assertScope();
      if (result.error) throw result.error;
      if (mounted.current) setNeedsRefresh(false);
    } catch (failure) { if (mounted.current) setError(failure.message); }
  };
  const command = async (name, payload) => {
    if (pending.current || needsRefresh) return false;
    if (!readReady || evidence.isFetching || evidence.isError || !data
      || !(name === 'approve' ? approveAllowed : name === 'reopen' ? reopenAllowed : name === 'message' ? messageAllowed : proposeAllowed)) return false;
    if (['approve', 'reopen'].includes(name) && !actionAllowed) return false;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await request({
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' },
        body: JSON.stringify({ roundId, applicationId, command: name, version: moderation?.version || 0, ...payload }),
      });
      if (!result.id || !Number.isSafeInteger(result.version)) throw new Error('The server did not confirm the moderation version. Reload evidence before retrying.');
      if (!mounted.current) return false;
      setNeedsRefresh(true);
      if (name === 'message') setMessage('');
      if (name === 'propose') { setOverall(''); setAnswers({}); setReason(''); }
      if (name === 'approve' || name === 'reopen') { setAction(null); setActionReason(''); }
      setNotice(name === 'message' ? 'Discussion message recorded.' : name === 'propose' ? 'Moderation proposal saved. It is not yet approved.' : name === 'approve' ? 'Moderation approval recorded.' : 'Moderation reopened. Previous records are retained.');
      const refreshed = await evidence.refetch();
      assertScope();
      if (refreshed.error) throw new Error(`The action was saved, but evidence could not be refreshed: ${refreshed.error.message}. Reload evidence before another action.`);
      if (mounted.current) setNeedsRefresh(false);
      return true;
    } catch (failure) { if (mounted.current) { setError(failure.message); setNeedsRefresh(true); } return false; }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const proposal = async event => {
    event.preventDefault(); setError('');
    try {
      if (!reason.trim()) throw new Error('Provide a proposal justification.');
      if (method === 'criterion') {
        if (!definition) throw new Error('The API has not supplied a criteria definition.');
        const computed = calculateAssessment(definition, answers, { final: true });
        if (!computed.scoringComplete) throw new Error('Resolve optional scored criteria before proposing a moderated score.');
      } else {
        calculateAssessment({ optionalPolicy: 'incomplete', criteria: [{ id: 'overall', title: 'Overall', type: 'numeric', required: true, min: 0, max: 100, weight: 100 }] }, { overall: { value: overall } }, { final: true });
      }
      if (judgingContext && !window.confirm('Record this moderation proposal against the current independent evidence? This does not approve or publish it.')) return;
      await command('propose', { method, ...(method === 'criterion' ? { answers } : { overall }), reason: reason.trim() });
    } catch (failure) { setError(failure.message); }
  };
  if (!judgingContext && !canModerate && !canApprove) return null;
  return <Card className="mt-5 min-w-0 shadow-sm">
    <CardHeader className="border-b"><div className="flex flex-wrap justify-between gap-3"><div><p className="awards-kicker mb-2">{judgingContext ? 'Appointment-authorised confidential panel' : 'Moderation evidence'}</p><CardTitle className="text-xl">Application {data?.application?.reference || applicationId}</CardTitle></div><Button size="sm" variant="outline" disabled={!readReady || busy || evidence.isFetching} onClick={reloadEvidence}>Reload evidence</Button></div>
      <p className="awards-help">Independent judging and moderation remain separate records. A different authorised approver is required unless the round explicitly permits self-approval. The server enforces this rule.</p>
    </CardHeader>
    <CardContent className="pt-5 space-y-5">
      {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}<p className="mt-2">Unsaved inputs are retained. If the version or evidence changed, reload before retrying. Discussion writes are not automatically retried.</p></div>}
      {!readReady ? <p role="alert" className="awards-help">Panel evidence is blocked pending current authority and conflict verification. Previously loaded evidence is cleared; unsaved moderation inputs remain local.</p>
        : needsRefresh ? <div className="rounded-lg border p-5"><p className="text-sm">{notice ? 'The action was saved. Reload evidence to view current scores and continue.' : 'Reload evidence to confirm the current server state before retrying. Unsaved inputs are retained.'}</p><Button variant="outline" disabled={busy || evidence.isFetching} className="mt-3" onClick={reloadEvidence}>Reload evidence</Button></div>
        : evidence.isLoading || (judgingContext && evidence.isFetching) ? <div aria-label="Loading moderation evidence" className="space-y-4"><Skeleton className="h-20 w-full" /><Skeleton className="h-40 w-full" /></div>
          : evidence.isError ? <div role="alert" className="text-sm text-red-800"><p>{evidence.error.message}</p><Button className="mt-3" variant="outline" onClick={reloadEvidence}>Retry evidence</Button></div>
            : data && <>
              {!judgingContext && (canModerate || canApprove) && <AdminModerationEvidence tenant={tenant} roundId={roundId} applicationId={applicationId}
                canModerate={canModerate} canApprove={canApprove} enabled={readReady && !evidence.isFetching && !needsRefresh} />}
              {judgingContext && <ImmutableEvidence
                scopeKey={JSON.stringify([judgingContext.authority.scopeKey, roundId, applicationId])}
                enabled={readReady && !evidence.isFetching && !needsRefresh}
                title="Appointed panel application evidence"
                assertCurrent={() => {
                  judgingContext.authority.assertCurrent();
                  if (!judgingLive.current?.enabled) throw new Error('Panel conflict or appointment authority changed. Reload current access.');
                }}
                loadReview={signal => judgingRequest(`/api/judging/panel?${new URLSearchParams({ scope: 'review', roundId, applicationId })}`, { authority: judgingContext.authority, signal })}
                loadAttachment={(attachmentId, options) => judgingPanelAttachmentRequest(roundId, applicationId, attachmentId, {
                  ...options, authority: { ...judgingContext.authority, assertCurrent() {
                    judgingContext.authority.assertCurrent();
                    if (!judgingLive.current?.enabled) throw new Error('Panel conflict or appointment authority changed.');
                  } },
                })} />}
              <section className="rounded-lg border overflow-hidden">
                <div className="p-4 bg-slate-50"><h3 className="font-semibold text-sm">Independent judging</h3><p className="text-xl font-semibold mt-2">{scoreText(data.independent?.finalAverage)}</p><p className="awards-help mt-1">{data.independent?.complete ? 'Required independent assessments complete' : 'Independent assessments incomplete'} · Provisional average: {scoreText(data.independent?.provisionalAverage)}</p>
                  {data.independent?.discrepancy && <p className="text-sm text-amber-800 mt-2">A score discrepancy is flagged for review.</p>}</div>
                <div className="p-4 border-t"><h3 className="font-semibold text-sm">Official score</h3><p className="text-xl font-semibold mt-2">{scoreText(data.official?.officialScore)}</p><p className="awards-help mt-1">{data.official?.complete ? 'Evidence complete' : 'Evidence incomplete'} · Moderation: {moderation?.state || 'No moderation record'}</p><p className="awards-help">The official score is returned by the server using current evidence and any valid approved moderation; proposing alone does not change it.</p></div>
              </section>
              <section><h3 className="font-semibold text-sm mb-3">Submitted independent assessments</h3>
                {data.assessments?.length ? <div className="space-y-3">{data.assessments.map((assessment, index) => <details key={assessment.assignmentId || index} className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">{assessment.judgeAlias} · {scoreText(assessment.score)} · {assessment.state}{assessment.revision ? ` · revision ${assessment.revision}` : ''}</summary>
                  <p className="awards-help mt-3">{assessment.included === false ? 'Excluded from aggregation' : assessment.recused ? 'Recused assessment' : 'Submitted evidence'}</p>
                  <dl className="space-y-4 mt-3">{Object.entries(assessment.answers || {}).map(([id, answer]) => <div key={id}><dt className="font-medium text-sm">{definition?.criteria?.find(criterion => criterion.id === id)?.title || id}</dt><dd className="text-sm whitespace-pre-wrap break-words mt-1">{plainValue(answer?.value)}</dd>{answer?.comment && <dd className="awards-help whitespace-pre-wrap break-words mt-2">Comment: {answer.comment}</dd>}</div>)}</dl>
                </details>)}</div> : <p className="awards-help">No submitted assessment evidence was returned.</p>}
              </section>
              {moderation?.revision && <section className="rounded-lg border p-4"><h3 className="font-semibold text-sm">Latest immutable moderation record</h3><p className="awards-help mt-2">Version {moderation.version} · {moderation.revision.action} · {moderation.revision.method}</p><p className="text-sm font-medium mt-2">{scoreText(moderation.revision.score)}</p><p className="text-sm whitespace-pre-wrap break-words mt-3">{moderation.revision.justification}</p></section>}
              <section className="border-t pt-5"><h3 className="font-semibold mb-3">Immutable moderation history</h3>
                {data.history?.length ? <ol className="space-y-3">{data.history.map(revision => <li key={revision.id}><details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Revision {revision.revision} · {revision.action} · {revision.method} · {scoreText(revision.exact_score)}</summary>
                  <p className="awards-help mt-3">{revision.created_at && Number.isFinite(Date.parse(revision.created_at)) ? new Date(revision.created_at).toLocaleString() : 'Timestamp unavailable'} · Original independent average: {scoreText(revision.original_average)}</p>
                  <p className="text-sm mt-3 whitespace-pre-wrap break-words">{revision.justification}</p>
                  {revision.criterion_answers && Object.keys(revision.criterion_answers).length > 0 && <dl className="mt-4 space-y-3">{Object.entries(revision.criterion_answers).map(([id, answer]) => <div key={id}><dt className="text-sm font-semibold">{definition?.criteria?.find(criterion => criterion.id === id)?.title || id}</dt><dd className="text-sm whitespace-pre-wrap break-words mt-1">{plainValue(answer?.value)}</dd>{answer?.comment && <dd className="awards-help whitespace-pre-wrap break-words mt-1">Comment: {answer.comment}</dd>}</div>)}</dl>}
                </details></li>)}</ol> : <p className="awards-help">No moderation history records on this page.</p>}
              </section>
              {data.sourceIds?.length > 0 && <details className="rounded-lg border p-4"><summary className="text-sm cursor-pointer">Source assessment revisions ({data.sourceIds.length})</summary><ul className="mt-3 space-y-1">{data.sourceIds.map(id => <li key={id} className="text-xs break-all font-mono">{id}</li>)}</ul></details>}
              {proposeAllowed && moderation?.state !== 'approved' && <form onSubmit={proposal} className="border-t pt-5 space-y-4">
                <h3 className="font-semibold">Propose a moderated score</h3>
                {criteriaError && <p role="alert" className="text-sm text-red-800">Criterion-level moderation is unavailable because the returned definition is invalid: {criteriaError}.</p>}
                {!data.independent?.complete && <p className="awards-help">Complete the required independent assessments before proposing moderation.</p>}
                <fieldset disabled={busy || !data.independent?.complete} className="space-y-4">
                  {definition && <div className="awards-field"><Label htmlFor="moderation-method">Proposal method</Label><select id="moderation-method" className="awards-select" value={method} onChange={event => setMethod(event.target.value)}><option value="overall">Overall score</option><option value="criterion">Criterion-level assessment</option></select></div>}
                  {method === 'criterion' && definition ? definition.criteria.map((criterion, index) => <ResponseCriterion key={criterion.id} criterion={criterion} index={index} answer={answers[criterion.id] || {}} errors={[]} onChange={patch => setAnswers(old => ({ ...old, [criterion.id]: { ...old[criterion.id], ...patch } }))} />)
                    : <div className="awards-field"><Label htmlFor="moderation-overall">Overall score (0–100)</Label><Input id="moderation-overall" type="number" min="0" max="100" step="any" required value={overall} onChange={event => setOverall(event.target.value)} /></div>}
                  <div className="awards-field"><Label htmlFor="moderation-justification">Proposal justification (required)</Label><Textarea id="moderation-justification" maxLength={20000} required rows={4} value={reason} onChange={event => setReason(event.target.value)} /></div>
                  <Button type="submit" disabled={!reason.trim()}>Save proposal</Button>
                </fieldset>
              </form>}
              <div className="flex flex-wrap gap-3">
                {approveAllowed && moderation?.state === 'proposed' && <Button disabled={busy} onClick={() => { setActionReason(''); setActionVersion(moderation.version); setAction('approve'); }}>Approve moderation…</Button>}
                {reopenAllowed && ['proposed', 'approved'].includes(moderation?.state) && <Button variant="outline" disabled={busy} onClick={() => { setActionReason(''); setActionVersion(moderation.version); setAction('reopen'); }}>Reopen moderation…</Button>}
              </div>
              <section className="border-t pt-5"><h3 className="font-semibold mb-3">Recorded discussion</h3>
                {data.messages?.length ? <ol className="space-y-3">{data.messages.map(item => <li key={item.id} className="rounded-lg border p-4"><p className="text-sm whitespace-pre-wrap break-words">{item.content}</p><p className="awards-help mt-2">{item.created_at && Number.isFinite(Date.parse(item.created_at)) ? new Date(item.created_at).toLocaleString() : 'Timestamp unavailable'}</p></li>)}</ol> : <p className="awards-help">No discussion messages on this page.</p>}
                <p className="awards-help mt-3">Recorded messages and moderation history cannot be edited or deleted here. Pagination loads both record lists together, up to 50 records of each type per page.</p>
                <div className="flex flex-wrap justify-between items-center gap-2 mt-4"><Button variant="outline" size="sm" disabled={busy || page <= 1} onClick={() => setPage(value => value - 1)}>Previous records</Button><span className="awards-help">Discussion & history page {page}</span><Button variant="outline" size="sm" disabled={busy || Math.max(data.messages?.length || 0, data.history?.length || 0) < 50} onClick={() => setPage(value => value + 1)}>Next records</Button></div>
                {messageAllowed && <form className="mt-5 space-y-3" onSubmit={event => { event.preventDefault(); if (message.trim()) command('message', { reason: message.trim() }); }}>
                  <Label htmlFor="moderation-message">Add a discussion message</Label><Textarea id="moderation-message" required maxLength={20000} value={message} disabled={busy} onChange={event => setMessage(event.target.value)} /><Button type="submit" variant="outline" disabled={busy || !message.trim()}>Record message</Button>
                </form>}
              </section>
            </>}
      {busy && <p role="status" className="awards-help">Saving moderation action…</p>}
      <Dialog open={Boolean(action)} onOpenChange={open => { if (!open && !busy && (!actionReason || window.confirm('Discard the unsaved action reason?'))) { setAction(null); setActionReason(''); } }}>
        <DialogContent className="awards-workspace"><DialogHeader><DialogTitle>{action === 'approve' ? 'Approve this moderation proposal?' : 'Reopen approved moderation?'}</DialogTitle><DialogDescription>{action === 'approve' ? 'Approval records a separate authorised decision against the current independent evidence. It does not publish results or send messages.' : 'Reopening retains earlier evidence and removes approved moderation finality until a new proposal is approved.'}</DialogDescription></DialogHeader>
          <Label htmlFor="moderation-action-reason">Reason (required)</Label><Textarea id="moderation-action-reason" required maxLength={20000} value={actionReason} disabled={busy} onChange={event => setActionReason(event.target.value)} />
          {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
          {needsRefresh && <Button variant="outline" disabled={busy || evidence.isFetching} onClick={reloadEvidence}>Reload evidence without discarding reason</Button>}
          {action && !actionAllowed && !needsRefresh && !busy && <p className="awards-help">The current moderation state is {moderation?.state || 'unavailable'}. This action is no longer available; review the refreshed evidence before continuing.</p>}
          <DialogFooter><Button variant="outline" disabled={busy} onClick={() => { if (!actionReason || window.confirm('Discard the unsaved action reason?')) { setAction(null); setActionReason(''); } }}>Cancel</Button><Button disabled={busy || !actionReason.trim() || needsRefresh || !actionAllowed} onClick={() => command(action, { reason: actionReason.trim() })}>{busy ? 'Saving…' : 'Confirm action'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <AssessmentHistory roundId={roundId} applicationId={applicationId} tenant={tenant} judgingContext={judgingContext}
        canModerate={!judgingContext && canModerate} canApprove={!judgingContext && canApprove}
        enabled={readReady && evidence.isSuccess && !evidence.isFetching && !evidence.isError && !needsRefresh && !!data}
        onAccessDenied={() => {
          queryClient.setQueriesData({ queryKey: evidenceKey }, () => null);
          setNeedsRefresh(true);
        }} />
    </CardContent>
  </Card>;
}
