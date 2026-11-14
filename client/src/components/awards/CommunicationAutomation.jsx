import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { automaticMessageCategories, immediateAutomaticCategories, communicationRequest, communicationConfigurationDto, validCommunicationConfiguration, messageLabel } from './useAwardCommunications';

const cutoffLabel = value => value ? `${new Date(value).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC (${value})` : 'No enable-time cutoff recorded';
const snapshot = row => validCommunicationConfiguration(row) ? JSON.stringify(communicationConfigurationDto(row)) : '';

export default function CommunicationAutomation(props) {
  if (!automaticMessageCategories.includes(props.category)) return null;
  return <AutomaticPolicy key={`${props.tenant.scopeKey}:${props.awardId}:${props.category}`} {...props} />;
}

function AutomaticPolicy({ tenant, awardId, category, configuration, ordinaryDirty, ready, disabled, reload, onConfirmed, onDirtyChange, onBusyChange, onUncertainChange }) {
  const [base, setBase] = useState(null), [intent, setIntent] = useState(null), [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState(null), [acknowledged, setAcknowledged] = useState(false);
  const [reconciled, setReconciled] = useState(false), [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [completed, setCompleted] = useState(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(false), attempted = useRef(false), callbacks = useRef({});
  callbacks.current = { reload, onConfirmed, onDirtyChange, onBusyChange, onUncertainChange };
  const immediate = immediateAutomaticCategories.includes(category);
  const validSaved = validCommunicationConfiguration(configuration);
  const currentReady = ready && validSaved;
  const stale = !!base && snapshot(base) !== snapshot(configuration);
  const offset = immediate ? 0 : Number(intent?.offset);
  const validOffset = immediate || (!!intent && String(intent.offset).trim() !== '' && Number.isSafeInteger(offset) && offset >= 0 && offset <= 525600);
  const changed = !!intent && !!base && (intent.automatic !== base.automatic || (!immediate && offset !== base.offset_minutes));
  const dirty = (!!intent && !completed) || (blocked && attempted.current);
  const canReview = currentReady && !disabled && !busy && !blocked && !completed && !ordinaryDirty && !!intent && !stale && changed && validOffset
    && !!reason.trim() && reason.length <= 2000 && (!reconciled || reviewed);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { callbacks.current.onUncertainChange(blocked); }, [blocked]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); callbacks.current.onUncertainChange(false); };
  }, []);
  const reconcile = async () => {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); setError(''); setConfirmation(null); setAcknowledged(false);
    try {
      const fresh = await callbacks.current.reload(); tenant.assertCurrent();
      const row = fresh?.configurations.find(item => item.category === category);
      if (!validCommunicationConfiguration(row)) throw new Error('Save/read an ordinary message configuration before changing automatic creation.');
      if (!alive.current) return;
      if (intent) setBase(communicationConfigurationDto(row));
      setBlocked(false); setReconciled(true); setReviewed(false);
      setNotice(completed
        ? 'The prior policy write was confirmed and is not being repeated. Current saved configuration reloaded; your other category and manual scheduling drafts remain unchanged.'
        : 'Saved policy and optimistic version re-read. Your automatic-policy choices and reason were retained. Review the saved policy, acknowledge it below, then explicitly confirm only if a change remains. A matching policy does not establish that an earlier reason was recorded.');
    } catch (failure) { if (alive.current) { setBlocked(true); setError(failure.message); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const reset = () => {
    if (pending.current || disabled || blocked) return;
    if (!completed && !window.confirm('Discard only this category’s automatic-policy choices and reason? Ordinary template/enabled settings and manual scheduling drafts are not changed.')) return;
    setIntent(null); setBase(null); setReason(''); setConfirmation(null); setAcknowledged(false); setCompleted(null);
    setReconciled(false); setReviewed(false); setError(''); setNotice(''); attempted.current = false;
  };
  return <section className="rounded-lg border p-4 mt-4 space-y-4">
    <div><h4 className="font-semibold text-sm">Automatic creation policy</h4><p className="awards-help mt-2">Separate from message delivery enablement and manual scheduling. Automatic creation defaults OFF.</p></div>
    {!configuration ? <p className="awards-help">No saved configuration exists. Save the ordinary template/enabled settings above first, even when keeping the built-in source. This does not enable automatic creation.</p>
      : !validSaved ? <p role="alert" className="text-sm text-red-700">The saved automatic policy is unreadable. Re-read before any write; no default is substituted.</p>
        : <div className="space-y-1 awards-help"><p>Saved automatic creation: {configuration.automatic ? 'ON' : 'OFF'} · configuration version {configuration.version}. Delivery setting: {configuration.enabled ? 'enabled' : 'disabled'}.</p>
          <p>{immediate ? 'Event-triggered category: offset is ignored; this operation always sends offsetMinutes = 0.' : `Saved timing: ${configuration.offset_minutes} minutes before the closing deadline${category === 'judge_invitation_reminder' ? ' / invitation expiry' : ''}.`}</p>
          <p>{configuration.automatic ? 'Eligibility cutoff (automatic_since)' : 'Last recorded enable-time cutoff (automatic_since; policy currently OFF)'}: {cutoffLabel(configuration.automatic_since)}.</p>
        </div>}
    <p className="text-sm">{category === 'application_confirmation' ? 'New application receipt makes an eligible confirmation available for queueing, with offset 0.' : category === 'moderation_invitation' ? 'An eligible moderation invitation becomes available for queueing when its round enters moderation, with offset 0.' : `Deadline reminders use minutes before ${category === 'judge_invitation_reminder' ? 'invitation expiry (or the server’s available expiry/closing deadline)' : 'the closing deadline'}. Zero means at the deadline, not “send now”.`}</p>
    <p className="awards-help">No backfill: only applications or appointments created after the server-recorded automatic_since cutoff when automatic creation is enabled are eligible. Enabling again records a new cutoff. Eligibility and authority are rechecked by the server; saving a policy is not confirmation that a message was queued or delivered.</p>
    <p className="text-sm rounded-lg border p-3">Changing timing or switching automatic creation OFF does NOT rewrite or cancel messages already scheduled. The separate ordinary enabled=false setting blocks delivery. Delivery cancellation controls are separate and are not implemented here. Underlying deadline changes cancel stale automatic-deadline messages and allow a new schedule; this is different from changing the offset.</p>
    {ordinaryDirty && <p role="alert" className="awards-help">Save or explicitly discard this category’s ordinary template/enabled draft first. Automatic-policy inputs are retained and do not silently apply unsaved message settings.</p>}
    {!intent ? <Button type="button" size="sm" variant="outline" disabled={!currentReady || disabled || busy || blocked || ordinaryDirty} onClick={() => {
      if (!currentReady || disabled || blocked || ordinaryDirty) return;
      tenant.assertCurrent(); setBase(communicationConfigurationDto(configuration));
      setIntent({ automatic: configuration.automatic, offset: String(immediate ? 0 : configuration.offset_minutes) });
      setReason(''); setCompleted(null); setReconciled(false); setReviewed(false); setError(''); setNotice(''); attempted.current = false;
    }}>Edit automatic creation policy…</Button> : <>
      <fieldset disabled={disabled || busy || !!confirmation || !!completed} className="space-y-4">
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={intent.automatic} onChange={event => setIntent(old => ({ ...old, automatic: event.target.checked }))} /><span>Automatically create newly eligible {messageLabel(category).toLowerCase()} messages</span></label>
        {!immediate && <div className="awards-field"><Label htmlFor={`automatic-offset-${category}`}>Minutes before closing / expiry (0–525600)</Label><Input id={`automatic-offset-${category}`} type="number" min="0" max="525600" step="1" value={intent.offset} onChange={event => setIntent(old => ({ ...old, offset: event.target.value }))} />{!validOffset && <p className="text-sm text-red-700">Enter a whole number from 0 to 525600.</p>}</div>}
        <div className="awards-field"><Label htmlFor={`automatic-reason-${category}`}>Automatic-policy change reason (required)</Label><Textarea id={`automatic-reason-${category}`} required maxLength={2000} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></div>
        {reconciled && <label className="flex gap-3 text-sm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>I reviewed the current saved policy/version above and am explicitly confirming a new change, not blindly reapplying an uncertain write.</span></label>}
      </fieldset>
      {stale && !completed && <p role="alert" className="text-sm text-amber-900">This configuration changed after the automatic draft opened. Re-read and review its current version; your automatic choices and reason will be retained.</p>}
      {!changed && !completed && <p className="awards-help">The draft matches the last reviewed saved policy. No identical policy will be reapplied. Current policy alone does not prove a previous reason was recorded.</p>}
      <div className="flex flex-wrap gap-2">{!completed && <Button type="button" size="sm" disabled={!canReview} onClick={() => {
        if (!canReview) return;
        setConfirmation({ payload: { command: 'automation', awardId, category, version: base.version, automatic: intent.automatic, offsetMinutes: offset, reason: reason.trim() }, base: communicationConfigurationDto(base) });
        setAcknowledged(false); setError('');
      }}>Review automatic creation change…</Button>}<Button type="button" size="sm" variant="outline" disabled={disabled || busy || blocked} onClick={reset}>{completed ? 'Close confirmed policy change' : 'Discard only automatic-policy draft…'}</Button></div>
    </>}
    {(intent || blocked) && <Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={reconcile}>Re-read policy/version (keep automatic draft &amp; reason)</Button>}
    {blocked && <p role="alert" className="text-sm text-amber-900">Further configuration writes require an explicit re-read. Nothing is retried or rebased into a write automatically.</p>}
    {completed && <p role="status" className="text-sm">Server confirmed automatic creation {completed.automatic ? 'ON' : 'OFF'} at configuration version {completed.version}. No queue/delivery status is inferred. Review the saved cutoff above; previously scheduled messages were not rewritten.</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{notice && <p role="status" className="awards-help">{notice}</p>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !pending.current) { setConfirmation(null); setAcknowledged(false); } }}>
      <DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Confirm automatic creation policy</DialogTitle><DialogDescription>This changes future automatic message creation only. Ordinary delivery enablement, template selection, manual scheduling intents and existing scheduled messages are not changed.</DialogDescription></DialogHeader>
        {confirmation && <div className="space-y-4 text-sm">
          <p>{messageLabel(category)} · expected configuration version {confirmation.payload.version}.</p>
          <p className="font-semibold">Automatic creation: {confirmation.payload.automatic ? 'ON' : 'OFF'}. {immediate ? 'Event-triggered, offset 0.' : `${confirmation.payload.offsetMinutes} minutes before the relevant deadline.`}</p>
          <p>Saved delivery is {confirmation.base.enabled ? 'enabled' : 'disabled'}. This operation will not change it. No backfill: only eligible applications/appointments created after the server’s enable-time cutoff can be automatically scheduled.</p>
          <p>Timing changes or switching automatic creation OFF leave already scheduled messages unchanged. Use the separate ordinary enabled=false setting to block delivery; this is not a cancellation action. New underlying deadlines invalidate stale automatic-deadline schedules and may permit a replacement schedule.</p>
          <p className="whitespace-pre-wrap break-words">Reason: {confirmation.payload.reason}</p>
          <label className="flex items-start gap-3"><input type="checkbox" checked={acknowledged} disabled={busy || disabled} onChange={event => setAcknowledged(event.target.checked)} /><span>I explicitly approve this automatic creation policy and understand the cutoff, no-backfill and already-scheduled-message rules.</span></label>
          {(!currentReady || stale || ordinaryDirty) && <p role="alert" className="text-red-700">Current saved configuration no longer authorises this exact confirmation. Return to the retained draft and re-read.</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { setConfirmation(null); setAcknowledged(false); }}>Return (keep drafts)</Button><Button type="button" disabled={!acknowledged || !canReview || !confirmation || snapshot(configuration) !== snapshot(confirmation.base)} onClick={async () => {
            if (pending.current || !acknowledged || !canReview || snapshot(configuration) !== snapshot(confirmation.base)) return;
            pending.current = true; attempted.current = true; setBusy(true); setError(''); setNotice('');
            let saved = null;
            try {
              const result = await communicationRequest(tenant, '/api/awards/communications', { body: confirmation.payload });
              if (!validCommunicationConfiguration(result) || result.id !== confirmation.base.id || result.category !== category
                || result.version !== confirmation.payload.version + 1 || result.automatic !== confirmation.payload.automatic || result.offset_minutes !== confirmation.payload.offsetMinutes
                || result.enabled !== confirmation.base.enabled || result.email_template_id !== confirmation.base.email_template_id) throw new Error('The server did not confirm the exact policy/version while preserving ordinary settings.');
              saved = communicationConfigurationDto(result); tenant.assertCurrent();
              if (!alive.current) return;
              setCompleted(saved); setConfirmation(null); setAcknowledged(false); setBlocked(true);
              callbacks.current.onConfirmed(saved);
              await callbacks.current.reload(); tenant.assertCurrent();
              if (alive.current) { setBlocked(false); setNotice('Policy confirmed and saved choices refreshed. Ordinary category drafts and manual scheduling intent/request IDs were not reset.'); }
            } catch (failure) {
              if (alive.current) {
                setBlocked(true); setConfirmation(null); setAcknowledged(false);
                setError(saved ? `Policy version ${saved.version} was confirmed, but refreshing failed: ${failure.message}. Re-read; do not repeat the write.`
                  : `${failure.message} The result is unconfirmed and may have committed. Choices and reason are retained. Re-read before any new explicit confirmation; no automatic retry occurs.`);
              }
            } finally { pending.current = false; if (alive.current) setBusy(false); }
          }}>{busy ? 'Awaiting policy confirmation…' : 'Confirm automatic creation policy'}</Button></DialogFooter>
        </div>}
      </DialogContent>
    </Dialog>
  </section>;
}
