import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { TimezoneAwareDateTimeInput } from '@/components/events/TimezoneAwareDateTimeInput';
import { roundAdminRequest } from './useRoundAdministration';

const actionsFor = state => state === 'judging'
  ? [['moderation', 'Move to moderation'], ['closed', 'Close round'], ['judging', 'Extend judging deadline']]
  : state === 'moderation' ? [['judging', 'Reopen judging'], ['closed', 'Close round']]
    : state === 'closed' ? [['judging', 'Reopen judging']] : [];

export default function RoundLifecycleControls({
  round, timezone, tenant, canEdit, disabled, editorDirty, onRoundChange, refreshRound,
  onChanged, onDirtyChange, onBusyChange, onUncertainChange,
}) {
  const [proposal, setProposal] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deadline, setDeadline] = useState('');
  const [dateMeta, setDateMeta] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [clock, setClock] = useState(Date.now);
  const pending = useRef(false), alive = useRef(false), callbacks = useRef({});
  callbacks.current = { onRoundChange, refreshRound, onChanged, onDirtyChange, onBusyChange, onUncertainChange };
  const dirty = !!proposal;
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => {
      alive.current = false; window.clearInterval(timer);
      callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false);
    };
  }, []);
  const stale = !!proposal && (proposal.base.version !== round.version || proposal.base.state !== round.state);
  const action = proposal && actionsFor(proposal.base.state).find(([target]) => target === proposal.target);
  const judging = proposal?.target === 'judging';
  const extension = judging && proposal.base.state === 'judging';
  let dateError = '';
  if (judging) {
    if (dateMeta?.error || dateMeta?.localValue !== undefined || !deadline
      || !/(Z|[+-]\d{2}:\d{2})$/.test(deadline) || !Number.isFinite(Date.parse(deadline))) dateError = 'Choose a resolved deadline with an explicit timezone.';
    else if (Date.parse(deadline) <= clock) dateError = 'The deadline must be in the future. Expired dates are never reset automatically.';
    else if (!proposal.base.opens_at || !Number.isFinite(Date.parse(proposal.base.opens_at))
      || Date.parse(deadline) <= Date.parse(proposal.base.opens_at)) dateError = 'The round needs a saved opening time before the proposed deadline.';
    else if (extension && proposal.base.closes_at && Date.parse(deadline) <= Date.parse(proposal.base.closes_at)) dateError = 'An extension must be later than the current saved deadline.';
  }
  const close = () => {
    if (!pending.current) setDialogOpen(false);
  };
  const discard = () => {
    if (pending.current || disabled || !window.confirm('Discard this retained lifecycle choice, reason and proposed deadline? This does not undo any server action or change saved settings and criteria.')) return;
    setProposal(null); setDialogOpen(false); setReason(''); setDeadline(''); setDateMeta(null);
  };
  const open = target => {
    if (!canEdit || disabled || pending.current) return;
    if (proposal?.target === target) { setDialogOpen(true); return; }
    if (proposal && !window.confirm('Replace the retained lifecycle choice and discard its reason and proposed deadline? Saved settings and criteria are unchanged.')) return;
    setProposal({ base: { ...round }, target }); setDeadline(round.closes_at || '');
    setDialogOpen(true); setDateMeta(null); setReason(''); setError(''); setNotice(''); setClock(Date.now());
  };
  const reload = async () => {
    if (!canEdit || disabled || pending.current) return;
    pending.current = true; setBusy(true); callbacks.current.onBusyChange(true);
    try {
      tenant.assertCurrent();
      const fresh = await callbacks.current.refreshRound();
      tenant.assertCurrent();
      if (!alive.current) return;
      if (fresh.id !== round.id || !Number.isSafeInteger(fresh.version)) throw new Error('The current round could not be verified.');
      setProposal(old => old ? { ...old, base: { ...fresh } } : old);
      setBlocked(false); setError(''); setClock(Date.now());
      callbacks.current.onUncertainChange(false); callbacks.current.onChanged();
      setNotice(`Server round state “${fresh.state}”, version ${fresh.version}, loaded. Your reason and proposed date were kept. Review whether the action is still available; a previous request may already have taken effect.`);
    } catch (failure) {
      if (alive.current) { setError(failure.message); setBlocked(true); callbacks.current.onUncertainChange(true); }
    } finally {
      pending.current = false;
      if (alive.current) { setBusy(false); callbacks.current.onBusyChange(false); }
    }
  };
  const submit = async event => {
    event.preventDefault();
    if (pending.current || disabled || !canEdit || !proposal || !action || blocked || stale
      || !reason.trim() || reason.length > 20000) return;
    // Recheck the clock at click time, not just on the periodic display tick.
    if (judging && (dateError || Date.parse(deadline) <= Date.now())) {
      setClock(Date.now()); setError(dateError || 'Choose a future judging deadline.'); return;
    }
    if (!window.confirm(`${action[1]} for “${round.name}”, from state ${proposal.base.state}, expected version ${proposal.base.version}?${judging ? ` Proposed deadline: ${deadline}.` : ' The saved deadline is retained.'} This does not approve, publish or send results. Unsaved settings and criteria are not applied.`)) return;
    pending.current = true; setBusy(true); callbacks.current.onBusyChange(true); setError(''); setNotice('');
    let confirmed = false;
    try {
      const result = await roundAdminRequest(tenant, '/api/awards/lifecycle', { body: {
        roundId: proposal.base.id, version: proposal.base.version, state: proposal.target,
        closesAt: judging ? deadline : null, reason: reason.trim(),
      } });
      const saved = result?.round;
      if (saved?.id !== proposal.base.id || saved.state !== proposal.target
        || !Number.isSafeInteger(saved.version) || saved.version <= proposal.base.version
        || (judging && Date.parse(saved.closes_at) !== Date.parse(deadline))) {
        throw new Error('The server did not confirm the requested round state and deadline. Reload its current version before retrying.');
      }
      tenant.assertCurrent();
      if (!alive.current) return;
      confirmed = true;
      callbacks.current.onRoundChange(saved);
      callbacks.current.onChanged();
      callbacks.current.onUncertainChange(true);
      setNotice(`Server confirmed round state “${saved.state}” at version ${saved.version}. Configuration and criteria drafts were retained. No publication or messages were triggered.`);
      setProposal(null); setDialogOpen(false); setReason(''); setDeadline(''); setDateMeta(null);
      await callbacks.current.refreshRound();
      tenant.assertCurrent();
      if (alive.current) { setBlocked(false); callbacks.current.onUncertainChange(false); }
    } catch (failure) {
      if (alive.current) {
        setBlocked(true); callbacks.current.onUncertainChange(true); callbacks.current.onChanged();
        setError(confirmed
          ? `The transition was confirmed, but refreshing the latest round failed: ${failure.message}. Reload metadata; do not repeat the transition.`
          : `${failure.message} The outcome is not confirmed. Your reason and date are retained. Reload metadata before another attempt.`);
      }
    } finally {
      pending.current = false;
      if (alive.current) { setBusy(false); callbacks.current.onBusyChange(false); }
    }
  };
  if (!canEdit) return null;
  const serverDeadline = round.closes_at && Number.isFinite(Date.parse(round.closes_at))
    ? `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(round.closes_at))} UTC`
    : round.closes_at ? 'Deadline unavailable' : 'No deadline saved';
  return <section className="mt-6 space-y-4 border-t pt-5" aria-labelledby="round-lifecycle-title">
    <div><h3 id="round-lifecycle-title" className="font-semibold">Round lifecycle & deadline</h3>
      <p className="awards-help mt-2">Current server state: {round.state} · version {round.version} · deadline: {serverDeadline}.</p>
      <p className="awards-help mt-2">Transitions use saved assessments and rules, never unsaved editor changes. Moving to moderation checks completed assessment counts. Closing also checks mandatory approved moderation. Reopening does not reopen submitted assessments or approve outcomes.</p>
    </div>
    {editorDirty && <p className="awards-help">Unsaved settings, criteria or reusable-template choices remain in this editor; a lifecycle action does not save or discard them.</p>}
    <div className="flex flex-wrap gap-2">{actionsFor(round.state).map(([state, label]) => <Button key={state} type="button" size="sm" variant="outline" disabled={disabled || busy || blocked} onClick={() => open(state)}>{label}…</Button>)}
      <Button type="button" size="sm" variant="outline" disabled={disabled || busy} onClick={reload}>{busy ? 'Checking round…' : 'Reload lifecycle metadata (keep drafts)'}</Button>
    </div>
    {proposal && !dialogOpen && <div className="space-y-3 rounded-lg border p-4">
      <p className="awards-help">Your lifecycle choice, reason and proposed date are retained. Closing the dialog did not submit or cancel a server request.</p>
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={() => setDialogOpen(true)}>Review retained lifecycle choice</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy || disabled} onClick={discard}>Discard retained lifecycle choice</Button></div>
    </div>}
    {round.state === 'draft' && <p className="awards-help">Draft rounds use the separate Start judging action after configuration and allocation are saved.</p>}
    {blocked && <p role="alert" className="text-sm text-amber-800">Lifecycle writes are blocked until the current server metadata has been explicitly reloaded.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <Dialog open={!!proposal && dialogOpen} onOpenChange={value => { if (!value) close(); }}>
      <DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>{action?.[1] || 'Review round lifecycle action'}</DialogTitle><DialogDescription>A reason and explicit confirmation are required. This changes the round lifecycle only; it does not change the competition stage, publish results or send mail.</DialogDescription></DialogHeader>
        {proposal && <form className="space-y-4" onSubmit={submit}>
          <p className="awards-help">Expected state: {proposal.base.state} · version {proposal.base.version}. Latest loaded state: {round.state} · version {round.version}.</p>
          {stale && <p role="alert" className="text-sm text-destructive">The round changed. Reload lifecycle metadata to reconcile this action without replacing your reason or proposed date.</p>}
          {!action && <p role="alert" className="text-sm">This target is not available from the current server state. A previous request may already have taken effect. No further request will be made.</p>}
          {judging ? <div className="awards-field">
            <Label htmlFor="round-lifecycle-deadline">Future judging deadline ({timezone})</Label>
            <TimezoneAwareDateTimeInput id="round-lifecycle-deadline" value={deadline} tz={timezone} strict
              disabled={busy || disabled} pendingLocalValue={dateMeta?.localValue}
              onChange={(iso, meta) => { setDeadline(iso); setDateMeta(meta); setClock(Date.now()); }} />
            <p className="awards-help">The existing saved date is shown initially, even if expired. Choose a future date explicitly; extending judging must move the deadline later.</p>
            {dateError && <p role="alert" className="text-sm text-destructive">{dateError}</p>}
          </div> : <p className="awards-help">The saved deadline will be retained without change.</p>}
          <div className="awards-field"><Label htmlFor="round-lifecycle-reason">Reason (required)</Label><Textarea id="round-lifecycle-reason" required maxLength={20000} rows={4} value={reason} disabled={busy || disabled} onChange={event => setReason(event.target.value)} /></div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {notice && <p role="status" className="text-sm">{notice}</p>}
          <Button type="button" variant="outline" disabled={busy || disabled} onClick={reload}>Reload lifecycle metadata (keep reason and date)</Button>
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={close}>Close (keep reason and date)</Button>
            <Button type="submit" disabled={busy || disabled || blocked || stale || !action || !reason.trim() || reason.length > 20000 || !!dateError}>{busy ? 'Saving round transition…' : 'Confirm round change'}</Button>
          </DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
  </section>;
}
