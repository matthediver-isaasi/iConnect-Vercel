import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import AppointmentManager from './AppointmentManager';
import AllocationPanel from './AllocationPanel';
import AssignmentControls from './AssignmentControls';
import RoundLifecycleControls from './RoundLifecycleControls';
import RoundPanelPolicy from './RoundPanelPolicy';
import CriteriaRevisionControls from './CriteriaRevisionControls';
import { useRoundAppointments, useRoundAssignments } from './useRoundAdministration';

export default function RoundOperations(props) {
  return <OperationsWorkspace key={`${props.tenant.scopeKey}:${props.round.id}`} {...props} />;
}

function OperationsWorkspace({ awardId, round, timezone, tenant, canAssign, canEdit, parentBusy, editorDirty, runCommand, onVersionChange, onRoundChange, onLifecycleChanged, onCriteriaChanged, onCriteriaUncertainChange, refreshRound, CriteriaEditor, refreshCriteria, onDirtyChange, onBusyChange }) {
  const appointmentsQuery = useRoundAppointments(tenant, round.id, canAssign);
  const assignmentsQuery = useRoundAssignments(tenant, round.id, canAssign);
  const [labels, setLabels] = useState({});
  const [appointmentDirty, setAppointmentDirty] = useState(false);
  const [allocationDirty, setAllocationDirty] = useState(false);
  const [appointmentBusy, setAppointmentBusy] = useState(false);
  const [allocationBusy, setAllocationBusy] = useState(false);
  const [assignmentDirty, setAssignmentDirty] = useState(false);
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [assignmentUncertain, setAssignmentUncertain] = useState(false);
  const [appointmentUncertain, setAppointmentUncertain] = useState(false);
  const [lifecycleDirty, setLifecycleDirty] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleUncertain, setLifecycleUncertain] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyUncertain, setPolicyUncertain] = useState(false);
  const [revisionDirty, setRevisionDirty] = useState(false);
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [revisionUncertain, setRevisionUncertain] = useState(false);
  const incomingParentBusy = parentBusy;
  // Other administration writes wait for a policy save/reconciliation.
  // Its own reload remains available through incomingParentBusy below.
  parentBusy = parentBusy || policyBusy || policyUncertain || revisionBusy || revisionUncertain;
  editorDirty = editorDirty || policyDirty || revisionDirty;
  const [starting, setStarting] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [reason, setReason] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ onDirtyChange, onBusyChange, onCriteriaUncertainChange });
  callbacks.current = { onDirtyChange, onBusyChange, onCriteriaUncertainChange };
  const dirty = appointmentDirty || allocationDirty || assignmentDirty || lifecycleDirty || policyDirty || revisionDirty || Boolean(reason);
  const busy = appointmentBusy || allocationBusy || assignmentBusy || lifecycleBusy || policyBusy || revisionBusy || starting || refreshing;
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { callbacks.current.onCriteriaUncertainChange?.(revisionUncertain); }, [revisionUncertain]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); callbacks.current.onCriteriaUncertainChange?.(false); };
  }, []);
  return <div className="border-t mt-6 pt-5">
    <div className="flex flex-wrap justify-between items-start gap-3"><div><p className="awards-kicker">Round administration</p><p className="awards-help mt-2">Server round version {round.version}. Appointment and allocation updates preserve your settings and criteria drafts. Allocation uses saved settings and criteria, not unsaved editor changes.</p></div>
      <Button size="sm" variant="outline" disabled={parentBusy || busy} onClick={async () => {
        if (pending.current) return;
        pending.current = true; setRefreshing(true); setError('');
        try {
          await refreshRound();
          if (canAssign) {
            const results = await Promise.all([appointmentsQuery.refetch(), assignmentsQuery.refetch()]);
            tenant.assertCurrent();
            if (results.some(result => result.error)) throw results.find(result => result.error).error;
          }
          if (mounted.current) { setUncertain(false); setAssignmentUncertain(false); setAppointmentUncertain(false); setLifecycleUncertain(false); setGeneration(value => value + 1); setNotice('Server round version and available administration records refreshed. Local settings, criteria and command drafts were retained; review them before saving.'); }
        } catch (failure) { if (mounted.current) setError(failure.message); }
        finally { pending.current = false; if (mounted.current) setRefreshing(false); }
      }}>Refresh round version (keep drafts)</Button>
    </div>
    {uncertain && <p role="alert" className="text-sm text-amber-800 mt-4">The latest allocation outcome needs reconciliation. Refresh the server round version before starting judging or generating another allocation.</p>}
    {(assignmentUncertain || appointmentUncertain) && <p role="alert" className="text-sm text-amber-800 mt-4">Assignment or appointment data needs reconciliation. Reload the affected command’s current version, or refresh the round and administration records above, before allocating or starting judging. Draft choices are retained.</p>}
    {lifecycleUncertain && <p role="alert" className="text-sm text-amber-800 mt-4">Round lifecycle data needs reconciliation before another administration write. Use lifecycle metadata reload below to keep its reason and proposed date.</p>}
    {canEdit && <RoundPanelPolicy round={round} tenant={tenant}
      disabled={incomingParentBusy || revisionBusy || revisionUncertain || appointmentBusy || allocationBusy || assignmentBusy || lifecycleBusy || lifecycleUncertain || starting || refreshing || uncertain || assignmentUncertain || appointmentUncertain}
      onRoundChange={onRoundChange} refreshRound={refreshRound} onDirtyChange={setPolicyDirty} onBusyChange={setPolicyBusy} onUncertainChange={setPolicyUncertain}
      onChanged={() => { setGeneration(value => value + 1); onLifecycleChanged(); }} />}
    {canEdit && <CriteriaRevisionControls round={round} timezone={timezone} tenant={tenant} CriteriaEditor={CriteriaEditor}
      disabled={incomingParentBusy || policyBusy || policyUncertain || appointmentBusy || allocationBusy || assignmentBusy || lifecycleBusy || lifecycleUncertain || starting || refreshing || uncertain || assignmentUncertain || appointmentUncertain}
      refreshCriteria={refreshCriteria} onRoundChange={fresh => { onRoundChange(fresh); setGeneration(value => value + 1); onCriteriaChanged(); }}
      onChanged={async () => {
        setGeneration(value => value + 1); onCriteriaChanged();
        if (canAssign) {
          const result = await assignmentsQuery.refetch(); tenant.assertCurrent();
          if (result.error || !result.data) throw result.error || new Error('The revision may be saved, but current assignment records could not be refreshed.');
        }
      }}
      onDirtyChange={setRevisionDirty} onBusyChange={setRevisionBusy} onUncertainChange={setRevisionUncertain} />}
    {canAssign && <>
      <AppointmentManager round={round} timezone={timezone} tenant={tenant} appointmentsQuery={appointmentsQuery}
        disabled={parentBusy || allocationBusy || assignmentBusy || lifecycleBusy || lifecycleUncertain || starting || refreshing} reconciliationRequired={appointmentUncertain} runCommand={runCommand} labels={labels}
        onLabelsChange={(id, label) => setLabels(old => ({ ...old, [id]: label }))} onDirtyChange={setAppointmentDirty} onBusyChange={setAppointmentBusy}
        onChanged={() => setGeneration(value => value + 1)} onUncertainChange={setAppointmentUncertain} />
      <AllocationPanel awardId={awardId} round={round} tenant={tenant} appointmentsQuery={appointmentsQuery}
        disabled={parentBusy || appointmentBusy || assignmentBusy || lifecycleBusy || lifecycleUncertain || starting || refreshing || uncertain || assignmentUncertain || appointmentUncertain} labels={labels} changeGeneration={generation}
        onVersionChange={version => { onVersionChange(version); assignmentsQuery.refetch(); }} onDirtyChange={setAllocationDirty} onBusyChange={setAllocationBusy} onUncertain={() => setUncertain(true)} />
      <AssignmentControls awardId={awardId} round={round} tenant={tenant} assignmentsQuery={assignmentsQuery} appointmentsQuery={appointmentsQuery} labels={labels}
        disabled={parentBusy || appointmentBusy || allocationBusy || lifecycleBusy || lifecycleUncertain || starting || refreshing || appointmentUncertain}
        onDirtyChange={setAssignmentDirty} onBusyChange={setAssignmentBusy} onChanged={() => setGeneration(value => value + 1)} onUncertainChange={setAssignmentUncertain} />
    </>}
    {canEdit && <RoundLifecycleControls round={round} timezone={timezone} tenant={tenant} canEdit={canEdit}
      disabled={parentBusy || appointmentBusy || allocationBusy || assignmentBusy || starting || refreshing || uncertain || assignmentUncertain || appointmentUncertain}
      editorDirty={editorDirty} onRoundChange={onRoundChange} refreshRound={refreshRound}
      onChanged={() => { setGeneration(value => value + 1); onLifecycleChanged(); }}
      onDirtyChange={setLifecycleDirty} onBusyChange={setLifecycleBusy} onUncertainChange={setLifecycleUncertain} />}
    {canEdit && round.state === 'draft' && <section className="border-t mt-6 pt-5"><h3 className="font-semibold">Start judging</h3><p className="awards-help mt-2 mb-4">Starting locks criteria and round configuration. The server checks the judging window, saved criteria and eligible assignments. This does not approve, publish or send results.</p>
      <Button disabled={parentBusy || busy || uncertain || assignmentUncertain || appointmentUncertain || lifecycleUncertain || lifecycleDirty || editorDirty || appointmentDirty || allocationDirty || assignmentDirty} onClick={() => { setReason(''); setError(''); setConfirmStart(true); }}>Start judging…</Button>
      {(editorDirty || appointmentDirty || allocationDirty || assignmentDirty) && <p className="awards-help mt-2">Save or clear settings, criteria, appointment, allocation and assignment-command drafts before starting.</p>}
    </section>}
    {error && <p role="alert" className="text-sm text-red-800 mt-4">{error} The action is not confirmed; inputs are retained.</p>}
    {notice && <p role="status" className="text-sm text-emerald-800 mt-4">{notice}</p>}
    <Dialog open={confirmStart} onOpenChange={open => { if (!open && !starting && !refreshing && (!reason || window.confirm('Discard the unsaved start reason?'))) { setConfirmStart(false); setReason(''); } }}>
      <DialogContent className="awards-workspace"><DialogHeader><DialogTitle>Start judging for this round?</DialogTitle><DialogDescription>This locks configuration and criteria for the round’s current review versions. The server rechecks the application assignments and judging window before changing state.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={async event => {
          event.preventDefault(); if (parentBusy || pending.current || !reason.trim() || !canEdit || editorDirty || appointmentDirty || allocationDirty || assignmentDirty || lifecycleBusy || lifecycleDirty || lifecycleUncertain || uncertain || assignmentUncertain || appointmentUncertain || round.state !== 'draft') return;
          pending.current = true; setStarting(true); setError('');
          try {
            const result = await runCommand('start', round, { reason: reason.trim() });
            if (result.state !== 'judging') throw new Error('The server did not confirm that judging started.');
            if (mounted.current) { setConfirmStart(false); setReason(''); setNotice('Judging started. Round configuration and criteria are locked.'); }
          } catch (failure) { if (mounted.current) setError(failure.message); }
          finally { pending.current = false; if (mounted.current) setStarting(false); }
        }}>
          <Label htmlFor="round-start-reason">Reason (required)</Label><Textarea id="round-start-reason" required maxLength={20000} value={reason} disabled={starting || refreshing} onChange={event => setReason(event.target.value)} />
          {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
          {error && <Button type="button" variant="outline" disabled={starting || refreshing} onClick={async () => {
            if (pending.current) return;
            pending.current = true; setRefreshing(true);
            try { await refreshRound(); if (mounted.current) { setUncertain(false); setError(''); } }
            catch (failure) { if (mounted.current) setError(failure.message); }
            finally { pending.current = false; if (mounted.current) setRefreshing(false); }
          }}>Refresh round version (keep reason)</Button>}
          {round.state !== 'draft' && <p className="awards-help">The server round state is {round.state}; a new start action is not available.</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={starting || refreshing} onClick={() => { if (!reason || window.confirm('Discard the unsaved start reason?')) { setConfirmStart(false); setReason(''); } }}>Cancel</Button><Button type="submit" disabled={parentBusy || starting || refreshing || !reason.trim() || !canEdit || editorDirty || appointmentDirty || allocationDirty || assignmentDirty || lifecycleBusy || lifecycleDirty || lifecycleUncertain || uncertain || assignmentUncertain || appointmentUncertain || round.state !== 'draft'}>{starting ? 'Starting…' : 'Confirm start judging'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
