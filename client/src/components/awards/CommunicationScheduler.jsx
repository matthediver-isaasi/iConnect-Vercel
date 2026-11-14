import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { TimezoneAwareDateTimeInput } from '@/components/events/TimezoneAwareDateTimeInput';
import { latestOutcomes } from './useAwardDecisions';
import { appointmentMessageLabel, communicationRequest, communicationUuid, messageLabel, messageTime } from './useAwardCommunications';

const appointmentCategories = ['judge_invitation_reminder', 'judging_deadline', 'incomplete_assessment', 'moderation_invitation'];
const outcomeCategories = ['winner', 'unsuccessful', 'certificate'];
const iso = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const configurationSignature = configuration => JSON.stringify([configuration?.version || 0, configuration?.email_template_id || null, configuration?.enabled ?? true]);

export default function CommunicationScheduler({
  tenant, award, choices, outcomes, shortlists, ready, outcomesReady, shortlistsReady, disabled,
  reconcile, onScheduled, onDirtyChange, onBusyChange,
}) {
  const [category, setCategory] = useState(''), [applicationId, setApplicationId] = useState(''), [appointmentId, setAppointmentId] = useState('');
  const [outcomeId, setOutcomeId] = useState(''), [shortlistId, setShortlistId] = useState(''), [issueId, setIssueId] = useState('');
  const [dueAt, setDueAt] = useState(''), [dueMeta, setDueMeta] = useState(null), [linkExpiresAt, setLinkExpiresAt] = useState(''), [expiryMeta, setExpiryMeta] = useState(null);
  const [reason, setReason] = useState(''), [releaseAcknowledged, setReleaseAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState(null), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [clock, setClock] = useState(Date.now);
  const pending = useRef(false), alive = useRef(true), attempt = useRef(null), callbacks = useRef({});
  callbacks.current = { onDirtyChange, onBusyChange, reconcile, onScheduled };
  const isAppointment = appointmentCategories.includes(category), needsOutcome = outcomeCategories.includes(category), needsShortlist = category === 'shortlist';
  const needsRelease = needsOutcome || needsShortlist;
  const application = choices.applications.find(row => row.id === applicationId), appointment = choices.appointments.find(row => row.id === appointmentId);
  const approved = [...latestOutcomes(outcomes).values()].filter(row => row.state === 'approved');
  const selectedOutcome = approved.find(row => row.id === outcomeId && row.application_id === applicationId);
  const selectedShortlist = shortlists.find(row => row.id === shortlistId && row.application_id === applicationId);
  const selectedIssue = choices.certificates.find(row => row.id === issueId && row.outcomeId === outcomeId);
  const external = category === 'certificate' && selectedIssue?.external === true;
  const configuration = choices.configurations.find(row => row.category === category);
  const categoryEnabled = configuration?.enabled ?? true;
  const templateAvailable = !configuration?.email_template_id || choices.templates.some(row => row.id === configuration.email_template_id);
  const configSignature = configurationSignature(configuration);
  const payload = { command: 'schedule', awardId: award.id, category, dueAt, reason: reason.trim(),
    ...(isAppointment ? { appointmentId } : { applicationId }),
    ...(needsOutcome ? { outcomeId } : {}), ...(needsShortlist ? { shortlistId } : {}),
    ...(category === 'certificate' ? { issueId, ...(external ? { linkExpiresAt } : {}) } : {}),
  };
  const signature = JSON.stringify(payload);
  const exactRetry = attempt.current?.signature === signature && attempt.current.attempted && !attempt.current.confirmed;
  const resourcesReady = ready && (!needsOutcome || outcomesReady) && (!needsShortlist || shortlistsReady);
  const dirty = !!(category || reason || dueAt || dueMeta?.localValue !== undefined || linkExpiresAt || confirmation);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => { alive.current = false; window.clearInterval(timer); callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  const dateError = !dueAt || !iso(dueAt) || dueMeta?.error || dueMeta?.localValue !== undefined
    ? 'Choose an unambiguous send time with a resolved timezone.'
    : Date.parse(dueAt) <= clock && !exactRetry ? 'Choose a future send time. Past times are never silently moved forward.'
      : external && (!iso(linkExpiresAt) || expiryMeta?.error || expiryMeta?.localValue !== undefined)
        ? 'Choose an explicit, unambiguous expiry for the external certificate link.'
        : external && (Date.parse(linkExpiresAt) <= Date.parse(dueAt) || (!exactRetry && Date.parse(linkExpiresAt) <= clock) || Date.parse(linkExpiresAt) > clock + 30 * 86400000)
          ? 'Link expiry must be after the send time, in the future, and no more than 30 days from now.' : '';
  const appointmentEligible = row => category === 'judge_invitation_reminder' ? row.state === 'invited'
    : row.state === 'accepted' && (category !== 'moderation_invitation' || ['chair', 'approver'].includes(row.role));
  const validRecipient = isAppointment ? !!appointment && appointmentEligible(appointment) : !!application && application.eligibility !== 'withdrawn';
  const valid = resourcesReady && choices.categories.includes(category) && category !== 'judge_invitation' && categoryEnabled && templateAvailable && validRecipient
    && (!needsOutcome || !!selectedOutcome) && (!needsShortlist || !!selectedShortlist) && (category !== 'certificate' || !!selectedIssue)
    && (!needsRelease || releaseAcknowledged) && !!reason.trim() && reason.length <= 20000 && !dateError;
  const resetRecipient = () => {
    setApplicationId(''); setAppointmentId(''); setOutcomeId(''); setShortlistId(''); setIssueId('');
    setLinkExpiresAt(''); setExpiryMeta(null); setReleaseAcknowledged(false);
  };
  const review = () => {
    if (!valid || pending.current || blocked || disabled) return;
    if (attempt.current?.attempted && !attempt.current.confirmed && attempt.current.signature !== signature
      && !window.confirm('The previous scheduling attempt is unconfirmed. A changed intent requires a NEW request ID and could create an additional message if the first succeeded. Inspect delivery history first. Continue with this different intent?')) return;
    if (attempt.current?.signature !== signature) attempt.current = { signature, requestId: crypto.randomUUID(), attempted: false, confirmed: false };
    setError('');
    setConfirmation({ payload: { ...payload, requestId: attempt.current.requestId }, signature, configurationSignature: configSignature,
      label: isAppointment ? appointmentMessageLabel(appointment) : `Application ${application.reference}`,
      outcome: selectedOutcome ? `${selectedOutcome.category_snapshot?.name || 'Recorded outcome'} · approved revision ${selectedOutcome.revision}` : null,
      shortlist: selectedShortlist ? `${selectedShortlist.round_name} · confirmed shortlist revision ${selectedShortlist.revision}` : null,
      external, template: choices.templates.find(row => row.id === configuration?.email_template_id)?.subject || (configuration?.email_template_id ? `Saved template ID ${configuration.email_template_id}` : 'Safe built-in message'),
    });
  };
  const schedule = async () => {
    if (pending.current || !confirmation || !valid || blocked || disabled || !resourcesReady || !categoryEnabled || confirmation.configurationSignature !== configSignature) return;
    const frozen = confirmation.payload, previousAttempt = attempt.current?.signature === confirmation.signature && attempt.current.attempted;
    if (!previousAttempt && (Date.parse(frozen.dueAt) <= Date.now() || (confirmation.external && (Date.parse(frozen.linkExpiresAt) <= Date.now() || Date.parse(frozen.linkExpiresAt) > Date.now() + 30 * 86400000)))) {
      setError('The reviewed time window is no longer valid. Close the dialog and explicitly choose new times; nothing has been scheduled by this click.'); return;
    }
    if (previousAttempt && Date.parse(frozen.dueAt) <= Date.now() && !window.confirm('The original due time has passed. Retrying this unchanged request may confirm an existing delivery, or queue it for processing now if the first request never committed. Continue with the SAME request ID?')) return;
    pending.current = true; setBusy(true); setError('');
    attempt.current.attempted = true;
    let confirmed = false;
    try {
      const result = await communicationRequest(tenant, '/api/awards/communications', { body: frozen });
      if (!communicationUuid(result.id) || typeof result.state !== 'string' || !result.state) throw new Error('The server did not confirm a delivery record and state.');
      confirmed = true; attempt.current.confirmed = true;
      if (!alive.current) return;
      setNotice(result.state === 'delivered'
        ? `Delivery ${result.id}: the server reports delivered${result.replayed ? ' (existing request)' : ''}. This is not a new-send claim.`
        : `Delivery ${result.id}: ${result.state === 'pending' ? 'queued (pending)' : result.state}${result.replayed ? ' (existing request)' : ''}. Not confirmed delivered. No send before its due time and authority recheck.`);
      setConfirmation(null); setCategory(''); resetRecipient(); setDueAt(''); setDueMeta(null); setReason('');
      await callbacks.current.onScheduled();
    } catch (failure) {
      if (alive.current) { setBlocked(true); setError(confirmed
        ? `The delivery record was confirmed, but refreshing failed. Do not schedule again; reconcile history. ${failure.message}`
        : `${failure.message} The outcome is unconfirmed. Selections, reason, times and the exact request ID are retained. Reconcile before an explicit retry; nothing will be retried automatically.`); }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const reconcileAttempt = async () => {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true);
    try {
      await callbacks.current.reconcile(); tenant.assertCurrent();
      if (alive.current) { setBlocked(false); setConfirmation(null); setNotice('Current choices and delivery history reloaded. History does not expose request IDs, so it cannot prove an unconfirmed attempt was absent. An unchanged retry keeps its original request ID; review and confirm it explicitly.'); }
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="space-y-4 border-t pt-5">
    <h3 className="font-semibold">Schedule one authorised message</h3>
    <p className="awards-help">Uses saved category settings only. Scheduling never approves a result, authorises a recipient release or sends a judge invitation. Recipient, current configuration and release authority are rechecked by the worker before sending.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{notice && <p role="status" className="awards-help">{notice}</p>}
    {blocked && <Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={reconcileAttempt}>Reconcile before retry (keep intent)</Button>}
    <fieldset disabled={busy || disabled || !ready || !!confirmation} className="space-y-4">
      <label className="block text-sm">Message category<select className="awards-select mt-1" value={category} onChange={e => { setCategory(e.target.value); resetRecipient(); }}><option value="">Choose a category explicitly</option>{choices.categories.filter(value => value !== 'judge_invitation').map(value => <option key={value} value={value}>{messageLabel(value)}</option>)}</select></label>
      <p className="awards-help">Initial judge invitations and resends use the existing appointment invitation action in Rounds, not this scheduler.</p>
      {category && ((isAppointment && !choices.appointments.some(appointmentEligible)) || (!isAppointment && !choices.applications.length)) && <div className="rounded-lg border border-dashed p-5 awards-help">No {isAppointment ? 'eligible appointments' : 'application records'} are available in the complete loaded catalog for this selection. A real discovered recipient is required; no address or identity is invented.</div>}
      {category && !categoryEnabled && <p role="alert" className="text-sm text-amber-800">This category is disabled in saved settings. Enable and save it separately before scheduling.</p>}
      {category && !templateAvailable && <p role="alert" className="text-sm text-amber-800">The saved Email Template is absent from the complete active catalog. Explicitly save a valid template or the built-in message before scheduling; the source is never silently replaced.</p>}
      {['winner', 'unsuccessful'].includes(category) && <p className="awards-help">This category does not decide whether someone won or lost. Choose an actual approved outcome below. Both built-in categories use the neutral authorised outcome wording.</p>}
      {category && (isAppointment ? <>
        <label className="block text-sm">Appointment<select className="awards-select mt-1" value={appointmentId} onChange={e => setAppointmentId(e.target.value)}><option value="">Choose a discovered appointment</option>{appointmentId && !appointment && <option value={appointmentId} disabled>Retained appointment {appointmentId} — unavailable in loaded choices</option>}{choices.appointments.map(row => <option value={row.id} key={row.id} disabled={!appointmentEligible(row)}>{appointmentMessageLabel(row)}</option>)}</select></label>
        <p className="awards-help">The catalog exposes round, role, state and appointment ID—not judge names or email addresses. No identity aliases are invented. Assignment completion, expiry and current round authority are checked by the server.</p>
      </> : <label className="block text-sm">Application<select className="awards-select mt-1" value={applicationId} onChange={e => { setApplicationId(e.target.value); setOutcomeId(''); setShortlistId(''); setIssueId(''); setLinkExpiresAt(''); setExpiryMeta(null); setReleaseAcknowledged(false); }}><option value="">Choose an application reference</option>{applicationId && !application && <option value={applicationId} disabled>Retained application {applicationId} — unavailable in loaded choices</option>}{choices.applications.map(row => <option value={row.id} key={row.id} disabled={row.eligibility === 'withdrawn'}>{row.reference} · {row.eligibility}</option>)}</select></label>)}
      {needsOutcome && <label className="block text-sm">Approved outcome<select className="awards-select mt-1" disabled={!outcomesReady || !applicationId} value={outcomeId} onChange={e => { setOutcomeId(e.target.value); setIssueId(''); setLinkExpiresAt(''); setExpiryMeta(null); setReleaseAcknowledged(false); }}><option value="">Choose the recorded approved decision</option>{outcomeId && !selectedOutcome && <option value={outcomeId} disabled>Retained decision {outcomeId} — unavailable in loaded approved choices</option>}{approved.filter(row => row.application_id === applicationId).map(row => <option value={row.id} key={row.id}>{application?.reference} · {row.category_snapshot?.name || 'Recorded outcome'} · revision {row.revision}</option>)}</select></label>}
      {needsShortlist && <label className="block text-sm">Current confirmed shortlist decision<select className="awards-select mt-1" disabled={!shortlistsReady || !applicationId} value={shortlistId} onChange={e => { setShortlistId(e.target.value); setReleaseAcknowledged(false); }}><option value="">Choose a discovered confirmed decision</option>{shortlistId && !selectedShortlist && <option value={shortlistId} disabled>Retained shortlist {shortlistId} — unavailable in loaded confirmed choices</option>}{shortlists.filter(row => row.application_id === applicationId).map(row => <option value={row.id} key={row.id}>{row.reference} · {row.round_name} · revision {row.revision}</option>)}</select></label>}
      {category === 'certificate' && <label className="block text-sm">Issued certificate for this exact outcome<select className="awards-select mt-1" disabled={!selectedOutcome} value={issueId} onChange={e => { setIssueId(e.target.value); setLinkExpiresAt(''); setExpiryMeta(null); setReleaseAcknowledged(false); }}><option value="">Choose an immutable certificate issue</option>{issueId && !selectedIssue && <option value={issueId} disabled>Retained issue {issueId} — unavailable for this loaded outcome</option>}{choices.certificates.filter(row => row.outcomeId === outcomeId).map(row => <option value={row.id} key={row.id}>{application?.reference} · issue {row.id} · {row.external ? 'external link required' : 'member access'}</option>)}</select></label>}
      {needsOutcome && applicationId && outcomesReady && !approved.some(row => row.application_id === applicationId) && <div className="rounded-lg border border-dashed p-5 awards-help">No approved outcome was returned for this application. The message category cannot create or infer an outcome; approval remains a separate action.</div>}
      {needsShortlist && applicationId && shortlistsReady && !shortlists.some(row => row.application_id === applicationId) && <div className="rounded-lg border border-dashed p-5 awards-help">No current confirmed shortlist decision was returned for this application. Scheduling does not recommend, confirm or release a shortlist.</div>}
      {category === 'certificate' && selectedOutcome && !choices.certificates.some(row => row.outcomeId === outcomeId) && <div className="rounded-lg border border-dashed p-5 awards-help">No immutable certificate issue is present for this exact outcome in the complete catalog. Issuance is a separate certificate-administration action.</div>}
      {needsRelease && <div className="rounded-lg border p-4 space-y-2"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={releaseAcknowledged} onChange={e => setReleaseAcknowledged(e.target.checked)} /><span>I have separately authorised recipient release for this exact {needsShortlist ? 'confirmed shortlist decision' : 'approved outcome'}.</span></label><p className="awards-help">Acknowledging this does not grant release. Publication is not recipient release. The scheduler rejects a missing release and the worker rechecks it before sending.</p></div>}
      <label className="block text-sm" htmlFor="award-message-due">Send no earlier than ({award.timezone || 'UTC'})</label>
      <TimezoneAwareDateTimeInput id="award-message-due" value={dueAt} tz={award.timezone || 'UTC'} strict pendingLocalValue={dueMeta?.localValue} onChange={(value, meta) => { setDueAt(value); setDueMeta(meta || null); }} />
      {external && <div className="space-y-2"><label className="block text-sm" htmlFor="award-message-expiry">Explicit external certificate link expiry ({award.timezone || 'UTC'})</label><TimezoneAwareDateTimeInput id="award-message-expiry" value={linkExpiresAt} tz={award.timezone || 'UTC'} strict pendingLocalValue={expiryMeta?.localValue} onChange={(value, meta) => { setLinkExpiresAt(value); setExpiryMeta(meta || null); }} /><p className="awards-help">Must be after sending and no more than 30 days from now. The server creates the private credential; its raw token is never displayed here.</p></div>}
      {dateError && (dueAt || dueMeta || category) && <p role="alert" className="text-sm text-amber-800">{dateError}</p>}
      {exactRetry && Date.parse(dueAt) <= clock && <p role="alert" className="text-sm text-amber-800">The original due time has passed. An identical retry can confirm an existing delivery; if the first request never committed, it may create a message eligible for processing now. It is never automatically retimed.</p>}
      <label className="block text-sm">Scheduling reason<Textarea required maxLength={20000} value={reason} onChange={e => setReason(e.target.value)} /></label>
      {!resourcesReady && category && <p role="status" className="awards-help">This category requires complete, successfully loaded recipient/decision choices. Retry the affected data source above.</p>}
      <Button type="button" disabled={!valid || blocked || busy || disabled} onClick={review}>Review scheduling intent…</Button>
    </fieldset>
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !pending.current) setConfirmation(null); }}><DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Confirm scheduled communication</DialogTitle><DialogDescription>No send until the due time and a fresh authority check. This queues one intent; it does not approve, publish or release anything.</DialogDescription></DialogHeader>
      {confirmation && <div className="text-sm space-y-3 break-words"><p className="font-semibold">{messageLabel(confirmation.payload.category)}</p><p>{confirmation.label}</p>{confirmation.outcome && <p>Approved outcome: {confirmation.outcome}</p>}{confirmation.shortlist && <p>{confirmation.shortlist}</p>}<p>Due: {messageTime(confirmation.payload.dueAt, award.timezone)}</p><p className="awards-help">Exact send-time timestamp: {confirmation.payload.dueAt}</p>{confirmation.external && <p>External certificate link expires: {messageTime(confirmation.payload.linkExpiresAt, award.timezone)} · {confirmation.payload.linkExpiresAt}</p>}{confirmation.payload.issueId && <p>Certificate issue: {confirmation.payload.issueId}</p>}<p>Currently configured source: {confirmation.template}. Active settings/template and authority are rechecked before dispatch; this is not an immutable email-body snapshot.</p><p className="whitespace-pre-wrap">Reason: {confirmation.payload.reason}</p><p className="awards-help">Stable scheduling request: {confirmation.payload.requestId}. Retrying this exact intent retains this ID.</p>{Date.parse(confirmation.payload.dueAt) <= clock && <p className="text-amber-800">This due time has passed. An idempotent retry may confirm an existing record or queue for processing now if no record exists.</p>}</div>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{confirmation && confirmation.configurationSignature !== configSignature && <p role="alert" className="text-sm text-amber-800">Saved category settings changed. Close and review the current settings before confirming again.</p>}
      {confirmation && !valid && <p role="alert" className="text-sm text-amber-800">Current choices or timing are no longer ready for this intent. Close the dialog to review the retained fields and current records; no automatic rebase or send occurs.</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>Close (keep intent)</Button><Button type="button" disabled={!valid || busy || blocked || disabled || !resourcesReady || !categoryEnabled || confirmation?.configurationSignature !== configSignature} onClick={schedule}>{busy ? 'Recording scheduling intent…' : 'Confirm scheduling intent'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
