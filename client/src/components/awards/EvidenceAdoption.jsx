import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { roundAdminRequest } from './useRoundAdministration';
import { adoptionVersions, useSnapshotAdoption } from './useSnapshotAdoption';

const timestamp = value => new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');

export default function EvidenceAdoption({ awardId, round, tenant, applications, assignments, choicesReady, disabled, onDirtyChange, onBusyChange, onUncertainChange, onChanged }) {
  const queryClient = useQueryClient();
  const [applicationId, setApplicationId] = useState('');
  const [snapshotId, setSnapshotId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(true);
  const callbacks = useRef({ onDirtyChange, onBusyChange, onUncertainChange, onChanged });
  callbacks.current = { onDirtyChange, onBusyChange, onUncertainChange, onChanged };
  const query = useSnapshotAdoption(tenant, round.id, applicationId, choicesReady && !disabled);
  const dirty = !!(snapshotId || reason || confirmation || blocked);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { callbacks.current.onUncertainChange(blocked); }, [blocked]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  const options = applications.filter(application => assignments.some(row => row.application_id === application.id));
  const ready = choicesReady && query.isSuccess && !query.isFetching && !query.isError && query.data?.application.id === applicationId;
  const evidence = ready ? query.data : null;
  const snapshot = evidence?.versions.find(row => row.id === snapshotId);
  const changed = evidence?.assignments.filter(row => row.application_version_id !== snapshotId).length || 0;
  const roundEditable = ['draft', 'judging'].includes(round.state);
  const valid = ready && !!snapshot && evidence.assignments.length > 0 && changed > 0 && !!reason.trim() && reason.length <= 20000 && roundEditable;
  const stale = !!confirmation && (!ready || JSON.stringify(adoptionVersions(evidence.assignments)) !== JSON.stringify(confirmation.body.expectedAssignments)
    || !evidence.versions.some(row => row.id === confirmation.body.snapshotId));
  const closeConfirmation = () => { if (!pending.current) { setConfirmation(null); setAcknowledged(false); } };
  const reconcile = async () => {
    if (pending.current || disabled || !applicationId) return;
    pending.current = true; setBusy(true); setError(''); setConfirmation(null); setAcknowledged(false);
    try {
      const result = await query.refetch();
      tenant.assertCurrent();
      if (result.error || !result.data) throw result.error || new Error('Complete evidence metadata could not be reloaded.');
      await callbacks.current.onChanged();
      tenant.assertCurrent();
      if (!alive.current) return;
      setBlocked(false);
      const allOnSelection = snapshotId && result.data.assignments.length > 0 && result.data.assignments.every(row => row.application_version_id === snapshotId);
      setNotice(allOnSelection
        ? 'All current assignments already use the selected evidence. This read does not establish who applied an ambiguous request or which reason was recorded; consult audit history. No duplicate adoption will be offered.'
        : 'Complete evidence and current assignment versions reloaded. Your evidence choice and reason were retained. Review the current records and open a new confirmation; nothing was automatically retried.');
    } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="rounded-lg border p-4 space-y-4" aria-labelledby="evidence-adoption-heading">
    <div><p className="awards-kicker">Explicit administrator action</p><h4 id="evidence-adoption-heading" className="font-semibold mt-1">Adopt application evidence for this round</h4><p className="awards-help mt-2">Adoption covers every assignment for the application in this round, including inactive assignments, atomically. Assignment states, inclusion and conflicts are preserved. No assessment or assignment history is archived or removed.</p></div>
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 space-y-2">
      <p>All existing draft and submitted assessments on assignments whose evidence changes will require reassessment against the chosen evidence. Each changed assignment receives an empty reopened assessment revision. Previous answers remain history and are not copied.</p>
      <p>Assignments already using that evidence are unchanged. Reopen downstream moderation, shortlist and outcome decisions first. This action does not reopen those decisions, resolve conflicts, restore inactive assignments, publish or send anything.</p>
    </div>
    <label className="block text-sm font-medium">Application reference<select className="awards-select mt-1" value={applicationId} disabled={disabled || busy || blocked || !choicesReady || !!confirmation} onChange={event => {
      if (dirty && !window.confirm('Discard the unsaved evidence choice and adoption reason before choosing another application?')) return;
      setApplicationId(event.target.value); setSnapshotId(''); setReason(''); setError(''); setNotice('');
    }}><option value="">Choose an assigned application</option>
      {applicationId && !options.some(row => row.id === applicationId) && <option value={applicationId} disabled>Selected application is no longer in the discovered assignment list</option>}
      {options.map(application => <option key={application.id} value={application.id}>{application.reference}</option>)}
    </select></label>
    {!choicesReady && <p className="awards-help">Complete application-reference and round-control lists must load before choosing an application.</p>}
    {choicesReady && !options.length && <p className="awards-help">There are no discovered applications with assignments in this round. Adoption does not create allocations.</p>}
    {applicationId && query.isLoading && <Skeleton className="h-24 w-full" />}
    {query.isError && <p role="alert" className="text-sm text-red-800">{query.error.message} Confirmation is unavailable; no partial data is used.</p>}
    {applicationId && <Button type="button" size="sm" variant="outline" disabled={busy || disabled || query.isFetching} onClick={reconcile}>Reload complete evidence & assignments (keep choice and reason)</Button>}
    {evidence && <>
      <p className="awards-help">{evidence.application.reference} · {evidence.versions.length} retained evidence versions · {evidence.assignments.length} assignments loaded across all pages, including inactive records.</p>
      {!evidence.versions.length && <p className="awards-help">No retained evidence versions are available. Nothing can be adopted.</p>}
      {!evidence.assignments.length && <p className="awards-help">This application has no current or inactive assignments in this round. Nothing can be adopted.</p>}
    </>}
    <fieldset disabled={disabled || busy || !!confirmation || !ready} className="space-y-4">
      <label className="block text-sm font-medium">Evidence version to adopt<select className="awards-select mt-1" value={snapshotId} disabled={blocked || !ready} onChange={event => { setSnapshotId(event.target.value); setNotice(''); }}>
        <option value="">Choose evidence explicitly — none selected by default</option>
        {snapshotId && !evidence?.versions.some(row => row.id === snapshotId) && <option value={snapshotId} disabled>Retained evidence choice — {ready ? 'not present in the complete catalog' : 'awaiting the complete catalog'}</option>}
        {evidence?.versions.map(version => <option key={version.id} value={version.id}>Revision {version.revision} · {timestamp(version.created_at)}</option>)}
      </select></label>
      {snapshot && <p className="awards-help">{changed} assignment{changed === 1 ? '' : 's'} would change; {evidence.assignments.length - changed} already use revision {snapshot.revision}. {changed === 0 ? 'No adoption is needed for this evidence.' : 'Inactive assignments are not excluded from this count.'}</p>}
      <div><Label htmlFor="evidence-adoption-reason">Evidence adoption reason (required)</Label><Textarea id="evidence-adoption-reason" required maxLength={20000} rows={4} value={reason} onChange={event => setReason(event.target.value)} /></div>
    </fieldset>
    {!roundEditable && <p role="alert" className="text-sm text-amber-800">The round is {round.state}. Adoption requires a draft or judging round; use the separate lifecycle controls to reopen it where permitted.</p>}
    {blocked && <p role="alert" className="text-sm text-amber-800">The previous request needs reconciliation. It may have committed even if its response was lost. Reload this application’s complete evidence and assignment versions before a new confirmation. Never assume a failed response means nothing changed.</p>}
    {error && <p role="alert" className="text-sm text-red-800">{error} Your evidence choice and reason remain here.</p>}
    {notice && <p role="status" className="text-sm text-emerald-800 whitespace-pre-wrap break-words">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={disabled || busy || blocked || !valid || !!confirmation} onClick={() => {
        if (pending.current || disabled || blocked || !valid) return;
        setAcknowledged(false); setError('');
        setConfirmation({
          body: { roundId: round.id, applicationId, snapshotId, expectedAssignments: adoptionVersions(evidence.assignments), reason: reason.trim() },
          reference: evidence.application.reference, revision: snapshot.revision, createdAt: snapshot.created_at,
          assignments: evidence.assignments.map(row => ({ ...row })), changed,
        });
      }}>Review evidence adoption…</Button>
      <Button type="button" variant="outline" disabled={disabled || busy || blocked || !!confirmation || !dirty} onClick={() => {
        if (window.confirm('Discard the unsaved evidence choice and adoption reason? No server records will be changed.')) { setSnapshotId(''); setReason(''); setError(''); setNotice(''); }
      }}>Clear unsaved choice</Button>
    </div>
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open) closeConfirmation(); }}><DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Confirm evidence adoption for every assignment</DialogTitle><DialogDescription>This is a new assessment baseline, not a copy of prior answers. No inactive assignment is silently omitted.</DialogDescription></DialogHeader>
      {confirmation && <form className="space-y-4" onSubmit={async event => {
        event.preventDefault();
        if (pending.current || disabled || blocked || stale || !acknowledged || !roundEditable || !ready) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        let confirmed = false;
        try {
          const result = await roundAdminRequest(tenant, '/api/awards/snapshot-adoption', { body: confirmation.body });
          if (result.applicationVersionId !== confirmation.body.snapshotId || !Number.isSafeInteger(result.changed) || result.changed !== confirmation.changed) throw new Error('The server did not confirm the exact evidence adoption result. Reconcile before doing anything further.');
          confirmed = true;
          tenant.assertCurrent();
          if (!alive.current) return;
          setBlocked(true);
          const refreshed = await query.refetch();
          if (refreshed.error || !refreshed.data) throw new Error('The server confirmed adoption, but complete evidence metadata could not be reloaded.');
          await callbacks.current.onChanged();
          tenant.assertCurrent();
          if (!alive.current) return;
          if (!refreshed.data.assignments.every(row => row.application_version_id === confirmation.body.snapshotId)) throw new Error('Adoption was confirmed, but assignments have since changed or been added with different evidence. Reconcile current records before another action.');
          queryClient.invalidateQueries({ queryKey: ['award-audit-history', tenant.scopeKey, awardId], refetchType: 'none' });
          setNotice(`Server confirmed evidence revision ${confirmation.revision} adopted for ${confirmation.reference}: ${result.changed} assignments changed. Previous answers remain history; changed assignments require reassessment. No publication or message was triggered.`);
          setBlocked(false); setSnapshotId(''); setReason(''); setConfirmation(null); setAcknowledged(false);
        } catch (failure) {
          if (alive.current) {
            setError(`${confirmed ? 'The adoption was confirmed; do not repeat it blindly. ' : ''}${failure.message}`);
            setBlocked(true); setConfirmation(null); setAcknowledged(false);
          }
        } finally { pending.current = false; if (alive.current) setBusy(false); }
      }}>
        <dl className="text-sm space-y-2"><div><dt className="font-semibold">Application / round</dt><dd className="break-words">{confirmation.reference} · {round.name}</dd></div><div><dt className="font-semibold">Explicit evidence choice</dt><dd>Revision {confirmation.revision} · {timestamp(confirmation.createdAt)}</dd></div><div><dt className="font-semibold">Atomic scope</dt><dd>All {confirmation.assignments.length} assignments, including inactive: {confirmation.changed} change evidence; {confirmation.assignments.length - confirmation.changed} already use it.</dd></div><div><dt className="font-semibold">Reason to record</dt><dd className="whitespace-pre-wrap break-words">{confirmation.body.reason}</dd></div></dl>
        <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">Exact assignment version map being confirmed</summary><ul className="mt-3 space-y-2 text-xs break-words">{confirmation.assignments.map(row => <li key={row.id}>{row.id} · version {confirmation.body.expectedAssignments[row.id]} · {row.state} · current evidence {row.application_version_id ? `revision ${evidence?.versions.find(version => version.id === row.application_version_id)?.revision ?? 'unavailable'}` : 'not pinned'}</li>)}</ul></details>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" required checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /><span>I understand that all draft/submitted assessments on changed assignments need reassessment against this evidence. Empty reopened revisions replace no history, previous answers are not copied, and states/conflicts remain unchanged. Downstream decisions must first be reopened separately.</span></label>
        {stale && <p role="alert" className="text-sm text-amber-800">The complete assignment map changed or is unavailable. Close this review and reload before creating a new confirmation.</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={closeConfirmation}>Keep draft, go back</Button><Button type="submit" disabled={disabled || busy || blocked || stale || !acknowledged || !roundEditable || !ready}>{busy ? 'Awaiting server confirmation…' : 'Confirm evidence adoption'}</Button></DialogFooter>
      </form>}
    </DialogContent></Dialog>
  </section>;
}
