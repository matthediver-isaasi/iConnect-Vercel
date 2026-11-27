import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatMembershipDate } from '@/lib/canvasMembershipData';
import { memberChangeEndpoint, readMemberChangeResponse } from '@/lib/memberChangeRequests';

const MAX_REASON = 1000;

// Member calls never send a member identifier: the server uses the session.
export async function memberDdCancellationRequest(action, payload = {}, { tenantId, signal } = {}) {
  return readMemberChangeResponse(await fetch(memberChangeEndpoint, {
    method: 'POST', credentials: 'include', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}) },
    body: JSON.stringify({ ...payload, action }),
  }));
}

const newKey = () => `member-dd-cancel:${typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function MemberDdCancellationNotice({ request, role }) {
  if (!request) return null;
  const date = formatMembershipDate(request.effectiveDate);
  const paidThrough = formatMembershipDate(request.paidThroughDate);
  return (
    <div data-testid="member-dd-cancellation-notice" role="status" style={{ marginTop: 16 }}>
      <p {...role('status', { color: request.state === 'cancelled' ? '#667085' : '#865d10' })}>
        {request.state === 'cancelled' ? 'Cancelled' : `Cancellation scheduled for ${date}`}
      </p>
      {request.state === 'scheduled' && <p {...role('supporting', { marginTop: 8 })}>
        Your membership stays active until {paidThrough}. From {date}
        {request.fallbackRoleName ? ` your access changes to ${request.fallbackRoleName}.` : ' your access changes.'}
        {' '}No new membership payments will be collected.
      </p>}
      {request.needsReview && <p {...role('supporting', { marginTop: 8 })}>
        We are confirming with your bank that your Direct Debit has stopped. If a payment that was already
        on its way is collected, the membership team will review it. Your cancellation date will not change.
      </p>}
    </div>
  );
}

export function MemberDdCancellationAction({ tenantId, asEditor = false }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState('reason');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const key = useRef(null);
  const reset = () => { setStep('reason'); setPreview(null); setError(''); setBusy(false); setDone(null); key.current = null; };
  const close = next => {
    if (busy) return;
    setOpen(next);
    if (!next) {
      if (done) queryClient.invalidateQueries({ queryKey: ['canvas-membership-summary'] });
      reset(); setReason('');
    }
  };
  const trimmed = reason.trim();
  async function review(event) {
    event.preventDefault();
    if (!trimmed) { setError('Please tell us why you are cancelling.'); return; }
    setBusy(true); setError('');
    try {
      const result = await memberDdCancellationRequest('member_dd_cancellation_preview', { reason: trimmed }, { tenantId });
      if (!result.eligible) {
        setError(result.message || 'Your membership cannot be cancelled online. Please contact your membership team.');
      } else { setPreview(result); setStep('confirm'); key.current = newKey(); }
    } catch (failure) {
      setError(failure.message || 'We could not check your membership. Nothing has changed.');
    } finally { setBusy(false); }
  }
  async function confirm() {
    if (busy || !preview) return;
    setBusy(true); setError('');
    try {
      const result = await memberDdCancellationRequest('member_dd_cancellation_confirm', {
        reason: trimmed, fingerprint: preview.fingerprint, idempotencyKey: key.current, approve: true,
      }, { tenantId });
      setDone(result.request); setStep('done');
      queryClient.invalidateQueries({ queryKey: ['canvas-membership-summary'] });
    } catch (failure) {
      // A lost response is safe to repeat with the same key.
      setError(failure.status === 409 && /changed/i.test(failure.message || '')
        ? failure.message
        : `${failure.message || 'We could not confirm the cancellation.'} You can try again safely; you will not be cancelled twice.`);
    } finally { setBusy(false); }
  }
  const s = preview?.summary;
  return (
    <>
      <button type="button" data-testid="member-dd-cancel-link"
        onClick={asEditor ? undefined : () => setOpen(true)}
        style={{ background: 'none', border: 0, padding: 0, marginTop: 16, cursor: 'pointer',
          textDecoration: 'underline', font: 'inherit', fontSize: 14, color: '#667085', display: 'block' }}>
        Cancel membership
      </button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent data-testid="member-dd-cancel-dialog" className="sm:max-w-lg">
          {step === 'reason' && <form onSubmit={review}>
            <DialogHeader>
              <DialogTitle>Cancel your membership</DialogTitle>
              <DialogDescription>
                Tell us why you are cancelling. You will see the dates and what changes before anything is cancelled.
              </DialogDescription>
            </DialogHeader>
            <div style={{ marginTop: 16 }}>
              <Label htmlFor="member-dd-cancel-reason">Reason for cancelling (required)</Label>
              <Textarea id="member-dd-cancel-reason" value={reason} required maxLength={MAX_REASON}
                aria-invalid={!!error && !trimmed} aria-describedby="member-dd-cancel-error"
                onChange={event => setReason(event.target.value)} rows={4} style={{ marginTop: 8 }} />
            </div>
            {error && <p id="member-dd-cancel-error" role="alert" style={{ marginTop: 12, color: '#b42318' }}>{error}</p>}
            <DialogFooter style={{ marginTop: 20 }}>
              <Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>Keep my membership</Button>
              <Button type="submit" disabled={busy || !trimmed}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}Continue
              </Button>
            </DialogFooter>
          </form>}
          {step === 'confirm' && s && <div>
            <DialogHeader>
              <DialogTitle>Confirm cancellation</DialogTitle>
              <DialogDescription>Please check these details. Nothing has been cancelled yet.</DialogDescription>
            </DialogHeader>
            <dl data-testid="member-dd-cancel-summary" style={{ display: 'grid', gap: 12, marginTop: 16 }}>
              <div><dt style={{ fontWeight: 600 }}>Paid up to</dt><dd>{formatMembershipDate(s.paidThroughDate)}</dd></div>
              <div><dt style={{ fontWeight: 600 }}>Access changes on</dt><dd>{formatMembershipDate(s.effectiveDate)}</dd></div>
              <div><dt style={{ fontWeight: 600 }}>Your access after that</dt><dd>{s.fallbackRoleName || 'Non-member access'}</dd></div>
              <div><dt style={{ fontWeight: 600 }}>Future payments</dt>
                <dd>No new membership payments will be taken after you confirm.
                  {s.collectionsInFlight > 0 ? ' A payment already sent to your bank may still be collected; the membership team will review it.' : ''}</dd></div>
            </dl>
            {error && <p role="alert" style={{ marginTop: 12, color: '#b42318' }}>{error}</p>}
            <DialogFooter style={{ marginTop: 20 }}>
              <Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>Keep my membership</Button>
              <Button type="button" variant="destructive" onClick={confirm} disabled={busy} data-testid="member-dd-cancel-confirm">
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}Confirm cancellation
              </Button>
            </DialogFooter>
          </div>}
          {step === 'done' && <div>
            <DialogHeader>
              <DialogTitle>Cancellation scheduled</DialogTitle>
              <DialogDescription>
                Your membership stays active until {formatMembershipDate(done?.paidThroughDate)}.
              </DialogDescription>
            </DialogHeader>
            {done?.needsReview && <p role="status" style={{ marginTop: 12 }}>
              We are still confirming with your bank that your Direct Debit has stopped. The membership team will follow up if needed.
            </p>}
            <DialogFooter style={{ marginTop: 20 }}>
              <Button type="button" onClick={() => close(false)}>Close</Button>
            </DialogFooter>
          </div>}
        </DialogContent>
      </Dialog>
    </>
  );
}
