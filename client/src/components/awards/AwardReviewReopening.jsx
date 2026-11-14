import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePopupUnsavedChanges } from '@/hooks/usePopupUnsavedChanges';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { decisionRequest } from './useAwardDecisions';

const finalised = state => ['results_approved', 'completed', 'archived'].includes(state);
const validAward = (row, award, tenant) => row?.id === award.id && row.tenant_id === tenant.tenantId
  && typeof row.name === 'string' && Number.isSafeInteger(row.version) && row.version >= 1 && typeof row.state === 'string';

export default function AwardReviewReopening(props) {
  return <ReviewWorkspace key={`${props.tenant.scopeKey}:${props.award.id}`} {...props} />;
}

function ReviewWorkspace({ award, tenant, canEdit, disabled, refreshMetadata, onMetadataChanged, onDirtyChange, onBusyChange }) {
  const [reason, setReason] = useState(''), [confirmation, setConfirmation] = useState(null), [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [confirmed, setConfirmed] = useState(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(false), attempted = useRef(false), callbacks = useRef({});
  callbacks.current = { refreshMetadata, onMetadataChanged, onDirtyChange, onBusyChange };
  const queryClient = useQueryClient();
  const dirty = (!confirmed && !!(reason || confirmation)) || (blocked && attempted.current);
  const guard = usePopupUnsavedChanges({ dirty, isDirty: () => pending.current || dirty });
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  const canReview = canEdit && !disabled && !busy && !blocked && !confirmed && finalised(award.state)
    && Number.isSafeInteger(award.version) && award.version >= 1 && !!reason.trim() && reason.length <= 2000;
  const stale = !!confirmation && (confirmation.awardId !== award.id || confirmation.version !== award.version || confirmation.state !== award.state);
  const reconcile = async () => {
    if (pending.current || disabled || !canEdit) return;
    pending.current = true; setBusy(true); setError(''); setConfirmation(null); setAcknowledged(false);
    try {
      tenant.assertCurrent();
      const fresh = await callbacks.current.refreshMetadata(); tenant.assertCurrent();
      if (!validAward(fresh, award, tenant)) throw new Error('Current award metadata could not be verified.');
      if (!alive.current) return;
      setBlocked(false);
      setNotice(`Server state “${fresh.state}”, version ${fresh.version}, re-read without resetting configuration or binding drafts. ${confirmed
        ? 'The confirmed reopening has not been repeated.'
        : 'Your reason is retained. A prior request may have committed; current state alone does not prove whether that reason was recorded. Any still-available operation needs a new unchecked confirmation.'}`);
    } catch (failure) { if (alive.current) { setBlocked(true); setError(failure.message); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  if (!canEdit || (!finalised(award.state) && !reason && !blocked && !confirmed && !confirmation)) return null;
  return <Card className="mt-6 shadow-sm">
    <CardHeader className="border-b"><p className="awards-kicker mb-2">Exceptional review lifecycle</p><CardTitle className="text-xl">Reopen finalised award review</CardTitle><p className="awards-help">Current stage: {award.state.replaceAll('_', ' ')} · version {award.version}. Only results approved, completed or archived awards can return to judging through this separate configure-authorised operation.</p></CardHeader>
    <CardContent className="pt-5 space-y-4">
      <p className="text-sm">Reopening changes only the award review stage to judging and advances its version. Applications stay closed as before; application deadlines, rounds, scores, publications, issued certificates and recipient releases are not changed. Nothing is resent or emailed.</p>
      <div className="rounded-lg border bg-[#edf4f4] p-4 text-sm space-y-3"><h3 className="font-semibold">Reassessment still requires explicit dependency handling</h3><ol className="list-decimal pl-5 space-y-2"><li>Retract affected published audience/event streams explicitly; award reopening does not withdraw public or member projections.</li><li>Reopen affected outcomes, shortlist decisions and moderation in reverse dependency order before reassessment. No downstream decision is automatically reopened.</li><li>Reopen each affected round separately with a valid future judging deadline. Round transitions and authorised rubric corrections remain server-blocked while the parent award is finalised.</li></ol><p>Saved configuration and form bindings remain locked outside draft. This is not a return to draft or a reopening of application intake.</p></div>
      <Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={reconcile}>Re-read award lifecycle metadata (keep all drafts)</Button>
      <div className="awards-field"><Label htmlFor="award-review-reopening-reason">Review reopening reason (required)</Label><Textarea id="award-review-reopening-reason" rows={4} maxLength={2000} disabled={busy || disabled || !!confirmation} readOnly={!!confirmed} value={reason} onChange={event => setReason(event.target.value)} /></div>
      {!confirmed && <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={!canReview} onClick={() => {
        if (!canReview) return;
        tenant.assertCurrent(); setError(''); setAcknowledged(false);
        setConfirmation({ awardId: award.id, name: award.name, state: award.state, version: award.version, reason: reason.trim() });
      }}>Review reopening to judging…</Button>
        <Button type="button" variant="ghost" disabled={busy || disabled || blocked || !reason} onClick={() => {
          if (!window.confirm('Discard only the local review reopening reason? No server action is undone; configuration and binding drafts are unchanged.')) return;
          setReason(''); setConfirmation(null); setAcknowledged(false);
        }}>Discard reopening reason</Button></div>}
      {!finalised(award.state) && !confirmed && <p className="awards-help">The re-read award is no longer in an eligible finalised stage. No reopening request is available; a previous request may already have taken effect. Your reason remains available to copy.</p>}
      {confirmed && <p role="status" className="text-sm">Server confirmed review reopened to judging, version {confirmed.version}. No applications, deadlines, rounds, scores, publications, recipient releases or issued certificates were changed. No mail was sent. This command will not be repeated.</p>}
      {blocked && <p role="alert" className="text-sm text-amber-900">Re-read current metadata before any further confirmation. A failed or ambiguous write is never blindly retried; your reason and unrelated drafts are retained.</p>}
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}{notice && <p role="status" className="awards-help">{notice}</p>}
      <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !pending.current) { setConfirmation(null); setAcknowledged(false); } }}><DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Reopen this finalised award’s review?</DialogTitle><DialogDescription>This exceptional stage change does not reopen applications, start rounds, change evidence/scores, retract publications, alter certificates or resend mail.</DialogDescription></DialogHeader>
        {confirmation && <div className="space-y-4 text-sm"><p className="font-semibold break-words">{confirmation.name}</p><p>{confirmation.state.replaceAll('_', ' ')} → judging · expected award version {confirmation.version} · new version {confirmation.version + 1}.</p><p className="whitespace-pre-wrap break-words">Reason: {confirmation.reason}</p>
          <label className="flex items-start gap-3"><input type="checkbox" checked={acknowledged} disabled={busy || disabled} onChange={event => setAcknowledged(event.target.checked)} /><span>I explicitly authorise this review-only reopening. I understand that affected publications must be retracted, outcomes/shortlists/moderation reopened in reverse dependency order, and rounds reopened separately with future deadlines before the affected reassessment. No such action happens automatically.</span></label>
          {stale && <p role="alert" className="text-red-800">The award state/version changed. Return to your retained reason and explicitly re-read metadata before a new confirmation.</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { setConfirmation(null); setAcknowledged(false); }}>Return (keep reason)</Button><Button type="button" disabled={busy || disabled || !canEdit || blocked || !!confirmed || stale || !finalised(award.state) || !acknowledged} onClick={async () => {
            if (pending.current || disabled || !canEdit || blocked || confirmed || stale || !finalised(award.state) || !acknowledged) return;
            pending.current = true; attempted.current = true; setBusy(true); setError(''); setNotice('');
            let saved = null;
            try {
              const result = await decisionRequest(tenant, '/api/awards/lifecycle', { command: 'reopen_award', awardId: confirmation.awardId, version: confirmation.version, reason: confirmation.reason });
              tenant.assertCurrent();
              if (!validAward(result?.award, award, tenant) || result.award.state !== 'judging' || result.award.version !== confirmation.version + 1) throw new Error('The server did not confirm the exact review-only reopening/version. Re-read metadata before another confirmation.');
              saved = result.award;
              if (!alive.current) return;
              setConfirmed(saved); setBlocked(true); setConfirmation(null); setAcknowledged(false);
              await callbacks.current.onMetadataChanged(saved); tenant.assertCurrent();
              queryClient.invalidateQueries({ queryKey: ['award-audit-history', tenant.scopeKey, award.id] });
              const fresh = await callbacks.current.refreshMetadata(); tenant.assertCurrent();
              if (!validAward(fresh, award, tenant)) throw new Error('The current award metadata could not be reconciled.');
              if (alive.current) { setBlocked(false); setNotice(`Review reopening was confirmed. Current server stage “${fresh.state}”, version ${fresh.version}, re-read without resetting configuration, binding or round drafts. Dependency handling and round reopening remain separate.`); }
            } catch (failure) {
              if (alive.current) {
                setBlocked(true); setConfirmation(null); setAcknowledged(false);
                setError(saved ? `Reopening at version ${saved.version} was confirmed, but metadata reconciliation failed: ${failure.message}. Do not repeat the write.`
                  : `${failure.message} The request may have committed. Your reason is retained; explicitly re-read current metadata before any new confirmation.`);
              }
            } finally { pending.current = false; if (alive.current) setBusy(false); }
          }}>{busy ? 'Awaiting server confirmation…' : 'Confirm review-only reopening'}</Button></DialogFooter>
        </div>}
      </DialogContent></Dialog>
      <Dialog open={!!guard.pending} onOpenChange={open => { if (!open) guard.stay(); }}><DialogContent className="awards-workspace"><DialogHeader><DialogTitle>Leave retained review reopening inputs?</DialogTitle><DialogDescription>{busy ? 'Wait for the current request and its reconciliation before leaving.' : 'Leaving discards the local reopening reason/confirmation. It does not undo an accepted server change. An unconfirmed write must be reconciled, not blindly retried.'}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={guard.stay}>Stay here</Button><Button type="button" variant="destructive" disabled={busy} onClick={guard.discard}>Discard local reopening inputs and leave</Button></DialogFooter></DialogContent></Dialog>
    </CardContent>
  </Card>;
}
