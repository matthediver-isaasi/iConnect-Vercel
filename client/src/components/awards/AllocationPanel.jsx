import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { appointmentLabel, roundAdminRequest, useAllocationApplications } from './useRoundAdministration';

export default function AllocationPanel({ awardId, round, tenant, appointmentsQuery, disabled, labels, changeGeneration, onVersionChange, onDirtyChange, onBusyChange, onUncertain }) {
  const applicationsQuery = useAllocationApplications(tenant, awardId);
  const [mode, setMode] = useState('balanced');
  const [scope, setScope] = useState('selected');
  const [applicationIds, setApplicationIds] = useState([]);
  const [manual, setManual] = useState([]);
  const [pairApplication, setPairApplication] = useState('');
  const [pairAppointment, setPairAppointment] = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [previewPage, setPreviewPage] = useState(1);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmationAttempted, setConfirmationAttempted] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const callbacks = useRef({ onVersionChange, onDirtyChange, onBusyChange, onUncertain });
  callbacks.current = { onVersionChange, onDirtyChange, onBusyChange, onUncertain };
  const dirty = Boolean(applicationIds.length || manual.length || pairApplication || pairAppointment || preview || mode !== 'balanced' || scope !== 'selected');
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  const lastGeneration = useRef(changeGeneration);
  const livePreview = useRef(preview);
  livePreview.current = preview;
  useEffect(() => {
    if (lastGeneration.current !== changeGeneration) {
      setPreview(null); setConfirmationAttempted(false);
      setNotice('Round administration changed. Generate a fresh allocation preview before confirming; your application and manual-pair selections are retained.');
      lastGeneration.current = changeGeneration;
    }
  }, [changeGeneration]);
  useEffect(() => {
    if (livePreview.current && livePreview.current.roundVersion !== round.version) {
      setPreview(null); setConfirmationAttempted(false);
      setNotice('The round version changed. Generate a fresh allocation preview.');
    }
  }, [round.version]);
  const applications = applicationsQuery.isSuccess ? applicationsQuery.data || [] : [];
  const appointments = appointmentsQuery.isSuccess ? appointmentsQuery.data || [] : [];
  const eligible = applications.filter(application => application.eligibility === 'eligible');
  const judges = appointments.filter(appointment => appointment.state === 'accepted' && appointment.available && ['judge', 'chair'].includes(appointment.role) && (!appointment.expires_at || Date.parse(appointment.expires_at) > Date.now()));
  const applicationRef = id => applications.find(application => application.id === id)?.reference || id;
  const judgeLabel = id => {
    const appointment = appointments.find(item => item.id === id);
    return appointment ? appointmentLabel(appointment, labels) : `Appointment ${id}`;
  };
  const filtered = eligible.filter(application => `${application.reference || ''} ${application.id}`.toLowerCase().includes(filter.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pages);
  const ready = applicationsQuery.isSuccess && appointmentsQuery.isSuccess;
  const selectedApplications = scope === 'all' ? eligible : eligible.filter(application => applicationIds.includes(application.id));
  const lockInputs = disabled || busy || Boolean(preview);
  const discardPreview = () => {
    setPreview(null); setConfirmationAttempted(false); setError('');
  };
  const reset = () => {
    if (dirty && !window.confirm('Discard the allocation selection, manual pairs and preview?')) return;
    setApplicationIds([]); setManual([]); setPairApplication(''); setPairAppointment(''); setPreview(null); setConfirmationAttempted(false); setMode('balanced'); setScope('selected'); setError('');
  };
  return <section className="border-t pt-6 mt-6 space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">Application allocation</h3><p className="awards-help">Preview first. Confirmation uses the unchanged application and criteria versions returned by the server.</p></div><Button size="sm" variant="outline" disabled={disabled || busy || Boolean(preview) || applicationsQuery.isFetching} onClick={() => applicationsQuery.refetch()}>Refresh applications</Button></div>
    {applicationsQuery.isLoading ? <Skeleton className="h-24 w-full" /> : applicationsQuery.isError ? <div role="alert" className="text-sm text-red-800">{applicationsQuery.error.message}<Button variant="outline" size="sm" className="mt-2 block" onClick={() => applicationsQuery.refetch()}>Retry applications</Button></div> : null}
    {!appointmentsQuery.isSuccess && <p className="awards-help">Load the complete appointment list above before allocating.</p>}
    <fieldset disabled={lockInputs || !ready} className="space-y-4">
      <div className="grid md:grid-cols-2 gap-4"><div className="awards-field"><Label htmlFor="allocation-mode">Allocation mode</Label><select id="allocation-mode" className="awards-select" value={mode} onChange={event => { setMode(event.target.value); setManual([]); setPairApplication(''); setPairAppointment(''); }}>
        <option value="balanced">Balanced workload</option><option value="all">All eligible judges per application</option><option value="manual">Manual application–judge pairs</option>
      </select></div><div className="awards-field"><Label htmlFor="allocation-scope">Application scope</Label><select id="allocation-scope" className="awards-select" value={scope} onChange={event => { setScope(event.target.value); setManual([]); setPairApplication(''); }}><option value="selected">Explicitly selected applications</option><option value="all">All eligible applications</option></select></div></div>
      <p className="awards-help">Only accepted, available, unexpired judges/chairs can receive assignments. Capacity, conflicts and existing assignments are rechecked by the server. A preview can contain at most 500 new pairs; use a smaller application subset when needed.</p>
      {scope === 'selected' && <div className="rounded-lg border p-4 space-y-3">
        <div className="awards-field"><Label htmlFor="allocation-application-search">Filter eligible application references</Label><Input id="allocation-application-search" value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }} /></div>
        <fieldset className="space-y-2"><legend className="text-sm font-medium mb-2">Select applications ({applicationIds.length} / 500)</legend>
          {filtered.slice((currentPage - 1) * 10, currentPage * 10).map(application => <label key={application.id} className="flex items-start gap-3 text-sm py-1"><input type="checkbox" className="mt-1" checked={applicationIds.includes(application.id)} disabled={applicationIds.length >= 500 && !applicationIds.includes(application.id)} onChange={event => {
            const checked = event.target.checked;
            setApplicationIds(old => checked ? [...old, application.id] : old.filter(id => id !== application.id));
            if (!checked) setManual(old => old.filter(pair => pair.applicationId !== application.id));
          }} /><span className="break-words">{application.reference || application.id}</span></label>)}
          {!filtered.length && <p className="awards-help">No eligible applications match this filter.</p>}
        </fieldset>
        <div className="flex justify-between items-center gap-2"><Button type="button" size="sm" variant="outline" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous applications</Button><span className="awards-help">{currentPage} / {pages}</span><Button type="button" size="sm" variant="outline" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>Next applications</Button></div>
      </div>}
      {mode === 'manual' && <div className="rounded-lg border p-4 space-y-4">
        <h4 className="font-semibold text-sm">Manual pairs ({manual.length} / 500)</h4>
        <div className="awards-field"><Label htmlFor="allocation-pair-application">Application</Label><select id="allocation-pair-application" className="awards-select" value={pairApplication} onChange={event => setPairApplication(event.target.value)}><option value="">Choose an application</option>{selectedApplications.map(application => <option key={application.id} value={application.id}>{application.reference || application.id}</option>)}</select></div>
        <div className="awards-field"><Label htmlFor="allocation-pair-appointment">Accepted judge or chair</Label><select id="allocation-pair-appointment" className="awards-select" value={pairAppointment} onChange={event => setPairAppointment(event.target.value)}><option value="">Choose an appointment</option>{judges.map(appointment => <option key={appointment.id} value={appointment.id}>{appointmentLabel(appointment, labels)} · {appointment.role}</option>)}</select></div>
        <Button type="button" variant="outline" size="sm" disabled={!pairApplication || !pairAppointment || manual.length >= 500} onClick={() => {
          if (manual.some(pair => pair.applicationId === pairApplication && pair.appointmentId === pairAppointment)) { setError('This application–appointment pair is already selected.'); return; }
          setManual(old => [...old, { applicationId: pairApplication, appointmentId: pairAppointment }]); setPairApplication(''); setPairAppointment(''); setError('');
        }}>Add manual pair</Button>
        {manual.length > 0 && <ul className="space-y-3">{manual.map((pair, index) => <li key={`${pair.applicationId}:${pair.appointmentId}`} className="flex flex-wrap justify-between items-start gap-2 text-sm"><span className="min-w-0 break-words">{applicationRef(pair.applicationId)} → {judgeLabel(pair.appointmentId)}</span><Button type="button" size="sm" variant="outline" aria-label={`Remove manual pair ${index + 1}`} onClick={() => setManual(old => old.filter((_, position) => position !== index))}>Remove</Button></li>)}</ul>}
      </div>}
      <Button type="button" disabled={(scope === 'selected' && !applicationIds.length) || (mode === 'manual' && !manual.length)} onClick={async () => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        try {
          const result = await roundAdminRequest(tenant, '/api/awards/allocation', { body: {
            command: 'preview', roundId: round.id, mode, ...(scope === 'selected' ? { applicationIds } : {}), ...(mode === 'manual' ? { manual } : {}),
          } });
          if (!Number.isSafeInteger(result.roundVersion) || !Array.isArray(result.assignments) || result.assignments.length > 500
            || result.assignments.some(pair => !['applicationId', 'appointmentId', 'applicationVersionId', 'criteriaVersionId'].every(key => typeof pair[key] === 'string' && pair[key]))) throw new Error('The server did not return a valid allocation preview.');
          if (alive.current) {
            callbacks.current.onVersionChange(result.roundVersion);
            setPreview(result); setPreviewPage(1); setConfirmationAttempted(false);
          }
        } catch (failure) { if (alive.current) setError(failure.message); }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      }}>Generate allocation preview</Button>
    </fieldset>
    {preview && <section className="rounded-lg border p-4 space-y-4" aria-label="Read-only allocation preview">
      <div><h4 className="font-semibold">Read-only preview · Round version {preview.roundVersion}</h4><p className="awards-help mt-1">{preview.assignments.length} new pairs. Inputs are locked until this preview is discarded. Nothing is assigned until confirmation.</p></div>
      {preview.assignments.length ? <ul className="divide-y">{preview.assignments.slice((previewPage - 1) * 10, previewPage * 10).map(pair => <li key={`${pair.applicationId}:${pair.appointmentId}`} className="py-3 text-sm"><p className="break-words font-medium">{applicationRef(pair.applicationId)}</p><p className="awards-help break-words">{judgeLabel(pair.appointmentId)}</p><details className="mt-2"><summary className="text-xs cursor-pointer">Bound review versions</summary><p className="text-xs break-all mt-2">Application version: {pair.applicationVersionId}</p><p className="text-xs break-all mt-1">Criteria version: {pair.criteriaVersionId}</p></details></li>)}</ul> : <p className="awards-help">No new assignments are proposed. Existing assignments are not duplicated.</p>}
      {preview.assignments.length > 10 && <div className="flex justify-between items-center gap-2"><Button size="sm" variant="outline" disabled={previewPage <= 1 || busy} onClick={() => setPreviewPage(value => value - 1)}>Previous pairs</Button><span className="awards-help">{previewPage} / {Math.ceil(preview.assignments.length / 10)}</span><Button size="sm" variant="outline" disabled={previewPage >= Math.ceil(preview.assignments.length / 10) || busy} onClick={() => setPreviewPage(value => value + 1)}>Next pairs</Button></div>}
      <div><h5 className="text-sm font-semibold">Shortages</h5>{preview.shortages?.length ? <ul className="mt-2 space-y-1">{preview.shortages.map(shortage => <li key={shortage.applicationId} className="text-sm text-amber-800 break-words">{applicationRef(shortage.applicationId)} · {shortage.missing} assessment assignments missing</li>)}</ul> : <p className="awards-help mt-1">No shortages reported by the server.</p>}</div>
      <details><summary className="text-sm font-semibold cursor-pointer">Projected workload</summary><ul className="space-y-2 mt-3">{Object.entries(preview.workload || {}).map(([appointmentId, workload]) => <li key={appointmentId} className="awards-help break-words">{judgeLabel(appointmentId)} · {workload} applications</li>)}</ul></details>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || disabled} onClick={discardPreview}>Discard preview / edit selection</Button><Button disabled={busy || disabled || confirmationAttempted || !preview.assignments.length} onClick={async () => {
        if (pending.current || !window.confirm(`Confirm exactly ${preview.assignments.length} new assignment pairs from this preview? The server rechecks the round and review versions.`)) return;
        pending.current = true; setBusy(true); setError(''); setNotice(''); setConfirmationAttempted(true);
        try {
          const result = await roundAdminRequest(tenant, '/api/awards/allocation', { body: { command: 'confirm', roundId: round.id, version: preview.roundVersion, assignments: preview.assignments } });
          if (!Array.isArray(result.assignment_ids) || !Number.isSafeInteger(result.round_version)) throw new Error('The server did not confirm the allocation result. Refresh the server round before another preview.');
          if (!alive.current) return;
          callbacks.current.onVersionChange(result.round_version);
          setPreview(null); setApplicationIds([]); setManual([]); setPairApplication(''); setPairAppointment(''); setMode('balanced'); setScope('selected');
          setNotice(`${result.assignment_ids.length} assignment records confirmed. Round version ${result.round_version}.`);
        } catch (failure) { if (alive.current) { setError(`${failure.message} Confirmation will not be retried automatically. Refresh the server round, then discard this preview and generate another.`); callbacks.current.onUncertain(); } }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      }}>{busy ? 'Processing…' : 'Confirm unchanged preview'}</Button></div>
    </section>}
    <Button type="button" variant="outline" size="sm" disabled={busy || disabled} onClick={reset}>Clear allocation choices</Button>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {busy && <p role="status" className="awards-help">Processing allocation…</p>}
  </section>;
}
