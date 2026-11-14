import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { decisionRequest, latestOutcomes, publicationStreams, useOutcomeHistory, usePublicationHistory } from './useAwardDecisions';
import { eventLinksReady, publicationScopeLabel, usePublicationEventLinks } from './usePublicationEventLinks';
import PublicationEventScope from './PublicationEventScope';

export default function PublicationPanel({ awardId, tenant, canPublish, canCommunicate, onDirtyChange, onBusyChange }) {
  const outcomesQuery = useOutcomeHistory(awardId, tenant);
  const publicationsQuery = usePublicationHistory(awardId, tenant);
  const eventLinksQuery = usePublicationEventLinks(tenant, awardId);
  const [outcomeId, setOutcomeId] = useState('');
  const [audience, setAudience] = useState('public');
  const [scope, setScope] = useState(''), [eventLinkId, setEventLinkId] = useState('');
  const [action, setAction] = useState('');
  const [title, setTitle] = useState('');
  const [recipient, setRecipient] = useState('');
  const [summary, setSummary] = useState('');
  const [reason, setReason] = useState('');
  const [releaseReason, setReleaseReason] = useState('');
  const [authorisations, setAuthorisations] = useState({});
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(1);
  const pending = useRef(false), alive = useRef(true), callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const publicationDirty = Boolean(action || title || recipient || summary || reason);
  const dirty = publicationDirty || Boolean(releaseReason);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const outcomes = outcomesQuery.data?.outcomes || [], publications = publicationsQuery.data || [];
  const latest = latestOutcomes(outcomes);
  const approved = [...latest.values()].filter(outcome => outcome.state === 'approved');
  const selected = approved.find(outcome => outcome.id === outcomeId);
  const byOutcome = new Map(outcomes.map(outcome => [outcome.id, outcome]));
  const context = byOutcome.get(outcomeId);
  const links = eventLinksReady(eventLinksQuery) ? eventLinksQuery.data : [];
  const scopeLabel = scope === 'award' ? 'Award-wide' : scope === 'event' && eventLinkId ? publicationScopeLabel(eventLinkId, links) : 'No scope chosen';
  const historicalOutcomes = [...new Set(publications.map(row => row.outcome_revision_id))].map(id => byOutcome.get(id)).filter(row => row && !approved.some(outcome => outcome.id === row.id));
  let streamError = '', streams = new Map();
  if (outcomesQuery.isSuccess && publicationsQuery.isSuccess) {
    try { streams = publicationStreams(publications, outcomes); } catch (failure) { streamError = failure.message; }
  }
  const streamKey = context && scope && (scope !== 'event' || eventLinkId) ? `${context.application_id}:${audience}:${scope === 'event' ? eventLinkId : 'award'}` : '';
  const previous = streamKey ? streams.get(streamKey) : null;
  const active = Boolean(previous && previous.action !== 'retract');
  const discoveredLocation = scope === 'award' || (scope === 'event' && links.some(link => link.id === eventLinkId));
  const historicalLocation = scope === 'event' && !!previous && previous.event_link_id === eventLinkId;
  const actions = active ? [...(selected && discoveredLocation ? ['correct'] : []), 'retract'] : selected && discoveredLocation ? ['publish'] : [];
  const ready = outcomesQuery.isSuccess && publicationsQuery.isSuccess && !outcomesQuery.isFetching && !publicationsQuery.isFetching && !streamError && !blocked;
  const locationReady = discoveredLocation || historicalLocation;
  const clearPublication = () => { setAction(''); setTitle(''); setRecipient(''); setSummary(''); setReason(''); };
  const changeScope = (nextScope, nextLink) => {
    if (pending.current) return;
    if (publicationDirty && !window.confirm('Change publication scope while retaining the authored title, recipient, summary and reason? You must choose the action again and review this different stream. Recipient release inputs/authority are unchanged.')) return;
    setScope(nextScope); setEventLinkId(nextLink); setAction('');
  };
  const openStream = row => {
    if (pending.current || !ready || !canPublish) return;
    if (dirty && !window.confirm('Discard unsaved publication text/release reason before opening the latest state of this recorded audience/scope stream? No saved action is undone.')) return;
    const historical = byOutcome.get(row.outcome_revision_id);
    if (!historical) return;
    const current = approved.find(outcome => outcome.application_id === historical.application_id);
    setOutcomeId(current?.id || historical.id); setAudience(row.audience);
    setScope(row.event_link_id ? 'event' : 'award'); setEventLinkId(row.event_link_id || '');
    clearPublication(); setReleaseReason('');
  };
  const reload = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const results = await Promise.all([outcomesQuery.refetch(), publicationsQuery.refetch(), eventLinksQuery.refetch()]);
      tenant.assertCurrent();
      if (results.slice(0, 2).some(result => result.error)) throw results.slice(0, 2).find(result => result.error).error;
      if (alive.current) setBlocked(false);
      if (results[2].error && alive.current) setError(`Histories reloaded; event discovery remains unavailable: ${results[2].error.message}. Award-wide commands, recorded-stream retraction and recipient release do not require discovery.`);
    } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const reloadAfterWrite = async () => {
    const results = await Promise.all([outcomesQuery.refetch(), publicationsQuery.refetch()]);
    tenant.assertCurrent();
    if (results.some(result => result.error)) throw new Error('The action was confirmed, but the complete histories could not be reloaded. Reload before another action.');
    if (alive.current) setBlocked(false);
  };
  const pages = Math.max(1, Math.ceil(publications.length / 10));
  return <section className="space-y-5">
    <div className="flex flex-wrap justify-between items-start gap-3"><div><h3 className="font-semibold">Publication & recipient release</h3><p className="awards-help mt-2">Publication changes an explicitly chosen audience projection. Recipient release is a different authority. Neither action sends messages automatically.</p></div><Button size="sm" variant="outline" disabled={busy} onClick={reload}>Reload complete histories</Button></div>
    {(outcomesQuery.isLoading || publicationsQuery.isLoading) && <div aria-label="Loading complete outcome and publication histories" className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-24 w-full" /></div>}
    {(outcomesQuery.isError || publicationsQuery.isError || streamError) && <p role="alert" className="text-sm text-red-800">{outcomesQuery.error?.message || publicationsQuery.error?.message || streamError} Complete histories are required before publication or release commands.</p>}
    <div className="awards-field"><Label htmlFor="publication-outcome">Outcome / recorded publication context</Label><select id="publication-outcome" className="awards-select" value={outcomeId} disabled={busy || !ready} onChange={event => {
      if (dirty && !window.confirm('Discard unsaved publication text and release reason before selecting another outcome?')) return;
      setOutcomeId(event.target.value); clearPublication(); setReleaseReason(''); setScope(''); setEventLinkId('');
    }}><option value="">Choose an approved outcome or recorded context</option>{outcomeId && !context && <option value={outcomeId} disabled>Previously selected outcome is unavailable ({outcomeId})</option>}
      <optgroup label="Current approved outcomes — publication and separate recipient release">{approved.map(outcome => <option value={outcome.id} key={outcome.id}>Application {outcome.application_id} · {outcome.category_snapshot?.name || outcome.category_id} · outcome revision {outcome.revision}</option>)}</optgroup>
      {canPublish && historicalOutcomes.length > 0 && <optgroup label="Historical publication context — active stream retraction only">{historicalOutcomes.map(outcome => <option value={outcome.id} key={outcome.id}>Application {outcome.application_id} · historical outcome revision {outcome.revision} · {outcome.state}</option>)}</optgroup>}
    </select>
      {outcomesQuery.isSuccess && !approved.length && <p className="awards-help">No current approved outcomes are available. Provisional and recommended outcomes cannot be published or released.</p>}
      {context && !selected && <p className="awards-help">Historical context is open. New publication, correction and recipient release require a current approved outcome. Active recorded streams remain available for explicit retraction; already retracted streams remain readable.</p>}
    </div>
    {canPublish && <form className="rounded-lg border p-4 space-y-4" onSubmit={async event => {
      event.preventDefault();
      if (pending.current || !ready || !context || !locationReady || !actions.includes(action) || !reason.trim() || reason.length > 20000
        || (action !== 'retract' && (!selected || !title.trim() || title.length > 300 || recipient.length > 300 || summary.length > 5000))) return;
      const payload = { command: 'publish', outcomeId: action === 'retract' ? previous.outcome_revision_id : selected.id, eventLinkId: scope === 'event' ? eventLinkId : null, audience, action, expectedRevision: previous?.revision || 0, projection: action === 'retract' ? {} : { title, recipient, summary }, reason: reason.trim() };
      if (!window.confirm(`${action === 'publish' ? 'Publish' : action === 'correct' ? 'Correct' : 'Retract'} the ${audience} result for application ${context.application_id}?\nScope: ${scopeLabel}\nExpected stream revision ${payload.expectedRevision}; new revision ${payload.expectedRevision + 1}.\nOnly this exact audience/scope projection is affected. Retraction withdraws the recorded text, not any unsaved replacement. This neither releases a recipient nor queues/sends mail.`)) return;
      pending.current = true; setBusy(true); setError(''); setNotice('');
      try {
        const result = await decisionRequest(tenant, '/api/awards/publications', payload);
        if (!result.id || result.revision !== payload.expectedRevision + 1 || result.action !== payload.action) throw new Error('The server did not confirm the exact publication revision. Reload before retrying.');
        if (!alive.current) return;
        clearPublication(); setBlocked(true); setNotice(`${audience === 'public' ? 'Public' : 'Member'} publication ${result.action} revision ${result.revision} recorded for ${scopeLabel}. Recipient release was not authorised and no message was sent by this action.`);
        await reloadAfterWrite();
      } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
      finally { pending.current = false; if (alive.current) setBusy(false); }
    }}>
      <h4 className="font-semibold">Audience publication</h4>
      <p className="awards-help">Every application/audience/award-or-event scope has a separate revision stream. Choose scope explicitly; an association does not itself authorise publication. Never include private answers, evidence files or unauthorised identity details.</p>
      <fieldset className="space-y-4" disabled={busy || !ready || !context}>
        <div className="awards-field"><Label htmlFor="publication-audience">Audience</Label><select id="publication-audience" className="awards-select" value={audience} onChange={event => {
          if (publicationDirty && !window.confirm('Discard this publication draft before switching audience? Text is not carried automatically between audiences.')) return;
          setAudience(event.target.value); clearPublication();
        }}><option value="public">Public</option><option value="member">Members</option></select></div>
        <PublicationEventScope query={eventLinksQuery} scope={scope} eventLinkId={eventLinkId} disabled={busy || !ready || !context}
          historicalIds={publications.filter(row => row.event_link_id && byOutcome.get(row.outcome_revision_id)?.application_id === context?.application_id && row.audience === audience).map(row => row.event_link_id)}
          onChange={changeScope} />
        <p className="awards-help">Scope: {scopeLabel}. Current {audience} stream: {previous ? `revision ${previous.revision} · ${previous.action}` : streamKey ? 'No recorded publication' : 'Choose an explicit scope/association first'}.</p>
        {scope === 'event' && historicalLocation && !discoveredLocation && <p className="awards-help">Only recorded-stream retraction is available without a currently discovered association. No new or corrected projection is authorised by a historical ID alone.</p>}
        <div className="awards-field"><Label htmlFor="publication-action">Separate publication action</Label><select id="publication-action" className="awards-select" value={action} onChange={event => {
          const next = event.target.value;
          if (next === 'retract' && (title || recipient || summary)) {
            if (!window.confirm('Switch to retraction and discard the authored replacement text? Only this stream’s recorded projection will be withdrawn; the replacement will not be published. The reason is retained.')) return;
            setTitle(''); setRecipient(''); setSummary('');
          }
          setAction(next);
        }}><option value="">Choose explicitly</option>{action && !actions.includes(action) && <option value={action} disabled>Retained {action} — unavailable for this stream</option>}{actions.map(value => <option value={value} key={value}>{value === 'publish' ? 'Publish projection' : value === 'correct' ? 'Create corrected publication revision' : 'Retract publication'}</option>)}</select></div>
        {action && !actions.includes(action) && <p role="alert" className="text-sm text-amber-800">The retained action is no longer available for this stream. Text and reason remain here; reconcile and choose an authorised action explicitly.</p>}
        {action !== 'retract' && <>
          {active && <Button type="button" size="sm" variant="outline" onClick={() => {
            if ((title || recipient || summary) && !window.confirm('Replace this draft with the currently recorded publication text?')) return;
            setTitle(previous.safe_projection?.title || ''); setRecipient(previous.safe_projection?.recipient || ''); setSummary(previous.safe_projection?.summary || '');
          }}>Load currently published text explicitly</Button>}
          <div className="awards-field"><Label htmlFor="publication-title">Authorised title (required)</Label><Input id="publication-title" required maxLength={300} value={title} onChange={event => setTitle(event.target.value)} /></div>
          <div className="awards-field"><Label htmlFor="publication-recipient">Authorised recipient display text (optional)</Label><Input id="publication-recipient" maxLength={300} value={recipient} onChange={event => setRecipient(event.target.value)} /></div>
          <div className="awards-field"><Label htmlFor="publication-summary">Authorised summary (optional)</Label><Textarea id="publication-summary" rows={4} maxLength={5000} value={summary} onChange={event => setSummary(event.target.value)} /></div>
          <div className="rounded-lg bg-slate-50 border p-4"><p className="awards-kicker mb-3">Plain-text projection · {audience}</p><p className="text-sm font-semibold whitespace-pre-wrap break-words">{title}</p><p className="text-sm mt-2 whitespace-pre-wrap break-words">{recipient}</p><p className="text-sm mt-2 whitespace-pre-wrap break-words">{summary}</p><p className="awards-help mt-3">HTML is not interpreted. No private application content is inserted automatically.</p></div>
        </>}
        {action === 'retract' && previous && <div className="rounded-lg border p-4 space-y-2"><p className="awards-kicker">Recorded projection being withdrawn · {audience} · {scopeLabel}</p><p className="text-sm whitespace-pre-wrap break-words">{previous.safe_projection?.title}</p><p className="text-sm whitespace-pre-wrap break-words">{previous.safe_projection?.recipient}</p><p className="text-sm whitespace-pre-wrap break-words">{previous.safe_projection?.summary}</p><p className="awards-help">Retraction submits no replacement text. It does not retract another scope or recipient release.</p></div>}
        <div className="awards-field"><Label htmlFor="publication-reason">Publication / correction / retraction reason (required)</Label><Textarea id="publication-reason" required maxLength={20000} value={reason} onChange={event => setReason(event.target.value)} /></div>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={!locationReady || !actions.includes(action) || !reason.trim() || (action !== 'retract' && !title.trim())}>{action ? `Confirm ${action}…` : 'Choose a publication action'}</Button><Button type="button" variant="outline" onClick={() => { if (!publicationDirty || window.confirm('Discard the unsaved publication draft?')) clearPublication(); }}>Clear publication draft</Button></div>
      </fieldset>
    </form>}
    {canCommunicate && <form className="rounded-lg border p-4 space-y-4" onSubmit={async event => {
      event.preventDefault(); if (pending.current || !ready || !selected || !releaseReason.trim() || authorisations[selected.id]) return;
      if (!window.confirm(`Authorise recipient release for approved outcome revision ${selected.revision}, application ${selected.application_id}? This authorisation is separate from audience publication. No message will be sent by this request.`)) return;
      pending.current = true; setBusy(true); setError(''); setNotice('');
      try {
        const result = await decisionRequest(tenant, '/api/awards/publications', { command: 'release', outcomeId: selected.id, reason: releaseReason.trim() });
        if (!result.release_id || result.delivery !== 'authorised' || result.sent !== false) throw new Error('The server did not confirm recipient release authorisation. Reload before retrying.');
        if (!alive.current) return;
        setAuthorisations(old => ({ ...old, [selected.id]: result.release_id })); setReleaseReason(''); setBlocked(true); setNotice('Recipient release authorised. No message has been sent.');
        await reloadAfterWrite();
      } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
      finally { pending.current = false; if (alive.current) setBusy(false); }
    }}>
      <h4 className="font-semibold">Recipient release authorisation</h4><p className="awards-help">Approval and publication do not grant recipient delivery authority. This action applies to the selected current approved outcome, independently of the publication scope/audience above. Choosing or retracting an event stream does not grant or revoke release. This records authorisation only; it does not queue or send a message.</p>
      {selected && authorisations[selected.id] && <p role="status" className="text-sm text-emerald-800">Authorised in this session. No message was sent by this action.</p>}
      <fieldset disabled={busy || !ready || !selected || Boolean(authorisations[selected?.id])} className="space-y-4">
        <div className="awards-field"><Label htmlFor="outcome-release-reason">Release reason (required)</Label><Textarea id="outcome-release-reason" required rows={3} maxLength={20000} value={releaseReason} onChange={event => setReleaseReason(event.target.value)} /></div>
        <Button type="submit" disabled={!releaseReason.trim()}>Authorise recipient release…</Button>
      </fieldset>
    </form>}
    <section className="border-t pt-5"><h3 className="font-semibold mb-3">Immutable publication history</h3>
      {publications.length ? <ol className="space-y-3">{publications.slice((Math.min(page, pages) - 1) * 10, Math.min(page, pages) * 10).map(publication => <li key={publication.id}><details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium break-words">Application {byOutcome.get(publication.outcome_revision_id)?.application_id || publication.outcome_revision_id} · {publication.audience} · {publicationScopeLabel(publication.event_link_id, links)} · revision {publication.revision} · {publication.action}</summary>
        <p className="awards-help mt-3">{publicationScopeLabel(publication.event_link_id, links)} · Outcome revision {byOutcome.get(publication.outcome_revision_id)?.revision}</p>
        <p className="text-sm mt-3 font-medium whitespace-pre-wrap break-words">{publication.safe_projection?.title}</p><p className="text-sm mt-2 whitespace-pre-wrap break-words">{publication.safe_projection?.recipient}</p><p className="text-sm mt-2 whitespace-pre-wrap break-words">{publication.safe_projection?.summary}</p><p className="awards-help mt-3 whitespace-pre-wrap break-words">Reason: {publication.reason}</p>
        {canPublish && <Button type="button" size="sm" variant="outline" className="mt-3" disabled={busy || !ready} onClick={() => openStream(publication)}>Open latest state of this exact stream</Button>}
      </details></li>)}</ol> : <p className="awards-help">{publicationsQuery.isSuccess ? 'No publication revisions have been recorded.' : 'Publication history is not yet completely loaded.'}</p>}
      {pages > 1 && <div className="flex justify-between items-center gap-2 mt-4"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous publications</Button><span className="awards-help">{Math.min(page, pages)} / {pages}</span><Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>Next publications</Button></div>}
    </section>
    {blocked && <p role="alert" className="text-sm text-amber-800">Reload both complete histories before another command. An uncertain write is not automatically repeated.</p>}
    {busy && <p role="status" className="awards-help">Recording or refreshing publication evidence…</p>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-800">{error} Unsaved inputs remain here unless the server confirmed their save.</p>}
  </section>;
}
