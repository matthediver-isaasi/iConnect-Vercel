import { useEffect, useRef, useState } from 'react';
import { validateCriteria } from '../../../../api/_lib/assessment/scoring.js';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { TimezoneAwareDateTimeInput } from '@/components/events/TimezoneAwareDateTimeInput';
import { copyTemplateDefinition, sameTemplateDefinition } from './useScoringTemplates';
import { roundAdminRequest } from './useRoundAdministration';

const allowed = state => ['draft', 'judging', 'moderation'].includes(state);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export default function CriteriaRevisionControls({ round, timezone, tenant, disabled, CriteriaEditor, refreshCriteria, onRoundChange, onChanged, onDirtyChange, onBusyChange, onUncertainChange }) {
  const [base, setBase] = useState(null), [definition, setDefinition] = useState(null);
  const [deadline, setDeadline] = useState(''), [dateMeta, setDateMeta] = useState(null);
  const [reason, setReason] = useState(''), [proposal, setProposal] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false), [reconciledAcknowledged, setReconciledAcknowledged] = useState(false);
  const [reconciled, setReconciled] = useState(false), [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(false), attempted = useRef(false), callbacks = useRef({});
  callbacks.current = { refreshCriteria, onRoundChange, onChanged, onDirtyChange, onBusyChange, onUncertainChange };
  const dirty = (!!base && !confirmed) || blocked;
  const stale = !!base && (base.round.version !== round.version || base.round.state !== round.state);
  const changed = !!base && !!definition && !sameTemplateDefinition(definition, base.criteria.definition);
  const dateError = dateMeta?.error || (!deadline || !/(Z|[+-]\d{2}:\d{2})$/.test(deadline) || !Number.isFinite(Date.parse(deadline))
    ? 'Select a valid deadline with an explicit timezone.' : Date.parse(deadline) <= Date.now() ? 'The new deadline must be in the future.' : '');
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { callbacks.current.onUncertainChange(blocked); }, [blocked]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  const reconcile = async () => {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); setError(''); setProposal(null); setAcknowledged(false);
    try {
      const fresh = await callbacks.current.refreshCriteria();
      tenant.assertCurrent();
      await callbacks.current.onChanged();
      tenant.assertCurrent();
      if (!alive.current) return;
      setBase(fresh); setBlocked(false); setReconciledAcknowledged(false); setReconciled(true);
      setNotice(confirmed
        ? `Criteria revision ${confirmed.criteriaVersionId} was confirmed for ${confirmed.affectedAssignments} assignments. Current metadata, criteria and permitted assignment views are now refreshed. Do not repeat the operation.`
        : attempted.current
          ? 'Server criteria and versions reloaded. An earlier request may have committed; unchanged metadata is not proof of failure. Compare the saved rubric below. A matching rubric cannot be resubmitted. Any further action needs renewed acknowledgement and confirmation against this exact current version.'
          : 'Current round and rubric reloaded. Your separate criteria draft, reason and proposed deadline were retained. Review changes before confirming.');
    } catch (failure) {
      if (alive.current) { setError(failure.message); setBlocked(true); }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const reset = () => {
    if (pending.current || disabled || blocked) return;
    if (!confirmed && !window.confirm('Discard only this separate authorised criteria-revision draft, reason and proposed deadline? Other settings and criteria/template drafts are unchanged.')) return;
    setBase(null); setDefinition(null); setDeadline(''); setDateMeta(null); setReason(''); setProposal(null);
    setAcknowledged(false); setReconciled(false); setReconciledAcknowledged(false); setConfirmed(null);
    setError(''); setNotice(''); attempted.current = false;
  };
  return <section className="border-t mt-6 pt-5 space-y-4" aria-labelledby="authorised-criteria-title">
    <div><p className="awards-kicker">Configure capability · separate versioned operation</p><h3 id="authorised-criteria-title" className="font-semibold mt-1">Authorised rubric correction</h3></div>
    <p className="text-sm">This does not unlock the original criteria editor. It creates a new criteria version and adopts it for every round assignment, including inactive assignments. Every assignment receives an empty reopened assessment. Earlier draft/submitted answers remain immutable history and are NOT copied into the new assessment. Assignment states and conflicts are preserved.</p>
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm space-y-2">
      <p>Reopen downstream decisions explicitly in reverse dependency order first: retract protected publications where required, reopen outcomes, reopen shortlist decisions, then reopen proposed/approved moderation. This operation never performs those actions, approves decisions, publishes results or sends mail.</p>
      <p>A closed round must first be explicitly reopened through Round lifecycle &amp; deadline. A non-draft revision returns the round to judging; a draft round stays draft. A new future deadline and policy acknowledgement are required.</p>
      <p>If a protected decision has no authorised explicit reopen action available, stop: this revision remains blocked. Never approve or release a decision merely to work around that guard.</p>
    </div>
    {!base ? <>
      {!allowed(round.state) && <p className="awards-help">Current state: {round.state}. Reopen a closed round using the separate lifecycle controls before starting this revision.</p>}
      <Button type="button" variant="outline" disabled={disabled || busy || !allowed(round.state)} onClick={async () => {
        if (pending.current || disabled) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        try {
          const fresh = await callbacks.current.refreshCriteria(); tenant.assertCurrent();
          if (!allowed(fresh.round.state)) throw new Error('The current round must be explicitly reopened before starting a criteria revision.');
          if (!alive.current) return;
          setBase(fresh); setDefinition(copyTemplateDefinition(fresh.criteria.definition));
          setDeadline(''); setDateMeta(null); setReason(''); setConfirmed(null); attempted.current = false;
          setAcknowledged(false); setReconciledAcknowledged(false); setReconciled(false); setBlocked(false);
        } catch (failure) { if (alive.current) setError(failure.message); }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      }}>{busy ? 'Loading saved rubric…' : 'Prepare a separate authorised criteria revision…'}</Button>
    </> : <>
      <p className="awards-help">Basis: saved rubric revision {base.criteria.revision} · round version {base.round.version} · state {base.round.state}. Original settings/template drafts elsewhere remain unchanged.</p>
      <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Inspect the currently loaded saved rubric before replacing it</summary><div className="mt-4"><CriteriaEditor definition={base.criteria.definition} readOnly disabled idPrefix="criteria-revision-saved" legend={`Saved criteria revision ${base.criteria.revision}`} /></div></details>
      {confirmed && <p role="status" className="text-sm rounded-lg border p-4">Server confirmed criteria version {confirmed.criteriaVersionId}; {confirmed.affectedAssignments} assignments affected, including inactive assignments. Earlier answers remain history; no answers were copied. No publication or messages were triggered.</p>}
      <form className="space-y-5" onSubmit={event => {
        event.preventDefault();
        if (pending.current || disabled || blocked || stale || confirmed || !allowed(round.state) || !changed || !reason.trim() || dateError || (reconciled && !reconciledAcknowledged)) return;
        try {
          tenant.assertCurrent(); validateCriteria(definition);
          if (Date.parse(deadline) <= Date.now()) throw new Error('The proposed deadline has expired. Choose a new future deadline explicitly.');
          setProposal({ roundId: round.id, version: base.round.version, definition: copyTemplateDefinition(definition), closesAt: deadline, reason: reason.trim(), state: base.round.state });
          setAcknowledged(false); setError('');
        } catch (failure) { setError(failure.message); }
      }}>
        <CriteriaEditor definition={definition} onChange={setDefinition} disabled={disabled || busy || !!confirmed || !!proposal} idPrefix="authorised-criteria-revision" legend="Separate replacement rubric draft" />
        <fieldset className="space-y-4" disabled={disabled || busy || !!confirmed || !!proposal}>
          <div className="awards-field"><Label htmlFor="criteria-revision-deadline">Explicit new future deadline ({timezone})</Label><TimezoneAwareDateTimeInput id="criteria-revision-deadline" value={deadline} tz={timezone} strict pendingLocalValue={dateMeta?.localValue} onChange={(iso, meta) => { setDeadline(iso); setDateMeta(meta); }} /><p className="awards-help">No deadline is automatically selected or extended. Stored timestamp: {deadline || 'not chosen'}.</p>{dateError && <p className="awards-help">{dateError}</p>}</div>
          <div className="awards-field"><Label htmlFor="criteria-revision-reason">Authorisation and correction reason (required)</Label><Textarea id="criteria-revision-reason" required maxLength={20000} rows={4} value={reason} onChange={event => setReason(event.target.value)} /></div>
          {reconciled && <label className="flex gap-3 text-sm"><input type="checkbox" checked={reconciledAcknowledged} onChange={event => setReconciledAcknowledged(event.target.checked)} /><span>I have compared the currently loaded saved rubric and round version. This is a separately authorised confirmation, not a blind retry of an uncertain request.</span></label>}
        </fieldset>
        {!changed && !confirmed && <p className="awards-help">This draft matches the currently loaded rubric. Nothing will be resubmitted; deadline-only changes use lifecycle controls.</p>}
        {(blocked || stale) && <p role="alert" className="text-sm text-amber-900">Reload criteria and versions before another confirmation. Your edited rubric, reason and proposed deadline are retained. No request is automatically retried.</p>}
        {!allowed(round.state) && <p className="awards-help">Reopen the round through its separate lifecycle controls, then reconcile this retained draft.</p>}
        <div className="flex flex-wrap gap-3">
          {!confirmed && <Button type="submit" disabled={disabled || busy || blocked || stale || !allowed(round.state) || !changed || !reason.trim() || !!dateError || (reconciled && !reconciledAcknowledged)}>Review complete revision impact…</Button>}
          <Button type="button" variant="outline" disabled={disabled || busy} onClick={reconcile}>Reconcile current rubric &amp; versions (keep draft)</Button>
          <Button type="button" variant="outline" disabled={disabled || busy || blocked} onClick={reset}>{confirmed ? 'Close confirmed revision' : 'Discard this separate revision draft…'}</Button>
        </div>
      </form>
    </>}
    {error && <p role="alert" className="text-sm text-red-800">{error} {base ? 'Edited definition, reason and deadline are retained.' : 'No revision has been submitted.'}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <Dialog open={!!proposal} onOpenChange={open => { if (!open && !pending.current) { setProposal(null); setAcknowledged(false); } }}>
      <DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Authorise reassessment of every assignment?</DialogTitle><DialogDescription>This is not an unlock or an amendment to old assessments. It creates a separate immutable rubric version and empty reopened assessments across this entire round.</DialogDescription></DialogHeader>
        {proposal && <form className="space-y-4" onSubmit={async event => {
          event.preventDefault();
          if (pending.current || disabled || !acknowledged || blocked || confirmed || round.version !== proposal.version || round.state !== proposal.state || !allowed(round.state)) return;
          try {
            validateCriteria(proposal.definition);
            if (!/(Z|[+-]\d{2}:\d{2})$/.test(proposal.closesAt) || !Number.isFinite(Date.parse(proposal.closesAt)) || Date.parse(proposal.closesAt) <= Date.now()) throw new Error('This deadline is no longer valid and future. Return to the draft and choose a deadline explicitly.');
          } catch (failure) { setError(failure.message); return; }
          pending.current = true; setBusy(true); setError(''); setNotice(''); attempted.current = true;
          let saved = null;
          try {
            const { state: expectedState, ...payload } = proposal;
            const result = await roundAdminRequest(tenant, '/api/awards/criteria-revision', { body: payload });
            if (result.round?.id !== proposal.roundId || !Number.isSafeInteger(result.round.version) || result.round.version <= proposal.version
              || result.round.state !== (expectedState === 'draft' ? 'draft' : 'judging')
              || Date.parse(result.round.closes_at) !== Date.parse(proposal.closesAt)
              || !uuid.test(result.criteriaVersionId || '') || !Number.isSafeInteger(result.affectedAssignments) || result.affectedAssignments < 0) throw new Error('The exact criteria revision outcome could not be verified.');
            saved = result; tenant.assertCurrent();
            if (!alive.current) return;
            setConfirmed(result); setProposal(null); setAcknowledged(false); setBlocked(true);
            callbacks.current.onRoundChange(result.round);
            const fresh = await callbacks.current.refreshCriteria(); tenant.assertCurrent();
            if (fresh.criteria.id !== result.criteriaVersionId || !sameTemplateDefinition(fresh.criteria.definition, payload.definition)) throw new Error('The confirmed revision is not the current loaded rubric. Review current metadata before any further administration.');
            await callbacks.current.onChanged(); tenant.assertCurrent();
            if (alive.current) { setBase(fresh); setBlocked(false); setNotice('Criteria, round metadata and permitted assignment views refreshed. Unrelated settings and template drafts were retained.'); }
          } catch (failure) {
            if (alive.current) {
              setBlocked(true); setProposal(null); setAcknowledged(false);
              setError(saved ? `The server confirmed criteria version ${saved.criteriaVersionId} for ${saved.affectedAssignments} assignments, but refresh/reconciliation failed: ${failure.message}. Do not repeat the mutation.`
                : `${failure.message} The request may have committed. Reconcile current criteria and versions before any new explicit confirmation.`);
            }
          } finally { pending.current = false; if (alive.current) setBusy(false); }
        }}>
          <p className="text-sm">Round: {round.name} · expected version {proposal.version}. Deadline: {proposal.closesAt}. New state: {proposal.state === 'draft' ? 'draft' : 'judging'}.</p>
          <ul className="text-sm list-disc pl-5 space-y-2"><li>All round assignments adopt this rubric, including inactive/removed/recused assignments.</li><li>All receive empty reopened assessments; earlier answers stay immutable history, never copied.</li><li>States and conflicts are not cleared or restored. Prior scores cannot stand in for reassessment against the new rubric.</li><li>Downstream outcomes, shortlist decisions and moderation must already have been explicitly reopened in reverse dependency order. The server checks this again.</li></ul>
          <p className="text-sm whitespace-pre-wrap break-words">Authorisation reason: {proposal.reason}</p>
          <label className="flex gap-3 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /><span>I am authorised to correct this scoring policy and acknowledge the full reassessment impact, retained immutable history, explicit future deadline and separate downstream reopening requirements.</span></label>
          {round.version !== proposal.version && <p role="alert" className="text-sm text-red-800">The round version changed. Return to the draft and reconcile; no revision can be submitted from this confirmation.</p>}
          {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { setProposal(null); setAcknowledged(false); }}>Return to retained draft</Button><Button type="submit" disabled={disabled || busy || !acknowledged || round.version !== proposal.version || round.state !== proposal.state || blocked}>{busy ? 'Awaiting server confirmation…' : 'Authorise new rubric & empty reassessments'}</Button></DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
  </section>;
}
