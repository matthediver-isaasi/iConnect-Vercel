import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { TimezoneAwareDateTimeInput } from '@/components/events/TimezoneAwareDateTimeInput';
import { appointmentLabel, roundAdminRequest, roundAppointmentsKey } from './useRoundAdministration';

export default function AppointmentAvailabilityDialog({ appointment, roundId, timezone, tenant, appointmentsQuery, labels, disabled, onClose, onDirtyChange, onBusyChange, onChanged, onUncertainChange }) {
  const queryClient = useQueryClient();
  const [base, setBase] = useState(appointment);
  const [available, setAvailable] = useState(appointment.available);
  const [capacity, setCapacity] = useState(appointment.capacity == null ? '' : String(appointment.capacity));
  const [expiresAt, setExpiresAt] = useState(appointment.expires_at || '');
  const [pendingDate, setPendingDate] = useState(null);
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(true), callbacks = useRef({ onDirtyChange, onBusyChange, onChanged, onUncertainChange, onClose });
  callbacks.current = { onDirtyChange, onBusyChange, onChanged, onUncertainChange, onClose };
  const dirty = available !== appointment.available || capacity !== (appointment.capacity == null ? '' : String(appointment.capacity)) || expiresAt !== (appointment.expires_at || '') || Boolean(reason || pendingDate?.localValue);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const current = appointmentsQuery.data?.find(item => item.id === base.id && item.round_id === roundId);
  const stale = appointmentsQuery.isSuccess && current?.version !== base.version;
  const extending = Boolean(base.expires_at && Date.parse(expiresAt) > Date.parse(base.expires_at));
  const ready = appointmentsQuery.isSuccess && !appointmentsQuery.isFetching && Boolean(current) && !stale && !blocked;
  const close = () => { if (!busy && (!dirty || window.confirm('Discard the unsaved appointment availability choices and reason?'))) callbacks.current.onClose(); };
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Edit appointment availability</DialogTitle><DialogDescription>Changes apply to this appointment only; they do not accept or reinstate a revoked appointment. They do not resend invitations, extend issued invitation links or extend already-issued restricted sessions. Shortening appointment access may end access earlier; a separate resend is required when appropriate.</DialogDescription></DialogHeader>
    <p className="awards-help break-words">{appointmentLabel(base, labels)} · {base.role} · {base.state} · version {base.version}</p>
    <form className="space-y-4" onSubmit={async event => {
      event.preventDefault(); if (pending.current || disabled || !ready || !reason.trim()) return;
      const count = Number(capacity);
      if (!capacity.trim() || !Number.isSafeInteger(count) || count < 0 || count > 10000) { setError('Enter a whole-number capacity from 0 to 10,000.'); return; }
      if (pendingDate?.error || !expiresAt || !/(Z|[+-]\d{2}:\d{2})$/.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) { setError('Choose a resolved future expiry with an explicit timezone. A blank expiry is not supported for this update.'); return; }
      if (extending && !acknowledged) { setError('Acknowledge that extending appointment expiry does not extend issued sessions or links.'); return; }
      if (!window.confirm(`Save ${available ? 'available' : 'unavailable'} status, capacity ${count}, and appointment expiry ${expiresAt}? Existing invitation links and restricted sessions keep their own expiry. No invitation is sent by this action.`)) return;
      pending.current = true; setBusy(true); setError('');
      try {
        tenant.assertCurrent();
        const result = await roundAdminRequest(tenant, '/api/awards/assignment-controls', { body: { command: 'availability', id: base.id, version: base.version, available, capacity: count, expiresAt, reason: reason.trim() } });
        if (result.id !== base.id || !Number.isSafeInteger(result.version) || result.version <= base.version || result.available !== available || result.capacity !== count || Date.parse(result.expires_at) !== Date.parse(expiresAt)) throw new Error('The server did not confirm all appointment settings. Reload before retrying.');
        queryClient.setQueryData(roundAppointmentsKey(tenant, roundId), old => old?.map(item => item.id === base.id ? { ...item, ...result } : item));
        if (!alive.current) return;
        callbacks.current.onChanged(); callbacks.current.onUncertainChange(true);
        callbacks.current.onClose(result);
        const refreshed = await appointmentsQuery.refetch(); tenant.assertCurrent();
        callbacks.current.onUncertainChange(Boolean(refreshed.error));
      } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); callbacks.current.onUncertainChange(true); callbacks.current.onChanged(); } }
      finally { pending.current = false; if (alive.current) setBusy(false); }
    }}>
      <fieldset disabled={busy || disabled} className="space-y-4">
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={available} onChange={event => setAvailable(event.target.checked)} />Available for allocation / restoration</label>
        <div className="awards-field"><Label htmlFor="availability-capacity">Capacity (0–10,000 applications)</Label><Input id="availability-capacity" type="number" min="0" max="10000" step="1" value={capacity} onChange={event => setCapacity(event.target.value)} /><p className="awards-help">The server rejects a capacity below the current assigned workload. Remove or reallocate that workload separately first.</p></div>
        <div className="awards-field"><Label htmlFor="availability-expiry">Future appointment expiry (required, {timezone})</Label><TimezoneAwareDateTimeInput id="availability-expiry" strict tz={timezone} value={expiresAt} pendingLocalValue={pendingDate?.localValue} onChange={(iso, meta) => { setExpiresAt(iso); setPendingDate(meta?.localValue === '' ? null : meta); setAcknowledged(false); }} /><p className="awards-help">Current server expiry: {base.expires_at || 'No expiry recorded'}. The chosen instant must include its timezone; ambiguous local times must be resolved.</p></div>
        {extending && <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>I understand this later appointment expiry does not extend already-issued sessions or links, and no invitation is automatically resent.</span></label>}
        <div className="awards-field"><Label htmlFor="availability-reason">Reason (required)</Label><Textarea id="availability-reason" required maxLength={20000} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></div>
      </fieldset>
      {(blocked || stale) && <p role="alert" className="text-sm text-amber-800">Reload this appointment’s current version before another write. Your availability, capacity, expiry and reason choices are retained.</p>}
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      {notice && <p role="status" className="awards-help">{notice}</p>}
      <Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={async () => {
        if (pending.current) return; pending.current = true; setBusy(true); setError('');
        try {
          const result = await appointmentsQuery.refetch(); tenant.assertCurrent();
          if (result.error) throw result.error;
          const fresh = result.data.find(item => item.id === base.id && item.round_id === roundId);
          if (!fresh) throw new Error('The selected appointment is no longer available in this round.');
          if (alive.current) { setBase(fresh); setBlocked(false); setAcknowledged(false); setNotice('Current server version loaded. Your proposed choices and reason remain unchanged; review and confirm them explicitly.'); callbacks.current.onUncertainChange(false); callbacks.current.onChanged(); }
        } catch (failure) { if (alive.current) setError(failure.message); }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      }}>Reload appointment version (keep choices)</Button>
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel availability edit</Button><Button type="submit" disabled={busy || disabled || !ready || !reason.trim() || (extending && !acknowledged)}>{busy ? 'Recording…' : 'Confirm appointment settings…'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
