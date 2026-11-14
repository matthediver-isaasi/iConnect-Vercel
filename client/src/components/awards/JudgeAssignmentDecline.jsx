import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { judgingRequest } from './judgingClient';

export const canDeclineAssignment = assignment => assignment?.state === 'assigned'
  && [null, undefined, 'draft', 'reopened'].includes(assignment.assessmentState);

export default function JudgeAssignmentDecline({ assignment, authority, onClose, onBusyChange, onConfirmed, onRefresh }) {
  const [current, setCurrent] = useState(assignment), [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(false), callbacks = useRef({});
  callbacks.current = { onClose, onBusyChange, onConfirmed, onRefresh };
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onBusyChange(false); }; }, []);
  const close = () => {
    if (pending.current) return;
    if (!confirmed && (reason || blocked) && !window.confirm(`${blocked ? 'The previous request may have committed. ' : ''}Discard this local decline reason and close? No further request or automatic retry will be made.`)) return;
    callbacks.current.onClose();
  };
  const reconcile = async () => {
    if (pending.current || !authority.ready) return;
    pending.current = true; setBusy(true); setError(''); setAcknowledged(false);
    try {
      // A decline/other allocation may move the row to another dashboard page.
      // Never treat one page's absence or a partial/duplicate catalog as proof.
      const seen = new Set(); let total, pageSize, found = null, complete = false;
      for (let page = 1; page <= 1000; page += 1) {
        const data = await judgingRequest(`/api/judging?page=${page}`, { authority });
        if (!Array.isArray(data.assignments) || !Number.isSafeInteger(data.total) || data.total < 0 || data.page !== page
          || !Number.isSafeInteger(data.pageSize) || data.pageSize < 1 || (total !== undefined && total !== data.total) || (pageSize !== undefined && pageSize !== data.pageSize)
          || data.assignments.length !== Math.min(data.pageSize, Math.max(0, data.total - (page - 1) * data.pageSize))) throw new Error('Your assignment catalog changed or is incomplete. No version has been reconciled; reload again.');
        total = data.total; pageSize = data.pageSize;
        for (const row of data.assignments) {
          if (!row.id || seen.has(row.id) || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error('Duplicate or unverifiable assignment versions were returned. No partial catalog is being used.');
          seen.add(row.id);
          if (row.id === assignment.id) found = row;
        }
        if (seen.size === total) { complete = true; break; }
      }
      if (!complete) throw new Error('The assignment catalog exceeds this reconciliation limit. Ask an administrator; no partial list is being used.');
      authority.assertCurrent();
      await callbacks.current.onRefresh(); authority.assertCurrent();
      if (!alive.current) return;
      if (!found) {
        if (confirmed) {
          setBlocked(false);
          setNotice('Your earlier decline was confirmed and the dashboard is reloaded. The assignment is no longer returned in the authorised catalog. Do not repeat the mutation.');
          return;
        }
        throw new Error('This assignment is no longer returned to your judging authority. Its state/version cannot be confirmed. Do not retry; ask an administrator.');
      }
      setCurrent(found); setBlocked(false);
      setNotice(found.state === 'declined'
        ? 'The server currently reports this assignment as declined. Do not repeat the decline. Only a successful POST confirmation establishes that your particular reason was recorded.'
        : canDeclineAssignment(found)
          ? `Current assignment version ${found.version} loaded. Your reason is retained. An unchanged row does not prove the earlier request failed; any further attempt needs a fresh explicit confirmation against this version.`
          : 'This assignment can no longer be declined here. Ask an administrator to review its current assessment or downstream decisions. Your local reason remains available.');
    } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const finished = confirmed || current.state === 'declined';
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>Decline this assignment</DialogTitle><DialogDescription>This declines one assigned application, not your appointment or every application in the round. Server-saved drafts remain stored. No replacement is allocated and no assessment or score is deleted.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={async event => {
        event.preventDefault();
        if (pending.current || !authority.ready || blocked || finished || !canDeclineAssignment(current) || !acknowledged || !reason.trim() || reason.length > 2000) return;
        pending.current = true; setBusy(true); setError(''); setNotice(''); setAcknowledged(false);
        let saved = false;
        try {
          const result = await judgingRequest('/api/judging/decline', { authority, body: { assignmentId: current.id, version: current.version, reason: reason.trim() } });
          if (result.id !== current.id || result.state !== 'declined' || !Number.isSafeInteger(result.version) || result.version <= current.version) throw new Error('The server did not confirm the requested assignment decline.');
          authority.assertCurrent(); saved = true;
          if (!alive.current) return;
          setConfirmed(true); setCurrent(old => ({ ...old, ...result })); setBlocked(true);
          callbacks.current.onConfirmed(result);
          await callbacks.current.onRefresh(); authority.assertCurrent();
          if (alive.current) { setBlocked(false); setNotice('Assignment decline confirmed and your dashboard reloaded. Saved drafts remain stored; no automatic replacement or score deletion was performed.'); }
        } catch (failure) {
          if (alive.current) {
            setBlocked(true);
            setError(saved ? `Decline confirmed, but dashboard refresh failed: ${failure.message}. Reconcile the dashboard; do not repeat the mutation.`
              : `${failure.message} The request may have committed. Your reason is retained. Reconcile before another explicit confirmation; completed assessments or downstream decisions require an administrator.`);
          }
        } finally { pending.current = false; if (alive.current) setBusy(false); }
      }}>
        <p className="text-sm font-medium break-words">{assignment.awardName} · {assignment.roundName} · {assignment.applicationReference}</p>
        <p className="awards-help">Last loaded/confirmed state: {current.state} · expected version {current.version}. Submitted assessments cannot be declined. The server also checks current authority and downstream decisions.</p>
        <div className="awards-field"><Label htmlFor="judge-assignment-decline-reason">Decline reason (required)</Label><Textarea id="judge-assignment-decline-reason" required maxLength={2000} rows={4} value={reason} disabled={busy || !authority.ready} readOnly={finished} onChange={event => { setReason(event.target.value); setAcknowledged(false); }} /></div>
        {!finished && <label className="flex gap-3 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy || blocked || !authority.ready || !canDeclineAssignment(current)} onChange={event => setAcknowledged(event.target.checked)} /><span>I explicitly decline this assignment at version {current.version}, with the reason above. Saved drafts remain history; this does not delete scores or arrange a replacement.</span></label>}
        {(!canDeclineAssignment(current) && !finished) && <p role="alert" className="text-sm">This assignment is not currently assigned with an unsubmitted assessment. Ask an administrator; there is no override here.</p>}
        {blocked && <p role="alert" className="text-sm text-amber-900">Reconciliation is required. No automatic retry will be made and no local reason will be cleared.</p>}
        {!authority.ready && <p role="alert" className="text-sm">Your judging authority is not currently verified. No request can be made.</p>}
        {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <Button type="button" variant="outline" disabled={busy || !authority.ready} onClick={reconcile}>Reconcile own assignments (keep reason)</Button>
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={close}>{confirmed ? 'Done' : 'Close decline dialog'}</Button>{!finished && <Button type="submit" disabled={busy || blocked || !authority.ready || !canDeclineAssignment(current) || !acknowledged || !reason.trim()}>{busy ? 'Awaiting server…' : 'Confirm assignment decline'}</Button>}</DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
