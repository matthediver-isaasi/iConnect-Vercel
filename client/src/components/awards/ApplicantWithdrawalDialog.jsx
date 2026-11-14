import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

export default function ApplicantWithdrawalDialog({
  application, reason, onReasonChange, confirmed, onConfirmedChange,
  busy, reloading, blocked, stale, ready, error, notice, loginHref,
  onClose, onReload, onSubmit,
}) {
  const pending = busy || reloading;
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      onEscapeKeyDown={event => { if (pending) event.preventDefault(); }}
      onInteractOutside={event => { if (pending) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>{application.canWithdraw ? 'Withdraw your application?' : 'Application withdrawal status'}</DialogTitle>
        <DialogDescription>{application.canWithdraw
          ? `This records your withdrawal from ${application.awardName}. You cannot undo a withdrawal from this page.`
          : 'Withdrawal is not currently available. The last loaded application details are shown below; your retained reason has not been resubmitted.'}</DialogDescription>
      </DialogHeader>
      <div className="rounded-lg border p-4 text-sm">
        <p className="font-medium break-words">{application.reference}</p>
        <p className="awards-help">Last loaded status: {application.status} · version {application.version}</p>
      </div>
      {error && <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">
        <p>{error.message}</p>
        <p className="mt-2">Your reason is still here. Reload the current status before any further attempt; a failed response does not prove a withdrawal was rejected.</p>
        {error.status === 401 && <a className="mt-2 inline-block underline underline-offset-4" href={loginHref}>Sign in with your member account</a>}
      </div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {stale && <p role="alert" className="text-sm text-destructive">The application version changed. Reload its current status to review whether withdrawal is still available. Your reason will be kept.</p>}
      {!application.canWithdraw && <p className="text-sm">Withdrawal is not currently available for this application. No further withdrawal request can be made here.</p>}
      <Button type="button" variant="outline" disabled={pending} onClick={onReload}>
        {reloading ? 'Reloading current status…' : 'Reload current status (keep reason)'}
      </Button>
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="awards-field">
          <Label htmlFor="applicant-withdrawal-reason">Reason for withdrawal</Label>
          <Textarea id="applicant-withdrawal-reason" value={reason} maxLength={2000} required
            disabled={pending} rows={4} aria-describedby="applicant-withdrawal-help"
            onChange={event => onReasonChange(event.target.value)} />
          <p id="applicant-withdrawal-help" className="awards-help">Required, up to 2,000 characters. Your reason will be recorded with the withdrawal.</p>
        </div>
        <div className="flex items-start gap-3">
          <Checkbox id="applicant-withdrawal-confirm" checked={confirmed}
            disabled={pending || blocked || stale || !ready || !application.canWithdraw}
            onCheckedChange={checked => onConfirmedChange(checked === true)} />
          <Label className="text-sm font-normal leading-6" htmlFor="applicant-withdrawal-confirm">
            I confirm that I want to withdraw application {application.reference}.
          </Label>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Close</Button>
          <Button type="submit" variant="destructive"
            disabled={pending || blocked || stale || !ready || !application.canWithdraw || !confirmed || !reason.trim() || reason.length > 2000}>
            {busy ? 'Recording withdrawal…' : 'Confirm withdrawal'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
