import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useMemberAccess } from '@/hooks/useMemberAccess';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { appointmentLabel, roundAdminRequest, roundAssignmentsKey, useAllocationApplications } from './useRoundAdministration';
import EvidenceAdoption from './EvidenceAdoption';
import PanelConflictReview from './PanelConflictReview';

const COMMANDS = {
  remove: { label: 'Remove assignment', effect: 'Removes the assignment and excludes its score. This does not appoint or allocate a replacement.' },
  restore: { label: 'Restore assignment', effect: 'Restores the assignment only. Its prior score stays excluded until a separate explicit Include score action.' },
  exclude: { label: 'Exclude score', effect: 'Excludes this assignment’s assessment from scoring without removing the assignment.' },
  include: { label: 'Include score', effect: 'Includes the assessment for this assigned, conflict-resolved record. This is separate from restoration.' },
  clear_conflict: { label: 'Clear declared conflict', effect: 'Records conflict clearance only. A recused assignment remains recused and excluded until separate restoration and inclusion actions.' },
  confirm_conflict: { label: 'Confirm conflict & recuse', effect: 'Confirms the conflict, recuses the assignment and excludes its score.' },
};

export default function AssignmentControls({ awardId, round, tenant, assignmentsQuery, appointmentsQuery, labels, disabled, onDirtyChange, onBusyChange, onChanged, onUncertainChange }) {
  const queryClient = useQueryClient();
  const { memberInfo } = useMemberAccess();
  const applicationsQuery = useAllocationApplications(tenant, awardId);
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [adoptionDirty, setAdoptionDirty] = useState(false);
  const [adoptionBusy, setAdoptionBusy] = useState(false);
  const [adoptionUncertain, setAdoptionUncertain] = useState(false);
  const [panelDirty, setPanelDirty] = useState(false);
  const [panelBusy, setPanelBusy] = useState(false);
  const [panelUncertain, setPanelUncertain] = useState(false);
  const incomingDisabled = disabled;
  disabled = disabled || panelDirty || panelBusy || panelUncertain;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [clock, setClock] = useState(Date.now);
  const pending = useRef(false), alive = useRef(true), callbacks = useRef({ onDirtyChange, onBusyChange, onChanged, onUncertainChange });
  callbacks.current = { onDirtyChange, onBusyChange, onChanged, onUncertainChange };
  const dirty = Boolean(selected || reason || adoptionDirty || panelDirty);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy || adoptionBusy || panelBusy); }, [busy, adoptionBusy, panelBusy]);
  useEffect(() => { callbacks.current.onUncertainChange(blocked || adoptionUncertain || panelUncertain); }, [blocked, adoptionUncertain, panelUncertain]);
  useEffect(() => {
    alive.current = true; const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => { alive.current = false; clearInterval(timer); callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  const assignments = assignmentsQuery.data || [], appointments = appointmentsQuery.data || [], applications = applicationsQuery.data || [];
  const ready = assignmentsQuery.isSuccess && appointmentsQuery.isSuccess && applicationsQuery.isSuccess && !assignmentsQuery.isFetching && !appointmentsQuery.isFetching && !applicationsQuery.isFetching;
  const applicationRef = id => applications.find(item => item.id === id)?.reference || id;
  const appointmentFor = assignment => appointments.find(item => item.id === assignment.appointment_id);
  const commandMatrix = (assignment, now = clock) => {
    const appointment = appointmentFor(assignment);
    const application = applications.find(item => item.id === assignment.application_id);
    const known = ['assigned', 'removed', 'recused'].includes(assignment.state);
    const resolved = ['none', 'cleared'].includes(assignment.conflict);
    const authority = !appointment ? 'Load the current appointment.' : appointment.state !== 'accepted' ? 'An accepted appointment is required.' : application?.eligibility !== 'eligible' ? 'An eligible application is required.' : null;
    const assignedCount = assignments.filter(item => item.appointment_id === assignment.appointment_id && item.state === 'assigned').length;
    const restoreWindow = !['draft', 'judging'].includes(round.state) ? 'Restoration requires a draft or judging round.'
      : !round.closes_at || !Number.isFinite(Date.parse(round.closes_at)) || Date.parse(round.closes_at) <= now ? 'The judging close time must be in the future.'
        : !appointment?.available ? 'The appointment is unavailable.'
          : appointment.expires_at && (!Number.isFinite(Date.parse(appointment.expires_at)) || Date.parse(appointment.expires_at) <= now) ? 'The appointment has expired.'
            : appointment.capacity != null && assignedCount >= appointment.capacity ? 'Appointment capacity is full.' : null;
    return {
      remove: !known ? 'Unsupported assignment state.' : assignment.state === 'removed' ? 'Already removed.' : null,
      restore: !['removed', 'recused'].includes(assignment.state) ? 'Only removed or recused assignments can be restored.' : !resolved ? 'Clear the declared conflict first.' : authority || restoreWindow,
      exclude: !known ? 'Unsupported assignment state.' : !assignment.included ? 'Score already excluded.' : null,
      include: assignment.included ? 'Score already included.' : assignment.state !== 'assigned' ? 'Restore the assignment first.' : !resolved ? 'Resolve the conflict first.' : authority,
      clear_conflict: !['potential', 'confirmed'].includes(assignment.conflict) ? 'No potential or confirmed conflict to clear.'
        : memberInfo?.id && appointment?.member_id === memberInfo.id ? 'You cannot clear a conflict on your own assignment; ask a different administrator.' : authority,
      confirm_conflict: !known ? 'Unsupported assignment state.' : assignment.conflict === 'confirmed' && assignment.state === 'recused' && !assignment.included ? 'Already confirmed, recused and excluded.' : null,
    };
  };
  const fresh = selected ? assignments.find(item => item.id === selected.assignment.id) : null;
  const stale = Boolean(selected && ready && fresh?.version !== selected.assignment.version);
  const selectedBlock = selected ? commandMatrix(selected.assignment)[selected.command] : null;
  const close = () => { if (!busy && (!dirty || window.confirm('Discard the unsaved assignment command and reason?'))) { setSelected(null); setReason(''); setError(''); } };
  const reload = async () => {
    if (pending.current || disabled || adoptionBusy) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const results = await Promise.all([assignmentsQuery.refetch(), appointmentsQuery.refetch(), applicationsQuery.refetch()]);
      tenant.assertCurrent();
      if (results.some(result => result.error)) throw results.find(result => result.error).error;
      const current = selected && results[0].data.find(item => item.id === selected.assignment.id);
      if (selected && !current) throw new Error('The selected assignment is no longer in this round. Its reason and selection remain here.');
      if (!alive.current) return;
      // This explicit reload reconciles the optimistic version, not the action
      // or reason. Saving still requires a new explicit confirmation.
      if (current) setSelected(old => ({ ...old, assignment: current }));
      setBlocked(false);
      setNotice('Current assignment, appointment and eligibility data loaded. The chosen command and reason were retained; review them before confirming.');
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const pages = Math.max(1, Math.ceil(assignments.length / 10)), currentPage = Math.min(page, pages);
  return <section className="border-t mt-6 pt-5 space-y-4">
    <div className="flex flex-wrap justify-between items-start gap-3"><div><h3 className="font-semibold">Assignment administration</h3><p className="awards-help mt-2">Restoration never includes a prior score automatically. Conflict clearance never restores a recused assignment. Every command has its own recorded reason.</p></div><Button type="button" size="sm" variant="outline" disabled={disabled || busy || adoptionBusy} onClick={reload}>Reload controls (keep reason)</Button></div>
    <p className="awards-help">Replacement is two separate actions: remove the old assignment here, then preview and confirm a new allocation in the allocator. It is not an atomic replacement; a failed allocation leaves the old assignment removed. The server may require downstream decisions to be reopened before changes.</p>
    {[assignmentsQuery, appointmentsQuery, applicationsQuery].some(query => query.isLoading) && <Skeleton className="h-24 w-full" />}
    {[assignmentsQuery, appointmentsQuery, applicationsQuery].filter(query => query.isError).map((query, index) => <p role="alert" className="text-sm text-red-800" key={index}>{query.error.message} Complete control data must load before a command is enabled.</p>)}
    {assignmentsQuery.isSuccess && !assignments.length && <p className="awards-help rounded-lg border p-5">No assignments have been recorded for this round. Use the separate allocation preview to create assignments.</p>}
    {assignments.length > 0 && <ul className="divide-y rounded-lg border">{assignments.slice((currentPage - 1) * 10, currentPage * 10).map(assignment => {
      const matrix = commandMatrix(assignment);
      return <li key={assignment.id} className="p-4 space-y-3">
        <div><h4 className="font-semibold text-sm break-words">{applicationRef(assignment.application_id)}</h4><p className="awards-help break-words">{appointmentLabel(appointmentFor(assignment), labels)}</p><p className="awards-help">{assignment.state} · {assignment.included ? 'Score included' : 'Score excluded'} · Conflict: {assignment.conflict} · version {assignment.version}</p></div>
        {assignment.inclusion_reason && <p className="awards-help whitespace-pre-wrap break-words">Inclusion reason: {assignment.inclusion_reason}</p>}
        {assignment.conflict_reason && <p className="awards-help whitespace-pre-wrap break-words">Conflict reason: {assignment.conflict_reason}</p>}
        {assignment.state === 'declined' && assignment.decline_reason && <p className="awards-help whitespace-pre-wrap break-words">Judge decline reason: {assignment.decline_reason}</p>}
        <div className="flex flex-wrap gap-2">{Object.entries(COMMANDS).map(([command, meta]) => <Button type="button" key={command} size="sm" variant="outline" title={matrix[command] || meta.effect} disabled={disabled || busy || adoptionBusy || adoptionDirty || adoptionUncertain || !ready || blocked || Boolean(matrix[command])} onClick={() => { if (selected && !window.confirm('Discard the previous assignment command and reason?')) return; setSelected({ assignment, command }); setReason(''); setError(''); }}>{meta.label}</Button>)}</div>
        <details className="text-sm"><summary className="cursor-pointer awards-help">Command effects & availability</summary><dl className="space-y-2 mt-3">{Object.entries(COMMANDS).map(([command, meta]) => <div key={command}><dt className="font-medium">{meta.label}</dt><dd className="awards-help">{matrix[command] || meta.effect}</dd></div>)}</dl></details>
      </li>;
    })}</ul>}
    {pages > 1 && <div className="flex justify-between items-center gap-2"><Button type="button" size="sm" variant="outline" disabled={currentPage <= 1 || busy} onClick={() => setPage(currentPage - 1)}>Previous assignments</Button><span className="awards-help">{currentPage} / {pages} · {assignments.length} assignments</span><Button type="button" size="sm" variant="outline" disabled={currentPage >= pages || busy} onClick={() => setPage(currentPage + 1)}>Next assignments</Button></div>}
    {blocked && <p role="alert" className="text-sm text-amber-800">Reload current control data before another write. A failed or ambiguous command is never automatically retried.</p>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {error && !selected && <p role="alert" className="text-sm text-red-800">{error}</p>}
    <PanelConflictReview round={round} tenant={tenant} applications={applications} appointments={appointments} labels={labels} choicesReady={ready}
      disabled={incomingDisabled || busy || adoptionBusy || adoptionDirty || adoptionUncertain || !!selected || blocked}
      onDirtyChange={setPanelDirty} onBusyChange={setPanelBusy} onUncertainChange={setPanelUncertain}
      onChanged={async () => { callbacks.current.onChanged(); const result = await assignmentsQuery.refetch(); tenant.assertCurrent(); if (result.error || !result.data) throw result.error || new Error('Current judge-assignment records could not be reloaded.'); }} />
    <EvidenceAdoption awardId={awardId} round={round} tenant={tenant} applications={applications} assignments={assignments} choicesReady={ready}
      disabled={disabled || busy || !!selected || blocked} onDirtyChange={setAdoptionDirty} onBusyChange={setAdoptionBusy} onUncertainChange={setAdoptionUncertain}
      onChanged={async () => { callbacks.current.onChanged(); const result = await assignmentsQuery.refetch(); tenant.assertCurrent(); if (result.error || !result.data) throw result.error || new Error('Complete assignment controls could not be reloaded.'); }} />
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) close(); }}><DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{selected ? COMMANDS[selected.command].label : 'Assignment command'}</DialogTitle><DialogDescription>{selected && COMMANDS[selected.command].effect} Server-saved assessment drafts are not replaced by this command.</DialogDescription></DialogHeader>
      {selected && <form className="space-y-4" onSubmit={async event => {
        event.preventDefault();
        if (pending.current || disabled || !ready || blocked || stale || !reason.trim() || commandMatrix(selected.assignment, Date.now())[selected.command]) return;
        if (!window.confirm(`${COMMANDS[selected.command].label} for application ${applicationRef(selected.assignment.application_id)}? ${COMMANDS[selected.command].effect}`)) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        try {
          const result = await roundAdminRequest(tenant, '/api/awards/assignment-controls', { body: { id: selected.assignment.id, version: selected.assignment.version, command: selected.command, reason: reason.trim() } });
          const expected = selected.command === 'remove' ? result.state === 'removed' && result.included === false
            : selected.command === 'restore' ? result.state === 'assigned' && result.included === false
              : selected.command === 'include' ? result.included === true && result.state === 'assigned'
                : selected.command === 'exclude' ? result.included === false
                  : selected.command === 'clear_conflict' ? result.conflict === 'cleared' && result.state === selected.assignment.state && result.included === selected.assignment.included
                    : result.conflict === 'confirmed' && result.state === 'recused' && result.included === false;
          if (result.id !== selected.assignment.id || !Number.isSafeInteger(result.version) || result.version <= selected.assignment.version || !expected) throw new Error('The server did not confirm the requested assignment transition. Reload before retrying.');
          queryClient.setQueryData(roundAssignmentsKey(tenant, round.id), old => old?.map(item => item.id === result.id ? { ...item, ...result, ...(['clear_conflict', 'confirm_conflict'].includes(selected.command) ? { conflict_reason: reason.trim() } : {}), ...(selected.command !== 'clear_conflict' ? { inclusion_reason: reason.trim() } : {}) } : item));
          if (!alive.current) return;
          setNotice(`${COMMANDS[selected.command].label}: server version ${result.version} recorded. ${COMMANDS[selected.command].effect}`);
          setSelected(null); setReason(''); callbacks.current.onChanged();
          const refreshed = await assignmentsQuery.refetch(); tenant.assertCurrent();
          if (refreshed.error) throw new Error('The command was saved, but the complete assignment list could not be reloaded.');
          if (alive.current) { setBlocked(false); }
        } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); callbacks.current.onChanged(); } }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      }}>
        <p className="awards-help break-words">{applicationRef(selected.assignment.application_id)} · {appointmentLabel(appointmentFor(selected.assignment), labels)} · version {selected.assignment.version}</p>
        <p className="awards-help">Current snapshot: {selected.assignment.state} · {selected.assignment.included ? 'included' : 'excluded'} · conflict {selected.assignment.conflict}</p>
        {(blocked || stale || selectedBlock) && <p role="alert" className="text-sm text-amber-800">{selectedBlock || 'The selected record is stale or the previous request needs reconciliation. Reload its current version while keeping your reason.'}</p>}
        <Label htmlFor="assignment-command-reason">Reason (required)</Label><Textarea id="assignment-command-reason" required maxLength={20000} rows={4} disabled={busy || disabled} value={reason} onChange={event => setReason(event.target.value)} />
        {error && <p role="alert" className="text-sm text-red-800">{error} The action and reason remain here unless the server confirmed their save.</p>}
        <Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={reload}>Reload selected version (keep command & reason)</Button>
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel command</Button><Button type="submit" disabled={disabled || busy || !ready || blocked || stale || Boolean(selectedBlock) || !reason.trim()}>Confirm {COMMANDS[selected.command].label.toLowerCase()}…</Button></DialogFooter>
      </form>}
    </DialogContent></Dialog>
  </section>;
}
