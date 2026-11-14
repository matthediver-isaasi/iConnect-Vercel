import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { communicationKey, communicationRequest, messageLabel } from './useAwardCommunications';

const allowed = (data, action) => action === 'retry' ? data?.canRetry === true && data.providerOutcomeUncertain === false
  : action === 'cancel' && data?.canCancel === true;
const fingerprint = data => data ? JSON.stringify([data.id, data.version, data.state, data.canRetry, data.canCancel, data.providerOutcomeUncertain]) : '';

export default function CommunicationDeliveryControl(props) {
  return <DeliveryControl key={`${props.tenant.scopeKey}:${props.award.id}:${props.delivery.id}`} {...props} />;
}

function DeliveryControl({ tenant, award, delivery, available, disabled, onChanged, onClose, onDirtyChange, onBusyChange }) {
  const [action, setAction] = useState(''), [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState(null), [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [confirmed, setConfirmed] = useState(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(false), attempted = useRef(false), callbacks = useRef({});
  callbacks.current = { onChanged, onClose, onDirtyChange, onBusyChange };
  const queryClient = useQueryClient();
  const key = [...communicationKey(tenant, award.id), 'delivery-control', delivery.id];
  const query = useQuery({
    queryKey: key, enabled: available,
    queryFn: async ({ signal }) => {
      try {
        const data = await communicationRequest(tenant, `/api/awards/communications?awardId=${encodeURIComponent(award.id)}&deliveryId=${encodeURIComponent(delivery.id)}`, { signal });
        if (data.id !== delivery.id || typeof data.state !== 'string' || !data.state
          || typeof data.version !== 'string' || !/^[a-f0-9]{32}$/.test(data.version)
          || ['canRetry', 'canCancel', 'providerOutcomeUncertain'].some(field => typeof data[field] !== 'boolean')
          || (data.canRetry && data.providerOutcomeUncertain)) throw new Error('The server recovery capabilities/version are incomplete or contradictory. No control is authorised from this read.');
        return data;
      } catch (failure) {
        if (!signal.aborted) {
          queryClient.setQueryData(key, null);
          if (alive.current) { setBlocked(true); setConfirmation(null); setAcknowledged(false); }
        }
        throw failure;
      }
    },
    gcTime: 0, staleTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const ready = available && query.isSuccess && !query.isFetching && !query.isError && !!query.data;
  const data = ready ? query.data : null;
  const dirty = (!confirmed && !!(action || reason || confirmation)) || (blocked && attempted.current);
  const canReview = ready && !disabled && !busy && !blocked && !confirmed && allowed(data, action) && !!reason.trim() && reason.length <= 2000;
  const unchanged = !!confirmation && fingerprint(data) === fingerprint(confirmation.capabilities);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  const reconcile = async () => {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); setError(''); setConfirmation(null); setAcknowledged(false);
    try {
      const result = await query.refetch(); tenant.assertCurrent();
      if (result.error || !result.data) throw result.error || new Error('Current delivery recovery authority could not be read.');
      await callbacks.current.onChanged(); tenant.assertCurrent();
      if (!alive.current) return;
      setBlocked(false);
      setNotice(confirmed
        ? 'The prior control command was confirmed and has not been repeated. Current server capabilities and delivery history are refreshed; later worker activity may already have changed the record.'
        : 'Current server capabilities/version and history re-read. Your action/reason are retained. The earlier command may have committed; current state alone does not prove whether your reason was recorded. Only a currently authorised action can receive a new explicit confirmation.');
    } catch (failure) { if (alive.current) { setBlocked(true); setError(failure.message); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const close = () => {
    if (pending.current || disabled) return;
    if (dirty && !window.confirm(`${attempted.current && blocked && !confirmed ? 'The previous command may have committed. ' : ''}Discard only this delivery-control action/reason and close? Other communication drafts are unchanged. No command is automatically retried.`)) return;
    callbacks.current.onClose();
  };
  return <section className="rounded-lg border p-4 space-y-4" aria-label="Server-authorised delivery recovery">
    <div className="flex flex-wrap justify-between gap-3"><div className="min-w-0"><h4 className="font-semibold">Delivery recovery controls</h4><p className="awards-help mt-2">{messageLabel(delivery.category)} · {delivery.label}</p><p className="awards-help break-words">Delivery record: {delivery.id}</p></div><Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={close}>Close delivery controls</Button></div>
    <p className="text-sm">Actions come only from the server’s capabilities, not the history state label. Retry is restricted to definitely-unsent eligible records and queues another attempt—it does not report mail sent. Claimed active or delivered sends cannot be retried or cancelled.</p>
    <p className="text-sm">Cancel stops future attempts; it does not recall delivered mail or prove an uncertain provider attempt was never delivered. Provider uncertainty remains in the audit record.</p>
    <Button type="button" size="sm" variant="outline" disabled={busy || disabled || query.isFetching} onClick={reconcile}>Reconcile capabilities &amp; history (keep reason)</Button>
    {!available ? <p className="awards-help" role="status">History is refreshing or unavailable. Recovery writes are disabled; local action/reason inputs are retained.</p>
      : query.isFetching || query.isPending ? <div aria-label="Loading server recovery capabilities"><Skeleton className="h-20 w-full" /></div>
        : query.isError ? <p role="alert" className="text-sm text-red-700">{query.error.message} Stale capabilities were cleared. Reconcile before a command.</p>
          : data && <div className="space-y-2"><p className="awards-help">Last server-reported state: {data.state}. Capabilities may change when the worker claims or completes an attempt; every write is rechecked.</p>
            {data.providerOutcomeUncertain && <p role="alert" className="rounded-lg border border-amber-200 p-3 text-sm text-amber-900">Possible provider delivery is uncertain. Retry is prohibited. If cancellation is separately authorised, it only stops future attempts; uncertainty is retained, not resolved.</p>}
            {!data.canRetry && !data.canCancel && <p className="awards-help">The server currently authorises neither retry nor cancellation for this delivery. There is no client override.</p>}
          </div>}
    <fieldset disabled={disabled || busy || !!confirmation || !!confirmed} className="space-y-4">
      <div className="awards-field"><Label htmlFor="delivery-control-action">Server-authorised action (choose explicitly)</Label><select id="delivery-control-action" className="awards-select" value={action} disabled={!ready || blocked} onChange={event => { setAction(event.target.value); setAcknowledged(false); }}>
        <option value="">Choose an authorised action</option>
        {action && !allowed(data, action) && <option value={action} disabled>Retained {action} — not currently authorised</option>}
        {data?.canRetry && !data.providerOutcomeUncertain && <option value="retry">Retry — queue another definitely-unsent attempt</option>}
        {data?.canCancel && <option value="cancel">Cancel — stop future attempts, no recall</option>}
      </select></div>
      <div className="awards-field"><Label htmlFor="delivery-control-reason">Control reason (required)</Label><Textarea id="delivery-control-reason" required maxLength={2000} rows={4} value={reason} onChange={event => { setReason(event.target.value); setAcknowledged(false); }} /></div>
    </fieldset>
    {!confirmed && <Button type="button" size="sm" disabled={!canReview} onClick={() => {
      if (!canReview) return;
      tenant.assertCurrent(); setError(''); setAcknowledged(false);
      setConfirmation({ payload: { command: 'delivery_control', awardId: award.id, deliveryId: delivery.id, action, version: data.version, reason: reason.trim() }, capabilities: { ...data } });
    }}>Review delivery control…</Button>}
    {confirmed && <p role="status" className="text-sm">{confirmed.state === 'retry' ? 'Server confirmed another attempt queued (retry), sent: false. This is not confirmation of mail delivery.' : 'Server confirmed cancellation of future attempts, sent: false. This does not recall earlier mail or erase provider uncertainty.'} Close and reopen to review any later, separately authorised operation.</p>}
    {blocked && <p role="alert" className="text-sm text-amber-900">Further commands require an explicit reconciliation. Your action/reason are retained; no automatic retry or optimistic success is applied.</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{notice && <p role="status" className="awards-help">{notice}</p>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !pending.current) { setConfirmation(null); setAcknowledged(false); } }}>
      <DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Confirm delivery {confirmation?.payload.action === 'retry' ? 'retry' : 'cancellation'}</DialogTitle><DialogDescription>This is a separately authorised, versioned control command. It does not change ordinary settings, automatic creation policies or manual scheduling intents.</DialogDescription></DialogHeader>
        {confirmation && <div className="space-y-4 text-sm">
          <p>{messageLabel(delivery.category)} · {delivery.label}</p>
          <p className="break-words">Delivery: {delivery.id} · reviewed server state {confirmation.capabilities.state}.</p>
          <p>{confirmation.payload.action === 'retry' ? 'Queue another attempt for this server-authorised, definitely-unsent delivery. This does not report mail sent.' : 'Stop future attempts for this delivery record. No delivered mail is recalled; any provider outcome uncertainty remains in audit.'}</p>
          {confirmation.capabilities.providerOutcomeUncertain && <p className="text-amber-900">An earlier attempt may have reached the provider. Cancellation cannot establish that it was not delivered.</p>}
          <p className="whitespace-pre-wrap break-words">Reason: {confirmation.payload.reason}</p>
          <label className="flex gap-3 items-start"><input type="checkbox" checked={acknowledged} disabled={busy || disabled} onChange={event => setAcknowledged(event.target.checked)} /><span>I explicitly authorise {confirmation.payload.action} against this exact reviewed server version and understand it does not confirm delivery or recall mail.</span></label>
          {(!ready || !unchanged || !allowed(data, confirmation.payload.action)) && <p role="alert" className="text-red-700">This exact confirmation is no longer backed by current server capabilities/version. Return to retained inputs and reconcile.</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { setConfirmation(null); setAcknowledged(false); }}>Return (keep reason)</Button><Button type="button" disabled={busy || disabled || blocked || !!confirmed || !ready || !unchanged || !acknowledged || !allowed(data, confirmation.payload.action)} onClick={async () => {
            if (pending.current || disabled || blocked || confirmed || !ready || !unchanged || !acknowledged || !allowed(data, confirmation.payload.action)) return;
            pending.current = true; attempted.current = true; setBusy(true); setError(''); setNotice('');
            let saved = null;
            try {
              const result = await communicationRequest(tenant, '/api/awards/communications', { body: confirmation.payload });
              if (result.id !== delivery.id || result.state !== (confirmation.payload.action === 'retry' ? 'retry' : 'cancelled') || result.sent !== false) throw new Error('The server did not confirm the exact control result with sent: false.');
              saved = result; tenant.assertCurrent();
              if (!alive.current) return;
              setConfirmed(result); setBlocked(true); setConfirmation(null); setAcknowledged(false);
              queryClient.setQueryData(key, null);
              queryClient.invalidateQueries({ queryKey: [...communicationKey(tenant, award.id), 'history'], refetchType: 'none' });
              queryClient.invalidateQueries({ queryKey: ['award-audit-history', tenant.scopeKey, award.id] });
              const refreshed = await query.refetch(); tenant.assertCurrent();
              if (refreshed.error || !refreshed.data) throw refreshed.error || new Error('Current recovery capabilities could not be refreshed.');
              await callbacks.current.onChanged(); tenant.assertCurrent();
              if (alive.current) { setBlocked(false); setNotice('Control command confirmed; current capabilities and history refreshed. Later worker activity, not this command, determines any delivery.'); }
            } catch (failure) {
              if (alive.current) {
                queryClient.setQueryData(key, null);
                setBlocked(true); setConfirmation(null); setAcknowledged(false);
                setError(saved ? `The ${saved.state} control was confirmed with sent: false, but reconciliation failed: ${failure.message}. Do not repeat the command.`
                  : `${failure.message} The outcome may have committed. Reconcile current server capabilities/history before any new explicit confirmation. Your action and reason are retained.`);
              }
            } finally { pending.current = false; if (alive.current) setBusy(false); }
          }}>{busy ? 'Awaiting control confirmation…' : `Confirm ${confirmation.payload.action}`}</Button></DialogFooter>
        </div>}
      </DialogContent>
    </Dialog>
  </section>;
}
