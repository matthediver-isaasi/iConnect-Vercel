import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { compareScores } from '../../../../api/_lib/assessment/scoring.js';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import OutcomeCategories from './OutcomeCategories';
import { decisionRequest, decisionScore, latestOutcomes, publicationStreams, useOutcomeHistory, usePublicationHistory } from './useAwardDecisions';

const ACTIONS = { provisional: 'Save provisional outcome', recommended: 'Recommend outcome', approved: 'Approve outcome', reopened: 'Reopen outcome' };
const nextStates = current => !current || current.state === 'reopened' ? ['provisional']
  : current.state === 'provisional' ? ['recommended', 'reopened']
    : current.state === 'recommended' ? ['approved', 'reopened'] : current.state === 'approved' ? ['reopened'] : [];
const sameScore = (a, b) => { try { return Boolean(a && b && compareScores(a, b) === 0); } catch { return false; } };

export default function OutcomePanel({ awardId, roundId, tenant, canApprove, canEdit, onDirtyChange, onBusyChange }) {
  const outcomesQuery = useOutcomeHistory(awardId, tenant);
  const publicationsQuery = usePublicationHistory(awardId, tenant, canApprove);
  const rankings = useQuery({
    queryKey: ['award-outcome-evidence', tenant.scopeKey, roundId], enabled: Boolean(roundId && canApprove),
    queryFn: ({ signal }) => decisionRequest(tenant, '/api/awards/shortlist', { command: 'preview', roundId, mode: 'manual', threshold: '0', limit: null }, signal),
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const [applicationId, setApplicationId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [method, setMethod] = useState('score');
  const [target, setTarget] = useState('');
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [categoryDirty, setCategoryDirty] = useState(false);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(1);
  const pending = useRef(false), alive = useRef(true), callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const formDirty = Boolean(applicationId || reason || override || target || categoryId);
  useEffect(() => { callbacks.current.onDirtyChange(formDirty || categoryDirty); }, [formDirty, categoryDirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy || categoryBusy); }, [busy, categoryBusy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const outcomes = outcomesQuery.data?.outcomes || [], categories = outcomesQuery.data?.categories || [];
  const latest = latestOutcomes(outcomes);
  const current = latest.get(applicationId);
  const entries = rankings.data?.entries || [];
  const entry = entries.find(item => item.id === applicationId);
  const applicationRef = id => entries.find(item => item.id === id)?.reference || id;
  const preserve = current && target !== 'provisional';
  const actualCategory = preserve ? current.category_id : categoryId;
  const actualMethod = preserve ? current.selection_method : method;
  const scored = entries.filter(item => item.eligibility === 'eligible' && item.complete && item.officialScore);
  const best = scored[0];
  const ties = best ? scored.filter(item => sameScore(item.officialScore, best.officialScore)) : [];
  const exceptional = actualMethod === 'manual' || !entry?.complete || (actualMethod === 'score' && (!sameScore(entry?.officialScore, best?.officialScore) || ties.length !== 1));
  let publicationError = '', activePublications = [];
  if (outcomesQuery.isSuccess && publicationsQuery.isSuccess) {
    try {
      const streams = publicationStreams(publicationsQuery.data, outcomes);
      activePublications = [...streams.entries()].filter(([key, publication]) => key.startsWith(`${applicationId}:`) && publication.action !== 'retract').map(([, publication]) => publication);
    } catch (failure) { publicationError = failure.message; }
  }
  const reopeningBlocked = target === 'reopened' && (!publicationsQuery.isSuccess || publicationsQuery.isFetching || Boolean(publicationError) || activePublications.length > 0);
  const roundMismatch = Boolean(current && current.round_id !== roundId);
  const moderationBlocked = target !== 'provisional' && target !== 'reopened' && entry?.moderationRequired && entry.moderationState !== 'approved';
  const roundReady = ['judging', 'moderation', 'closed'].includes(rankings.data?.round?.state);
  const ready = outcomesQuery.isSuccess && !outcomesQuery.isFetching;
  const writeReady = ready && roundReady && rankings.isSuccess && !rankings.isFetching && !blocked && !roundMismatch && !reopeningBlocked && !moderationBlocked && Boolean(entry && entry.eligibility === 'eligible');
  const reload = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const queries = [outcomesQuery.refetch()];
      if (canApprove) queries.push(publicationsQuery.refetch());
      if (canApprove && roundId) queries.push(rankings.refetch());
      const results = await Promise.all(queries);
      tenant.assertCurrent();
      // A publication read failure blocks reopening, not category editing.
      if (results[0].error) throw results[0].error;
      if (canApprove && roundId && results[2]?.error) throw results[2].error;
      if (alive.current) setBlocked(false);
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const clear = () => { setApplicationId(''); setCategoryId(''); setMethod('score'); setTarget(''); setReason(''); setOverride(false); };
  const pages = Math.max(1, Math.ceil(outcomes.length / 10));
  return <section className="space-y-5">
    <div className="flex flex-wrap justify-between items-start gap-3"><div><h3 className="font-semibold">Outcome records</h3><p className="awards-help mt-2">Provisional, recommended and approved outcomes are separate decisions. Approval may require a different authorised actor. Nothing is published or released automatically.</p></div><Button size="sm" variant="outline" disabled={busy || categoryBusy} onClick={reload}>Reload full decision evidence</Button></div>
    {outcomesQuery.isLoading ? <Skeleton className="h-32 w-full" /> : outcomesQuery.isError ? <p role="alert" className="text-sm text-red-800">{outcomesQuery.error.message} Complete outcome history must load before commands are available.</p> : null}
    <OutcomeCategories awardId={awardId} tenant={tenant} categories={categories} outcomes={outcomes} ready={ready} canEdit={canEdit} disabled={busy}
      onSaved={async () => { const result = await outcomesQuery.refetch(); tenant.assertCurrent(); if (result.error) throw result.error; }} onDirtyChange={setCategoryDirty} onBusyChange={setCategoryBusy} />
    {canApprove && !roundId && <p className="awards-help">Choose a decision round above to prepare an outcome.</p>}
    {canApprove && roundId && <>
      {rankings.isLoading ? <Skeleton className="h-20 w-full" /> : rankings.isError ? <p role="alert" className="text-sm text-red-800">{rankings.error.message} Current assessment evidence is required for outcome decisions.</p> : null}
      {rankings.isSuccess && !roundReady && <p className="text-sm text-amber-800">This round is {rankings.data.round?.state || 'unavailable'}. Outcome commands require a judging, moderation or closed round.</p>}
      <form className="space-y-4 border-t pt-5" onSubmit={async event => {
        event.preventDefault();
        if (pending.current || !writeReady || !target || !actualCategory || !reason.trim() || !nextStates(current).includes(target) || (target !== 'reopened' && exceptional && !override)) return;
        if (actualMethod === 'panel' && entry.moderationState !== 'approved') { setError('Panel selection requires approved moderation.'); return; }
        if (!window.confirm(`${ACTIONS[target]} for application ${applicationRef(applicationId)}? This records one outcome revision only. It does not publish results or authorise delivery.`)) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        try {
          const result = await decisionRequest(tenant, '/api/awards/outcomes', { command: 'decide', awardId, roundId, applicationId, categoryId: actualCategory, expectedRevision: current?.revision || 0, state: target, method: actualMethod, override, reason: reason.trim() });
          if (!result.outcome?.id || !Number.isSafeInteger(result.outcome.revision) || result.outcome.state !== target) throw new Error('The server did not confirm the requested outcome. Reload before retrying.');
          if (!alive.current) return;
          clear(); setBlocked(true); setNotice(`${ACTIONS[target]}: revision ${result.outcome.revision} recorded. No other stage was triggered.`);
          const refreshed = await Promise.all([outcomesQuery.refetch(), rankings.refetch(), publicationsQuery.refetch()]);
          tenant.assertCurrent();
          if (refreshed[0].error || refreshed[1].error) throw new Error('The outcome was saved, but current decision evidence could not be fully reloaded.');
          if (alive.current) setBlocked(false);
        } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      }}>
        <fieldset disabled={busy || categoryBusy || !ready || !rankings.isSuccess} className="space-y-4">
          <div className="awards-field"><Label htmlFor="outcome-application">Eligible application</Label><select id="outcome-application" className="awards-select" value={applicationId} onChange={event => {
            if (formDirty && !window.confirm('Discard the unsaved outcome decision?')) return;
            setApplicationId(event.target.value); setCategoryId(''); setTarget(''); setMethod('score'); setReason(''); setOverride(false);
          }}><option value="">Choose an application</option>{entries.filter(item => item.eligibility === 'eligible').map(item => <option key={item.id} value={item.id}>{item.reference || item.id} · {decisionScore(item.officialScore)}</option>)}</select></div>
          {current && <p className="awards-help">Latest outcome: {current.state} · revision {current.revision} · {current.category_snapshot?.name || current.category_id} · {current.selection_method}</p>}
          {roundMismatch && <p className="text-sm text-amber-800">The latest outcome belongs to round {current.round_id}. Select that round before advancing or reopening it.</p>}
          <div className="awards-field"><Label htmlFor="outcome-action">Separate outcome action</Label><select id="outcome-action" className="awards-select" value={target} disabled={!applicationId || roundMismatch} onChange={event => { setTarget(event.target.value); setOverride(false); }}><option value="">Choose an action</option>{nextStates(current).map(value => <option value={value} key={value}>{ACTIONS[value]}</option>)}</select></div>
          <div className="awards-field"><Label htmlFor="outcome-category">Outcome category</Label><select id="outcome-category" className="awards-select" value={actualCategory || ''} disabled={Boolean(preserve)} onChange={event => setCategoryId(event.target.value)}><option value="">Choose a category</option>{actualCategory && !categories.some(category => category.id === actualCategory) && <option value={actualCategory}>Saved category {actualCategory}</option>}{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div>
          <div className="awards-field"><Label htmlFor="outcome-method">Selection method</Label><select id="outcome-method" className="awards-select" value={actualMethod} disabled={Boolean(preserve)} onChange={event => setMethod(event.target.value)}><option value="score">Score-based</option><option value="panel">Approved panel moderation</option><option value="manual">Manual selection</option></select></div>
          {entry && <p className="awards-help">{entry.complete ? 'Independent evidence complete' : 'Evidence incomplete'} · {decisionScore(entry.officialScore)}{entry.discrepancy ? ' · Discrepancy flagged' : ''}{entry.moderationRequired ? ` · Required moderation: ${entry.moderationState || 'not approved'}` : ''}</p>}
          {exceptional && applicationId && target !== 'reopened' && <p className="text-sm text-amber-800">This manual, incomplete, tied or non-leading selection requires an explicit reasoned override. No tie is broken automatically.</p>}
          {reopeningBlocked && <p className="text-sm text-amber-800">{activePublications.length ? `Retract ${activePublications.length} active audience/event publication scope(s) before reopening. Ask an authorised publisher if needed.` : publicationError || publicationsQuery.error?.message || 'Load complete publication history before reopening.'}</p>}
          {moderationBlocked && <p className="text-sm text-amber-800">Required moderation must be approved before recommendation or approval.</p>}
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={override} onChange={event => setOverride(event.target.checked)} /><span>I explicitly authorise the exceptional selection and will record its justification.</span></label>
          <div className="awards-field"><Label htmlFor="outcome-reason">Decision reason (required)</Label><Textarea id="outcome-reason" required maxLength={20000} rows={4} value={reason} onChange={event => setReason(event.target.value)} /></div>
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={!writeReady || !target || !actualCategory || !reason.trim() || (target !== 'reopened' && exceptional && !override)}>{target ? `${ACTIONS[target]}…` : 'Choose a separate action'}</Button><Button type="button" variant="outline" onClick={() => { if (!formDirty || window.confirm('Discard the unsaved outcome decision?')) clear(); }}>Clear outcome draft</Button></div>
        </fieldset>
      </form>
    </>}
    <section className="border-t pt-5"><h3 className="font-semibold mb-3">Immutable outcome history</h3>
      {outcomes.length ? <ol className="space-y-3">{outcomes.slice((Math.min(page, pages) - 1) * 10, Math.min(page, pages) * 10).map(outcome => <li key={outcome.id}><details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium break-words">{applicationRef(outcome.application_id)} · revision {outcome.revision} · {outcome.state}{latest.get(outcome.application_id)?.id === outcome.id ? ' · Current' : ''}</summary>
        <p className="awards-help mt-3">{outcome.category_snapshot?.name || categories.find(category => category.id === outcome.category_id)?.name || outcome.category_id} · {outcome.selection_method} · {decisionScore(outcome.score_snapshot)}{outcome.is_override ? ' · Explicit override' : ''}</p><p className="text-sm whitespace-pre-wrap break-words mt-2">{outcome.reason}</p><p className="awards-help mt-2 break-all">Round: {outcome.round_id}</p>
      </details></li>)}</ol> : <p className="awards-help">{ready ? 'No outcome revisions have been recorded.' : 'Outcome history is not yet completely loaded.'}</p>}
      {pages > 1 && <div className="flex justify-between items-center gap-2 mt-4"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous outcomes</Button><span className="awards-help">{Math.min(page, pages)} / {pages}</span><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>Next outcomes</Button></div>}
    </section>
    {blocked && <p role="alert" className="text-sm text-amber-800">Reload full decision evidence before another outcome command. Inputs are retained unless the server confirmed their save.</p>}
    {busy && <p role="status" className="awards-help">Recording or refreshing outcome evidence…</p>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-800">{error} No failed write is automatically retried.</p>}
  </section>;
}
