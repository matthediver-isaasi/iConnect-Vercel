import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { TimezoneAwareDateTimeInput } from '@/components/events/TimezoneAwareDateTimeInput';
import { appointmentLabel, roundAdminRequest, roundAppointmentsKey } from './useRoundAdministration';
import AppointmentAvailabilityDialog from './AppointmentAvailabilityDialog';

export default function AppointmentManager({ round, timezone, tenant, appointmentsQuery, disabled, reconciliationRequired, runCommand, labels, onLabelsChange, onDirtyChange, onBusyChange, onChanged, onUncertainChange }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState('member');
  const [search, setSearch] = useState('');
  const [lookup, setLookup] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('judge');
  const [capacity, setCapacity] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [pendingDate, setPendingDate] = useState(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [invitation, setInvitation] = useState(null);
  const [reason, setReason] = useState('');
  const [availability, setAvailability] = useState(null);
  const [availabilityDirty, setAvailabilityDirty] = useState(false);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const callbacks = useRef({ onDirtyChange, onBusyChange, onChanged, onLabelsChange });
  callbacks.current = { onDirtyChange, onBusyChange, onChanged, onLabelsChange };
  const dirty = availabilityDirty || Boolean(identity || email || name || capacity || expiresAt || pendingDate?.localValue || reason || role !== 'judge');
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy || availabilityBusy); }, [busy, availabilityBusy]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  const identities = useQuery({
    queryKey: ['award-appointment-identities', tenant.scopeKey, lookup?.kind, lookup?.search, lookup?.page],
    enabled: Boolean(lookup),
    queryFn: ({ signal }) => roundAdminRequest(tenant, `/api/awards/appointments?kind=${lookup.kind}&search=${encodeURIComponent(lookup.search)}&page=${lookup.page}`, { signal }),
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const appointments = appointmentsQuery.data || [];
  const pages = Math.max(1, Math.ceil(appointments.length / 10));
  const currentPage = Math.min(page, pages);
  const duplicate = person => appointments.some(appointment => person.kind === 'member' ? appointment.member_id === person.id : appointment.contact_id === person.id);
  const reset = () => { setIdentity(null); setEmail(''); setName(''); setCapacity(''); setExpiresAt(''); setPendingDate(null); setRole('judge'); };
  const switchKind = value => { setKind(value); setIdentity(null); setEmail(''); setName(''); setLookup(null); setSearch(''); setError(''); };
  return <section className="border-t pt-6 mt-6 space-y-5">
    <fieldset disabled={availabilityBusy || reconciliationRequired} className="min-w-0 space-y-5">
    <div className="flex flex-wrap justify-between items-center gap-3"><div><h3 className="font-semibold">Appointments & invitations</h3><p className="awards-help">Use an existing member/contact or explicitly appoint an external email. No new member identity is created.</p></div><Button size="sm" variant="outline" disabled={disabled || busy || appointmentsQuery.isFetching} onClick={() => appointmentsQuery.refetch()}>Refresh appointments</Button></div>
    {appointmentsQuery.isLoading ? <Skeleton className="h-20 w-full" /> : appointmentsQuery.isError ? <div role="alert" className="text-sm text-red-800">{appointmentsQuery.error.message}<Button className="mt-2 block" variant="outline" onClick={() => appointmentsQuery.refetch()}>Retry full appointment list</Button></div>
      : appointments.length ? <><ul className="divide-y rounded-lg border">{appointments.slice((currentPage - 1) * 10, currentPage * 10).map(appointment => <li className="p-4" key={appointment.id}>
        <p className="text-sm font-medium break-words">{appointmentLabel(appointment, labels)}</p><p className="awards-help mt-1">{appointment.role} · {appointment.state} · Capacity {appointment.capacity} · {appointment.available ? 'Available' : 'Unavailable'}</p>
        {appointment.expires_at && <p className="awards-help">Expires: {new Date(appointment.expires_at).toLocaleString()} · UTC instant {appointment.expires_at}</p>}
        <div className="flex flex-wrap gap-2 mt-3"><Button type="button" size="sm" variant="outline" disabled={disabled || busy || !appointmentsQuery.isSuccess || appointmentsQuery.isFetching} onClick={() => { setAvailability(appointment); setNotice(''); }}>Edit availability</Button><Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => { setInvitation({ appointment, revoke: false }); setReason(''); setError(''); }}>Queue / resend invitation</Button>
          {appointment.state !== 'revoked' && <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => { setInvitation({ appointment, revoke: true }); setReason(''); setError(''); }}>Revoke access</Button>}</div>
      </li>)}</ul>
      {pages > 1 && <div className="flex justify-between items-center gap-2"><Button size="sm" variant="outline" disabled={disabled || busy || currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous appointments</Button><span className="awards-help">{currentPage} / {pages} · {appointments.length} appointments</span><Button size="sm" variant="outline" disabled={disabled || busy || currentPage >= pages} onClick={() => setPage(currentPage + 1)}>Next appointments</Button></div>}</>
        : <p className="awards-help rounded-lg border p-5">No appointments have been created for this round.</p>}
    <div className="rounded-lg border p-4 space-y-4">
      <h4 className="font-semibold text-sm">Add an appointment</h4>
      <fieldset disabled={disabled || busy || !appointmentsQuery.isSuccess} className="space-y-4">
        <div className="awards-field"><Label htmlFor="appointment-kind">Identity source</Label><select id="appointment-kind" className="awards-select" value={kind} onChange={event => switchKind(event.target.value)}><option value="member">Existing member</option><option value="contact">Existing organisation contact</option><option value="external">External email</option></select></div>
        {kind !== 'external' ? <>
          <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (search.trim().length >= 2) { setIdentity(null); setLookup({ kind, search: search.trim(), page: 1 }); } }}>
            <div className="awards-field flex-1 min-w-0"><Label htmlFor="appointment-search">Search by name or email (at least 2 characters)</Label><Input id="appointment-search" minLength={2} maxLength={200} value={search} onChange={event => setSearch(event.target.value)} /></div><Button type="submit" variant="outline" disabled={search.trim().length < 2}>Search identities</Button>
          </form>
          {lookup && (identities.isLoading ? <Skeleton className="h-16 w-full" /> : identities.isError ? <div role="alert" className="text-sm text-red-800">{identities.error.message}<Button size="sm" variant="outline" className="ml-2" onClick={() => identities.refetch()}>Retry search</Button></div>
            : <div className="space-y-3"><fieldset className="space-y-2"><legend className="text-sm font-medium mb-2">Choose one canonical identity</legend>
              {identities.data?.identities?.length ? identities.data.identities.map(person => <label key={`${person.kind}:${person.id}`} className="flex items-start gap-3 rounded border p-3 text-sm">
                <input type="radio" className="mt-1" name="appointment-identity" disabled={duplicate(person)} checked={identity?.id === person.id && identity?.kind === person.kind} onChange={() => {
                  setIdentity(person); callbacks.current.onLabelsChange(`${person.kind}:${person.id}`, `${person.label}${person.email ? ` · ${person.email}` : ''}`);
                }} /><span className="min-w-0"><span className="block font-medium break-words">{person.label}</span><span className="awards-help block break-words">{person.email}{duplicate(person) ? ' · Already appointed' : person.kind === 'member' ? person.loginEnabled ? ' · Member login enabled' : ' · Member login not enabled' : ''}</span></span>
              </label>) : <p className="awards-help">No identities match this search. Try another name or email; an email match is not selected automatically.</p>}
            </fieldset><div className="flex justify-between items-center gap-2"><Button size="sm" variant="outline" disabled={lookup.page <= 1} onClick={() => setLookup(old => ({ ...old, page: old.page - 1 }))}>Previous matches</Button><span className="awards-help">Search page {lookup.page}</span><Button size="sm" variant="outline" disabled={(identities.data?.identities?.length || 0) < (identities.data?.pageSize || 25)} onClick={() => setLookup(old => ({ ...old, page: old.page + 1 }))}>More matches</Button></div></div>)}
          {identity && <p role="status" className="text-sm">Selected: {identity.label}{identity.email ? ` · ${identity.email}` : ''}</p>}
        </> : <div className="grid md:grid-cols-2 gap-4"><div className="awards-field"><Label htmlFor="appointment-email">External email</Label><Input id="appointment-email" type="email" required value={email} onChange={event => setEmail(event.target.value)} /></div><div className="awards-field"><Label htmlFor="appointment-external-name">External name</Label><Input id="appointment-external-name" value={name} onChange={event => setName(event.target.value)} /></div></div>}
        <p className="awards-help">Existing canonical emails and duplicate round appointments are rejected by the server. Ambiguous search matches require your explicit selection.</p>
        <div className="grid md:grid-cols-2 gap-4"><div className="awards-field"><Label htmlFor="appointment-role">Role</Label><select id="appointment-role" className="awards-select" value={role} onChange={event => setRole(event.target.value)}><option value="judge">Judge</option><option value="chair">Chair</option><option value="approver">Approver</option></select></div><div className="awards-field"><Label htmlFor="appointment-capacity">Capacity (applications, 0–10,000)</Label><Input id="appointment-capacity" type="number" min="0" max="10000" step="1" value={capacity} onChange={event => setCapacity(event.target.value)} /></div></div>
        <div className="awards-field"><Label htmlFor="appointment-expiry">Appointment expiry (optional, {timezone})</Label><TimezoneAwareDateTimeInput id="appointment-expiry" strict tz={timezone} value={expiresAt} pendingLocalValue={pendingDate?.localValue} onChange={(iso, meta) => { setExpiresAt(iso); setPendingDate(meta?.localValue === '' ? null : meta); }} /><p className="awards-help">Leaving this blank sets no appointment expiry. Invitation links and restricted sessions still follow the server’s expiry policy.</p></div>
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={kind === 'external' ? !email.trim() : !identity} onClick={async () => {
          if (pending.current) return;
          setError(''); setNotice('');
          const count = Number(capacity);
          if (!capacity.trim() || !Number.isSafeInteger(count) || count < 0 || count > 10000) { setError('Enter a whole-number capacity between 0 and 10,000.'); return; }
          if (pendingDate?.error || (expiresAt && Date.parse(expiresAt) <= Date.now())) { setError('Choose a resolved appointment expiry in the future, or leave it blank.'); return; }
          if (kind === 'external' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Enter a valid external email address.'); return; }
          if (kind !== 'external' && (!identity || duplicate(identity))) { setError('Select a canonical identity that is not already appointed.'); return; }
          if (kind === 'external' && appointments.some(item => item.external_email?.toLowerCase() === email.trim().toLowerCase())) { setError('This external email already has a round appointment.'); return; }
          pending.current = true; setBusy(true);
          try {
            await runCommand('appoint', round, { ...(kind === 'external' ? { external_email: email.trim(), external_name: name.trim() } : kind === 'member' ? { member_id: identity.id } : { contact_id: identity.id }), role, capacity: count, expires_at: expiresAt || null });
            if (!alive.current) return;
            reset(); setNotice('Appointment created. No invitation has been queued by this action.'); callbacks.current.onChanged();
            await appointmentsQuery.refetch();
          } catch (failure) { if (alive.current) setError(failure.message); }
          finally { pending.current = false; if (alive.current) setBusy(false); }
        }}>Create appointment</Button><Button type="button" variant="outline" onClick={() => { if (!dirty || window.confirm('Discard the appointment draft?')) reset(); }}>Clear appointment draft</Button></div>
      </fieldset>
    </div>
    {error && !invitation && <p role="alert" className="text-sm text-red-800">{error} Inputs are retained. Reload the server round version if it changed.</p>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    </fieldset>
    {availability && <AppointmentAvailabilityDialog key={availability.id} appointment={availability} roundId={round.id} timezone={timezone} tenant={tenant} appointmentsQuery={appointmentsQuery} labels={labels}
      disabled={disabled || busy} onDirtyChange={setAvailabilityDirty} onBusyChange={setAvailabilityBusy} onChanged={onChanged} onUncertainChange={onUncertainChange}
      onClose={result => { setAvailability(null); if (result) setNotice(`Appointment availability saved at server version ${result.version}. Already-issued session and invitation expiries were not extended; no invitation was queued.`); }} />}
    <Dialog open={Boolean(invitation)} onOpenChange={open => { if (!open && !busy && (!reason || window.confirm('Discard the unsaved invitation action reason?'))) { setInvitation(null); setReason(''); } }}>
      <DialogContent className="awards-workspace"><DialogHeader><DialogTitle>{invitation?.revoke ? 'Revoke judging access' : 'Queue / resend judging invitation'}</DialogTitle><DialogDescription>Earlier invitation links and restricted sessions are invalidated. Saved assessment drafts are retained. Credential revocation blocks access; it does not exclude completed scores. Change completed score inclusion explicitly through Assignment controls. Queued delivery is not confirmation that an invitation was sent.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={async event => {
          event.preventDefault(); if (pending.current || !invitation || !reason.trim()) return;
          pending.current = true; setBusy(true); setError(''); setNotice('');
          try {
            const result = await roundAdminRequest(tenant, '/api/awards/invitations', { body: { appointmentId: invitation.appointment.id, version: invitation.appointment.version, revoke: invitation.revoke, reason: reason.trim() } });
            if (result.appointment_id !== invitation.appointment.id || !Number.isSafeInteger(result.version) || (!invitation.revoke && result.delivery !== 'queued')) throw new Error('The server did not confirm the invitation action. Refresh appointments before retrying.');
            queryClient.setQueryData(roundAppointmentsKey(tenant, round.id), old => old?.map(item => item.id === result.appointment_id ? { ...item, version: result.version, state: result.state } : item));
            if (!alive.current) return;
            setNotice(invitation.revoke ? 'Access revoked. Earlier restricted sessions and links are invalid. Completed score inclusion is unchanged; use Assignment controls to explicitly exclude a score.' : 'Invitation queued for delivery. Sending has not been confirmed.');
            setInvitation(null); setReason(''); callbacks.current.onChanged(); await appointmentsQuery.refetch();
          } catch (failure) { if (alive.current) setError(failure.message); }
          finally { pending.current = false; if (alive.current) setBusy(false); }
        }}>
          <Label htmlFor="invitation-action-reason">Reason (required)</Label><Textarea id="invitation-action-reason" required maxLength={10000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} />
          {error && <p role="alert" className="text-sm text-red-800">{error} The reason is retained. Refresh appointments before retrying if the version changed.</p>}
          {error && <Button type="button" variant="outline" disabled={busy} onClick={async () => {
            if (pending.current) return;
            pending.current = true; setBusy(true);
            try {
              const refreshed = await appointmentsQuery.refetch();
              tenant.assertCurrent();
              if (refreshed.error) throw refreshed.error;
              const fresh = refreshed.data.find(item => item.id === invitation.appointment.id);
              if (!fresh) throw new Error('The appointment is no longer available. The reason is retained.');
              if (alive.current) { setInvitation(old => ({ ...old, appointment: fresh })); setError(''); }
            } catch (failure) { if (alive.current) setError(failure.message); }
            finally { pending.current = false; if (alive.current) setBusy(false); }
          }}>Refresh appointment (keep reason)</Button>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { if (!reason || window.confirm('Discard the unsaved invitation action reason?')) { setInvitation(null); setReason(''); } }}>Cancel</Button><Button type="submit" disabled={busy || !reason.trim()}>{busy ? 'Recording…' : invitation?.revoke ? 'Confirm revocation' : 'Confirm queue / resend'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </section>;
}
