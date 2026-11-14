import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { communicationKey, communicationUuid } from './useAwardCommunications';
import { shortlistGroupKey, shortlistStreamKey, shortlistStreams, shortlistPublicationRequest, useShortlistPublicationCatalog } from './useShortlistPublication';
import ShortlistEventScope from './ShortlistEventScope';
import ShortlistPublicationHistory from './ShortlistPublicationHistory';

const projectionOf = row => ({ title: row?.safe_projection?.title || '', recipient: row?.safe_projection?.recipient || '', summary: row?.safe_projection?.summary || '' });
export default function ShortlistPublicationPanel({ award, tenant, canPublish, canCommunicate, onDirtyChange, onBusyChange }) {
  const query = useShortlistPublicationCatalog(tenant, award.id), queryClient = useQueryClient();
  const [groupKey, setGroupKey] = useState(''), [audience, setAudience] = useState(''), [scope, setScope] = useState(''), [eventLinkId, setEventLinkId] = useState(''), [verifiedLink, setVerifiedLink] = useState(null);
  const [action, setAction] = useState(''), [title, setTitle] = useState(''), [recipient, setRecipient] = useState(''), [summary, setSummary] = useState(''), [reason, setReason] = useState(''), [releaseReason, setReleaseReason] = useState('');
  const [confirmation, setConfirmation] = useState(null), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [authorised, setAuthorised] = useState({});
  const pending = useRef(false), alive = useRef(true), callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const dirty = !!(action || title || recipient || summary || reason || releaseReason || confirmation);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const decisions = query.data?.shortlists || [], publications = query.data?.publications || [];
  let streams = new Map(), streamError = '';
  if (query.data) { try { streams = shortlistStreams(publications); } catch (failure) { streamError = failure.message; } }
  const ready = query.isSuccess && !query.isFetching && !query.isError && !streamError;
  const groups = new Map();
  for (const row of decisions) groups.set(shortlistGroupKey(row), { round_id: row.round_id, application_id: row.application_id, current: row });
  for (const row of publications) if (!groups.has(shortlistGroupKey(row))) groups.set(shortlistGroupKey(row), { round_id: row.round_id, application_id: row.application_id, current: null });
  const selected = groups.get(groupKey), current = selected?.current;
  const streamKey = selected && audience && scope && (scope !== 'event' || eventLinkId)
    ? shortlistStreamKey({ ...selected, audience, event_link_id: scope === 'event' ? eventLinkId : null }) : '';
  const previous = streamKey ? streams.get(streamKey) : null;
  const expectedRevision = ready ? previous?.revision || 0 : null;
  const active = !!previous && previous.action !== 'retract';
  const actions = active ? [...(current ? ['correct'] : []), 'retract'] : current ? ['publish'] : [];
  const locationReady = scope === 'award' || (scope === 'event' && !!eventLinkId && (verifiedLink === eventLinkId || !!previous));
  const label = current ? `${current.reference} · ${current.round_name}` : selected ? `Historical application ${selected.application_id} · round ${selected.round_id}` : '';
  const publicationValid = ready && canPublish && !!selected && !!audience && locationReady && actions.includes(action)
    && !!reason.trim() && reason.length <= 20000 && (action === 'retract' || (!!title.trim() && title.length <= 300 && recipient.length <= 300 && summary.length <= 5000));
  const releaseValid = ready && canCommunicate && !!current && !authorised[current.id] && !!releaseReason.trim() && releaseReason.length <= 20000;
  const clearPublication = () => { setAction(''); setTitle(''); setRecipient(''); setSummary(''); setReason(''); };
  const changeContext = run => {
    if (pending.current || confirmation || (dirty && !window.confirm('Discard unsaved shortlist publication/release inputs before changing context? An unconfirmed previous command may already have succeeded; changing drafts does not undo it.'))) return;
    clearPublication(); setReleaseReason(''); run();
  };
  const maintain = (row, copy) => changeContext(() => {
    setGroupKey(shortlistGroupKey(row)); setAudience(row.audience); setScope(row.event_link_id ? 'event' : 'award'); setEventLinkId(row.event_link_id || '');
    if (copy) { const value = projectionOf(row); setTitle(value.title); setRecipient(value.recipient); setSummary(value.summary); }
  });
  const refresh = async () => {
    const result = await query.refetch(); tenant.assertCurrent();
    if (result.error || !result.data) throw result.error || new Error('The complete shortlist catalog could not be reloaded.');
    shortlistStreams(result.data.publications);
  };
  const invalidateReaders = () => {
    queryClient.invalidateQueries({ queryKey: ['award-audit-history', tenant.scopeKey, award.id] });
    queryClient.invalidateQueries({ queryKey: [...communicationKey(tenant, award.id), 'shortlists'] });
  };
  const reload = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await refresh(); if (alive.current) { setBlocked(false); setNotice('Complete decisions and publication history reloaded. Your inputs are retained; review the current stream revision before another explicit confirmation. A reload does not prove an unconfirmed write was absent.'); } }
    catch (failure) { if (alive.current) { setBlocked(true); setError(failure.message); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const review = kind => {
    if (pending.current || blocked || (kind === 'release' ? !releaseValid : !publicationValid)) return;
    const payload = kind === 'release'
      ? { command: 'release', awardId: award.id, shortlistId: current.id, reason: releaseReason.trim() }
      : { command: 'publish', awardId: award.id, shortlistId: action === 'retract' ? previous.shortlist_id : current.id,
        eventLinkId: scope === 'event' ? eventLinkId : null, audience, action, expectedRevision,
        projection: action === 'retract' ? projectionOf(previous) : { title, recipient, summary }, reason: reason.trim() };
    setConfirmation({ kind, payload, label, streamKey, decisionId: current?.id || null, decisionRevision: current?.revision || null });
    setError('');
  };
  const confirmationStale = !!confirmation && (!ready || (confirmation.kind === 'release'
    ? !decisions.some(row => row.id === confirmation.payload.shortlistId)
    : (streams.get(confirmation.streamKey)?.revision || 0) !== confirmation.payload.expectedRevision
      || (confirmation.payload.action !== 'retract' && current?.id !== confirmation.payload.shortlistId)));
  const commit = async () => {
    if (pending.current || !confirmation || blocked || confirmationStale || !ready
      || (confirmation.kind === 'release' ? !canCommunicate : !canPublish)) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    let confirmed = false;
    try {
      const result = await shortlistPublicationRequest(tenant, confirmation.payload);
      if (confirmation.kind === 'release') {
        if (!communicationUuid(result.release_id) || result.sent !== false) throw new Error('The server did not confirm recipient release authorisation.');
        confirmed = true;
        if (!alive.current) return;
        setAuthorised(old => ({ ...old, [confirmation.payload.shortlistId]: result.release_id })); setReleaseReason('');
        setNotice(`Recipient release authorised for ${confirmation.label}. Authorisation ID ${result.release_id}. No message was queued or sent. Publication was not changed.`);
      } else {
        if (!communicationUuid(result.id) || result.revision !== confirmation.payload.expectedRevision + 1 || result.action !== confirmation.payload.action) throw new Error('The server did not confirm the expected publication revision.');
        confirmed = true;
        if (!alive.current) return;
        clearPublication();
        setNotice(`Shortlist ${result.action} recorded, publication revision ${result.revision}, ${confirmation.payload.audience} audience. Recipient release was not granted; no message was queued or sent.`);
      }
      setConfirmation(null); setBlocked(true); invalidateReaders();
      await refresh();
      if (alive.current) setBlocked(false);
    } catch (failure) {
      if (alive.current) { setBlocked(true); setError(confirmed
        ? `The action was confirmed, but refreshing the catalog failed. Do not repeat it; reload complete history first. ${failure.message}`
        : `${failure.message} The result is unconfirmed. Inputs and confirmation are retained. Reload complete history before any explicit retry; no command is repeated automatically.`); }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="space-y-5">
    <div className="rounded-lg border bg-[#edf4f4] p-4 space-y-2"><p className="awards-kicker">Protected staff stage · shortlist decisions</p><h3 className="font-semibold">Safe visibility and recipient release are separate authorities</h3><p className="awards-help">Award stage: {typeof award.state === 'string' ? award.state.replaceAll('_', ' ') : 'not returned'}. Only the current eligible confirmed decisions explicitly returned by the staff catalog can be newly published, corrected or released. Neither a confirmation nor a category name makes a person publicly shortlisted.</p></div>
    <div className="flex flex-wrap justify-between gap-3 items-center"><p className="awards-help">{ready ? `${decisions.length} current confirmed decisions · ${publications.length} immutable publication revisions · complete catalog loaded` : 'Commands wait for the complete decision catalog and publication history.'}</p><Button type="button" size="sm" variant="outline" disabled={busy || query.isFetching} onClick={reload}>Reload complete catalog (keep drafts)</Button></div>
    {query.isPending && <div role="status" aria-label="Loading complete shortlist publication catalog"><Skeleton className="h-12 mb-3" /><Skeleton className="h-28" /></div>}
    {query.isError && <p role="alert" className="text-sm text-red-700">{query.error.message} Use the reload control to retry. No partial history is used.</p>}
    {streamError && <p role="alert" className="text-sm text-red-700">{streamError}</p>}
    {blocked && <p role="alert" className="text-sm text-amber-800">Complete-catalog reconciliation is required before another write. Close any confirmation to keep its inputs, then reload above.</p>}
    {notice && <p role="status" className="awards-help">{notice}</p>}{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {query.data && <>
      <label className="block text-sm">Protected decision / historical maintenance context<select className="awards-select mt-1" disabled={busy || !ready || !!confirmation} value={groupKey} onChange={e => changeContext(() => { setGroupKey(e.target.value); setAudience(''); setScope(''); setEventLinkId(''); })}><option value="">Choose an explicit context</option>
        {groupKey && !groups.has(groupKey) && <option value={groupKey} disabled>Retained context {groupKey} — unavailable in the loaded confirmed/history catalog</option>}
        <optgroup label="Current eligible confirmed decisions">{decisions.map(row => <option key={row.id} value={shortlistGroupKey(row)}>{row.reference} · {row.round_name} · confirmed decision revision {row.revision}</option>)}</optgroup>
        {canPublish && <optgroup label="Historical publication maintenance — not current confirmed membership">{[...groups.entries()].filter(([, row]) => !row.current).map(([key, row]) => <option key={key} value={key}>Historical application {row.application_id} · round {row.round_id}</option>)}</optgroup>}
      </select></label>
      {!decisions.length && <div className="rounded-lg border border-dashed p-5 awards-help">No current eligible confirmed shortlist decisions were returned. New visibility and recipient release are unavailable. Previously published streams remain accessible below for withdrawal.</div>}
      {canPublish && <section className="rounded-lg border p-4 space-y-4">
        <h4 className="font-semibold">Audience publication / correction / retraction</h4>
        <p className="awards-help">Each round/application, audience and event association has its own revision stream. Publication never releases a private decision to a recipient or sends mail. Enter only independently authorised plain text—no private answers, identities or outcome/category guesses are inserted.</p>
        <fieldset disabled={busy || !ready || !selected || !!confirmation} className="space-y-4">
          <label className="block text-sm">Audience<select className="awards-select mt-1" value={audience} onChange={e => changeContext(() => setAudience(e.target.value))}><option value="">Choose explicitly</option><option value="public">Public</option><option value="member">Members</option></select></label>
          <ShortlistEventScope tenant={tenant} award={award} scope={scope} eventLinkId={eventLinkId} historicalStream={!!previous}
            disabled={busy || !ready || !selected || !!confirmation} onVerified={setVerifiedLink} onChange={(value, id) => changeContext(() => { setScope(value); setEventLinkId(id); })} />
          <p className="awards-help">{!streamKey ? 'Choose the audience and exact location to identify a stream.' : expectedRevision === null ? 'Expected revision is unavailable until complete history loads.' : previous ? `Current stream: revision ${previous.revision} · ${previous.action}. Expected next revision: ${previous.revision + 1}.` : 'No publication exists in this exact stream. Expected current revision: 0.'}</p>
          {!current && selected && <p className="awards-help">Historical maintenance only. This context is not in the current confirmed catalog. An active projection can still be retracted using its stored decision; correction needs a new current eligible confirmed decision in the same round/application.</p>}
          <label className="block text-sm">Separate action<select className="awards-select mt-1" value={action} onChange={e => {
            const next = e.target.value;
            if (next === 'retract' && (title || recipient || summary)) {
              if (!window.confirm('Switch to retraction and discard the unsaved replacement text? Only the currently recorded projection will be withdrawn; your replacement text will not be published.')) return;
              setTitle(''); setRecipient(''); setSummary('');
            }
            setAction(next);
          }}><option value="">Choose an action explicitly</option>{action && !actions.includes(action) && <option value={action} disabled>Retained {action} — unavailable in this current stream context</option>}{actions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          {action && !actions.includes(action) && <p role="alert" className="awards-help">The retained action is no longer available after reconciliation. Review the current history and explicitly choose an allowed action. Nothing was automatically retried.</p>}
          {action === 'retract' ? <div className="rounded-lg border p-4 space-y-2"><p className="awards-kicker">Recorded projection being withdrawn</p><p className="font-medium whitespace-pre-wrap break-words">{previous?.safe_projection?.title}</p><p className="text-sm whitespace-pre-wrap break-words">{previous?.safe_projection?.recipient}</p><p className="text-sm whitespace-pre-wrap break-words">{previous?.safe_projection?.summary}</p><p className="awards-help">Retraction appends a withdrawal revision; it does not erase earlier evidence or publish replacement text.</p></div> : <>
            <label className="block text-sm">Authorised title (required)<Input required maxLength={300} value={title} onChange={e => setTitle(e.target.value)} /></label>
            <label className="block text-sm">Authorised recipient display text (optional)<Input maxLength={300} value={recipient} onChange={e => setRecipient(e.target.value)} /></label>
            <label className="block text-sm">Authorised summary (optional)<Textarea rows={4} maxLength={5000} value={summary} onChange={e => setSummary(e.target.value)} /></label>
            <div className="rounded-lg border bg-[#edf4f4] p-4 space-y-2"><p className="awards-kicker">Explicit safe plain-text projection</p><p className="font-medium whitespace-pre-wrap break-words">{title}</p><p className="text-sm whitespace-pre-wrap break-words">{recipient}</p><p className="text-sm whitespace-pre-wrap break-words">{summary}</p><p className="awards-help">HTML is never interpreted. Applicant references above are staff context, not automatically published identity.</p></div>
          </>}
          <label className="block text-sm">Publication / correction / retraction reason<Textarea required maxLength={20000} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <Button type="button" disabled={blocked || !publicationValid} onClick={() => review('publish')}>Review {action || 'publication action'}…</Button>
        </fieldset>
      </section>}
      {canCommunicate && <section className="rounded-lg border p-4 space-y-4"><h4 className="font-semibold">Separate recipient release authorisation</h4><p className="awards-help">Authorises this exact current confirmed decision for recipient communications. It does not publish a projection, queue a message or send mail. Scheduling remains a separate Communications action.</p>
        {current && authorised[current.id] && <p role="status" className="awards-help">Release confirmed in this session: {authorised[current.id]}. No message was sent. The catalog does not expose release status from earlier sessions.</p>}
        <fieldset disabled={busy || !ready || !current || !!confirmation || !!authorised[current?.id]} className="space-y-3"><label className="block text-sm">Recipient release reason<Textarea required maxLength={20000} value={releaseReason} onChange={e => setReleaseReason(e.target.value)} /></label><Button type="button" disabled={blocked || !releaseValid} onClick={() => review('release')}>Review recipient release authorisation…</Button></fieldset>
      </section>}
      <ShortlistPublicationHistory publications={publications} decisions={decisions} streams={streams} timezone={award.timezone} canPublish={canPublish} disabled={busy || !ready || !!confirmation}
        onMaintain={row => maintain(row, false)} onCopy={row => maintain(row, true)} />
    </>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !pending.current) setConfirmation(null); }}><DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{confirmation?.kind === 'release' ? 'Authorise shortlist recipient release' : `Confirm shortlist ${confirmation?.payload.action || 'publication'}`}</DialogTitle><DialogDescription>{confirmation?.kind === 'release' ? 'Release authority is independent of publication. No message will be queued or sent.' : 'Only the explicit safe projection is affected in this exact audience/location stream. Recipient release is not granted; no mail is sent.'}</DialogDescription></DialogHeader>
      {confirmation && <div className="space-y-3 text-sm break-words"><p className="font-semibold">{confirmation.label}</p><p>Decision ID: {confirmation.payload.shortlistId}{confirmation.decisionRevision && confirmation.kind === 'release' ? ` · current confirmed revision ${confirmation.decisionRevision}` : ''}</p>
        {confirmation.kind !== 'release' && <><p>Audience: {confirmation.payload.audience} · {confirmation.payload.eventLinkId ? `event association ${confirmation.payload.eventLinkId}` : 'award-level scope'}</p><p>Expected publication revision: {confirmation.payload.expectedRevision}; new revision: {confirmation.payload.expectedRevision + 1}.</p><div className="rounded-lg border p-4 space-y-2"><p className="awards-kicker">{confirmation.payload.action === 'retract' ? 'Recorded text being withdrawn — no replacement is published' : 'Authorised projection snapshot'}</p><p className="font-medium whitespace-pre-wrap">{confirmation.payload.projection.title}</p><p className="whitespace-pre-wrap">{confirmation.payload.projection.recipient}</p><p className="whitespace-pre-wrap">{confirmation.payload.projection.summary}</p></div></>}
        <p className="whitespace-pre-wrap">Reason: {confirmation.payload.reason}</p>
      </div>}
      {confirmationStale && <p role="alert" className="text-sm text-amber-800">The catalog or expected stream changed. Close this confirmation, reload if needed, and review the retained inputs explicitly.</p>}{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>Close (keep inputs)</Button><Button type="button" disabled={busy || blocked || confirmationStale || !ready || (confirmation?.kind === 'release' ? !canCommunicate : !canPublish)} onClick={commit}>{busy ? 'Recording authority…' : confirmation?.kind === 'release' ? 'Authorise release only' : 'Record publication action'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
