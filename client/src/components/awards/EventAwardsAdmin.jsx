import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFormAlertTenant } from '@/hooks/useFormAlerts';
import { useMemberAccess } from '@/hooks/useMemberAccess';
import { usePopupUnsavedChanges } from '@/hooks/usePopupUnsavedChanges';
import { adminFetch } from '@/lib/adminFetch';
import { listAwards } from '@/lib/awardsApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { isProgrammeArchived, useAwardProgrammes } from './useAwardProgrammes';
import EventAwardsProgress from './EventAwardsProgress';
import './awards.css';

async function eventAwardsRequest(tenant, url, body, signal) {
  tenant.assertCurrent();
  const response = await adminFetch(url, {
    cache: 'no-store', signal,
    ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' },
      body: JSON.stringify(body),
    }),
  }, tenant.tenantId);
  const result = await response.json();
  tenant.assertCurrent();
  if (!response.ok) throw new Error(result.error || 'Event award associations could not be loaded or saved.');
  return result;
}

async function allPages(load, field) {
  const rows = [], seen = new Set();
  let total;
  for (let page = 1; page <= 10000; page += 1) {
    const result = await load(page);
    if (!Array.isArray(result[field]) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1) throw new Error('An incomplete list was returned. Retry loading the complete list.');
    if (total !== undefined && total !== result.total) throw new Error('The list changed while loading. Reload before choosing an association.');
    total = result.total;
    for (const row of result[field]) {
      if (!row.id || seen.has(row.id)) throw new Error('The list changed while loading. No partial list has been used.');
      seen.add(row.id); rows.push(row);
    }
    if (rows.length === total) return rows;
    if (!result[field].length || rows.length > total) break;
  }
  throw new Error('The complete list could not be loaded. No partial list has been used.');
}

const targetName = link => link.award_id ? (link.award?.name || `Award ${link.award_id}`) : (link.programme?.name || `Programme ${link.programme_id}`);
function utcInput(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 23);
}
function presentationLabel(value) {
  if (!value) return 'Presentation time not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : `${date.toLocaleString('en-GB', { timeZone: 'UTC' })} UTC`;
}

export default function EventAwardsAdmin({ eventId, type }) {
  const tenant = useFormAlertTenant('events.browse-events.create');
  const access = useMemberAccess();
  if (!eventId) return null;
  if (!['event', 'complex'].includes(type)) return <p role="alert" className="text-sm text-red-800">Awards require a valid event type.</p>;
  if (tenant.status === 'loading' || !access.isAccessReady) return <div aria-label="Checking event awards access" className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /></div>;
  if (tenant.status !== 'ready') return <Card><CardContent className="p-6"><p role="alert" className="text-sm text-red-800">{tenant.error}</p><Button type="button" variant="outline" className="mt-3" onClick={() => window.location.reload()}>Reload session</Button></CardContent></Card>;
  return <EventAwardsWorkspace key={`${tenant.scopeKey}:${type}:${eventId}`} eventId={eventId} type={type} tenant={tenant} canConfigure={!access.isFeatureExcluded('awards.management.configure')} />;
}

function EventAwardsWorkspace({ eventId, type, tenant, canConfigure }) {
  const linksQuery = useQuery({
    queryKey: ['event-awards-admin', tenant.scopeKey, type, eventId],
    queryFn: async ({ signal }) => {
      const links = await allPages(page => eventAwardsRequest(tenant, `/api/awards/events?eventId=${encodeURIComponent(eventId)}&type=${type}&page=${page}`, undefined, signal), 'links');
      const eventField = type === 'complex' ? 'complex_event_id' : 'event_id';
      if (links.some(link => link[eventField] !== eventId || !Number.isSafeInteger(link.version) || link.version < 1
        || Number(Boolean(link.award_id)) + Number(Boolean(link.programme_id)) !== 1
        || typeof link.show_information !== 'boolean' || typeof link.show_application_link !== 'boolean'
        || !['member', 'public'].includes(link.audience))) throw new Error('The event association response could not be verified. Reload the list.');
      return links;
    },
    gcTime: 0, staleTime: 0, retry: false, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const [editor, setEditor] = useState(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [progressId, setProgressId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(1);
  const pending = useRef(false), alive = useRef(true);
  const guard = usePopupUnsavedChanges({ dirty: dirty || busy });
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const links = linksQuery.data || [];
  const ready = linksQuery.isSuccess && !linksQuery.isFetching;
  const current = editor?.link ? links.find(link => link.id === editor.link.id) : null;
  const progressLink = ready ? links.find(link => link.id === progressId) : null;
  const stale = Boolean(editor?.link && ready && current?.version !== editor.link.version);
  const changeEditor = value => {
    if (busy || (dirty && !window.confirm('Discard unsaved event award association settings?'))) return;
    setEditor(value); setEditorRevision(value => value + 1); setDirty(false); setError('');
  };
  const reload = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await linksQuery.refetch(); tenant.assertCurrent();
      if (result.error) throw result.error;
      if (alive.current) { setBlocked(false); setNotice('Association list refreshed. An open editor keeps its original snapshot; reload it explicitly if its version changed.'); }
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const pages = Math.max(1, Math.ceil(links.length / 10));
  return <div className="awards-workspace space-y-5" onKeyDown={event => {
    // This surface can live inside the existing event form. Enter in a text/date
    // control must not implicitly submit that unrelated form.
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') event.preventDefault();
  }}>
    <Card><CardHeader><CardTitle>Associated awards & programmes</CardTitle><p className="awards-help">Link this existing event without copying it. These settings save independently of the event form. Cancelling or rescheduling the event retains its associations.</p></CardHeader><CardContent className="space-y-4">
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={busy || linksQuery.isFetching} onClick={reload}>Refresh associations (keep editor)</Button>{canConfigure && <Button type="button" size="sm" disabled={busy || !ready || blocked} onClick={() => changeEditor({ link: null })}>Add association</Button>}</div>
      {!canConfigure && <p className="awards-help">You can view these associations and staff progress. Changing association settings requires awards configuration permission; viewing progress does not grant it.</p>}
      {linksQuery.isLoading && <div aria-label="Loading event associations" className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>}
      {linksQuery.isError && <p role="alert" className="text-sm text-red-800">{linksQuery.error.message} Use “Refresh associations” to retry. Editing requires the complete list.</p>}
      {ready && !links.length && <div className="rounded-lg border p-5"><h3 className="font-medium text-sm">No associations recorded</h3><p className="awards-help mt-1">This event is not linked to an award or programme.</p></div>}
      {links.length > 0 && <ul className="divide-y rounded-lg border">{links.slice((Math.min(page, pages) - 1) * 10, Math.min(page, pages) * 10).map(link => <li key={link.id} className="p-4">
        <div className="flex flex-wrap justify-between items-start gap-3"><div className="min-w-0"><h3 className="font-semibold text-sm break-words">{targetName(link)}</h3><p className="awards-help">{link.award_id ? 'Award' : 'Programme'} · {link.audience === 'public' ? 'Public and member audience' : 'Member audience'} · version {link.version}</p></div>{canConfigure && <Button type="button" size="sm" variant="outline" disabled={busy || !ready || blocked} onClick={() => changeEditor({ link })}>Edit association</Button>}</div>
        <p className="awards-help mt-2">{link.show_information ? 'Information enabled' : 'Information hidden'} · {link.show_application_link ? 'Application links enabled when applications are open' : 'Application links hidden'}</p><p className="awards-help">{presentationLabel(link.presentation_at)}</p>
        <Button type="button" size="sm" variant="outline" className="mt-3" disabled={!ready || busy} aria-pressed={progressId === link.id} onClick={() => setProgressId(old => old === link.id ? '' : link.id)}>{progressId === link.id ? 'Hide staff progress' : 'View staff progress'}</Button>
      </li>)}</ul>}
      {pages > 1 && <div className="flex items-center justify-between gap-3"><Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous associations</Button><span className="awards-help">{Math.min(page, pages)} / {pages}</span><Button type="button" size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>Next associations</Button></div>}
      <p className="awards-help">Hiding information or application links does not retract already-authorised outcomes. Presentation time is informational; it does not schedule publication or change event dates.</p>
    </CardContent></Card>
    {progressLink && <EventAwardsProgress key={`${tenant.scopeKey}:${type}:${eventId}:${progressLink.id}:${progressLink.version}`}
      tenant={tenant} eventId={eventId} type={type} link={progressLink} name={targetName(progressLink)}
      request={eventAwardsRequest} onClose={() => setProgressId('')} />}
    {progressId && ready && !progressLink && <p role="status" className="awards-help">The selected association is no longer returned for this event. Its staff progress was cleared; association-editor drafts have not been changed.</p>}
    {editor && canConfigure && <AssociationEditor key={`${editor.link?.id || 'new'}:${editorRevision}`} link={editor.link} tenant={tenant} type={type} eventId={eventId} links={links}
      disabled={busy || !ready || blocked || stale} busy={busy} onDirtyChange={setDirty} onCancel={() => changeEditor(null)} onSave={async payload => {
        if (pending.current || !canConfigure || !ready || blocked || stale) return;
        if (!window.confirm(`Save this ${payload.audience === 'public' ? 'public and member' : 'member-only'} event association? This changes visibility settings only; it does not publish outcomes, send messages or copy the event.`)) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        try {
          const result = await eventAwardsRequest(tenant, '/api/awards/events', { id: editor.link?.id || null, version: editor.link?.version || null, payload });
          if (!result.link?.id || !Number.isSafeInteger(result.link.version) || result.link.version < 1 || (editor.link && (result.link.id !== editor.link.id || result.link.version <= editor.link.version))) throw new Error('The server did not confirm the saved association. Refresh before retrying.');
          if (!alive.current) return;
          setEditor(null); setDirty(false); setNotice('Event association saved. Event content, dates and booking settings were not changed.');
          const refreshed = await linksQuery.refetch(); tenant.assertCurrent();
          if (refreshed.error) throw new Error('The association was saved, but the complete list could not be refreshed.');
        } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      }} />}
    {stale && <div className="rounded-lg border border-amber-200 p-4 space-y-3"><p className="text-sm text-amber-900">This association changed after the editor opened. Your unsaved choices remain here. Reload its current server settings before saving.</p>{current && <Button type="button" variant="outline" disabled={busy} onClick={() => changeEditor({ link: current })}>Discard draft and reload association</Button>}</div>}
    {blocked && <p role="alert" className="text-sm text-amber-800">Refresh the complete association list before another write. An uncertain save is never automatically repeated; inspect existing associations before retrying a create.</p>}
    {busy && <p role="status" className="awards-help">Saving or refreshing event associations…</p>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-800">{error} Unsaved choices are retained unless the server confirmed their save.</p>}
    <Dialog open={Boolean(guard.pending)} onOpenChange={open => { if (!open) guard.stay(); }}><DialogContent className="awards-workspace"><DialogHeader><DialogTitle>{busy ? 'Association request in progress' : 'Leave unsaved award associations?'}</DialogTitle><DialogDescription>{busy ? 'Wait for the current request before leaving this event.' : 'Association settings save separately from the event form. Unsaved association choices will be discarded.'}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={guard.stay}>Stay here</Button><Button type="button" disabled={busy} onClick={guard.discard}>Discard and leave</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

function AssociationEditor({ link, tenant, type, eventId, links, disabled, busy, onDirtyChange, onSave, onCancel }) {
  const [kind, setKind] = useState(link?.programme_id ? 'programme' : 'award');
  const [target, setTarget] = useState(link?.award_id || link?.programme_id || '');
  const [information, setInformation] = useState(Boolean(link?.show_information));
  const [application, setApplication] = useState(Boolean(link?.show_application_link));
  const [audience, setAudience] = useState(link?.audience || 'member');
  const [presentation, setPresentation] = useState(() => utcInput(link?.presentation_at));
  const [targetReady, setTargetReady] = useState(false);
  const [error, setError] = useState('');
  const callback = useRef(onDirtyChange); callback.current = onDirtyChange;
  const dirty = target !== (link?.award_id || link?.programme_id || '') || information !== Boolean(link?.show_information) || application !== Boolean(link?.show_application_link) || audience !== (link?.audience || 'member') || presentation !== utcInput(link?.presentation_at) || (!link && kind !== 'award');
  useEffect(() => { callback.current(dirty); }, [dirty]);
  useEffect(() => () => callback.current(false), []);
  const duplicate = !link && target && links.some(item => kind === 'award' ? item.award_id === target : item.programme_id === target);
  return <Card><CardHeader><CardTitle className="text-lg">{link ? 'Edit association visibility' : 'New association'}</CardTitle><p className="awards-help">{link ? `${targetName(link)} · association targets cannot be changed.` : 'Choose an existing award or programme. Nothing is selected automatically.'}</p></CardHeader><CardContent className="space-y-4">
    <fieldset disabled={disabled} className="space-y-4">
      {!link && <><div className="awards-field"><Label htmlFor="event-awards-kind">Association type</Label><select id="event-awards-kind" className="awards-select" value={kind} onChange={event => {
        if (target && !window.confirm('Clear the selected target and change association type?')) return;
        setKind(event.target.value); setTarget(''); setTargetReady(false);
      }}><option value="award">One award</option><option value="programme">A programme and its awards</option></select></div>
        {kind === 'award' ? <AwardPicker tenant={tenant} value={target} onChange={setTarget} onReady={setTargetReady} /> : <ProgrammePicker tenant={tenant} value={target} onChange={setTarget} onReady={setTargetReady} />}
      </>}
      {duplicate && <p role="alert" className="text-sm text-amber-800">This target is already associated with the event. Edit its existing association instead of creating a duplicate.</p>}
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={information} onChange={event => setInformation(event.target.checked)} /><span>Show award information</span></label>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={application} onChange={event => setApplication(event.target.checked)} /><span>Show application links when the award accepts applications and its bound form is available</span></label>
      <div className="awards-field"><Label htmlFor="event-awards-audience">Association audience</Label><select id="event-awards-audience" className="awards-select" value={audience} onChange={event => setAudience(event.target.value)}><option value="member">Members only</option><option value="public">Public and members</option></select></div>
      <div className="awards-field"><Label htmlFor="event-awards-presentation">Presentation time (UTC, optional)</Label><Input id="event-awards-presentation" type="datetime-local" step="0.001" value={presentation} onChange={event => setPresentation(event.target.value)} /><p className="awards-help">Enter UTC explicitly. This is not an embargo or an automatic publication schedule.</p></div>
      <Button type="button" disabled={!dirty || !target || duplicate || (!link && !targetReady)} onClick={() => {
        setError('');
        let presentationAt = null;
        if (presentation) {
          const date = new Date(`${presentation}Z`);
          if (Number.isNaN(date.getTime())) { setError('Enter a valid UTC presentation time or clear it.'); return; }
          presentationAt = presentation === utcInput(link?.presentation_at) ? link.presentation_at : date.toISOString();
        }
        const payload = { show_information: information, show_application_link: application, audience, presentation_at: presentationAt };
        if (!link) { payload[`${kind}_id`] = target; payload[type === 'complex' ? 'complex_event_id' : 'event_id'] = eventId; }
        onSave(payload);
      }}>Save association separately…</Button>
    </fieldset>
    <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel association edit</Button>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
  </CardContent></Card>;
}

function Picker({ query, options, value, onChange, onReady, noun }) {
  const callback = useRef(onReady); callback.current = onReady;
  const ready = query.isSuccess && !query.isFetching;
  const validChoice = !value || options.some(item => item.id === value);
  useEffect(() => { callback.current(ready && validChoice); }, [ready, validChoice]);
  useEffect(() => () => callback.current(false), []);
  return <div className="awards-field"><Label htmlFor="event-awards-target">Existing {noun}</Label>
    {query.isLoading ? <Skeleton className="h-10 w-full" /> : query.isError ? <p role="alert" className="text-sm text-red-800">{query.error.message} No partial choices are available.</p> : <select id="event-awards-target" className="awards-select" value={value} disabled={!ready} onChange={event => onChange(event.target.value)}><option value="">Choose a {noun}</option>{value && !options.some(item => item.id === value) && <option value={value} disabled>Previously selected {noun} is unavailable ({value})</option>}{options.map(item => <option key={item.id} value={item.id}>{item.name}{item.state ? ` · ${item.state}` : ''}</option>)}</select>}
    {ready && !options.length && <p className="awards-help">No selectable {noun}s were returned.</p>}
    {ready && !validChoice && <p role="alert" className="text-sm text-amber-800">The selected {noun} is no longer available for a new association. Choose another target; your existing choice has not been silently replaced.</p>}
    <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={query.isFetching} onClick={() => query.refetch()}>Reload complete {noun} list</Button>
  </div>;
}
function AwardPicker({ tenant, ...props }) {
  const query = useQuery({
    queryKey: ['event-awards-targets', tenant.scopeKey, 'all'],
    queryFn: () => allPages(async page => { tenant.assertCurrent(); const result = await listAwards(page); tenant.assertCurrent(); return result; }, 'awards'),
    gcTime: 0, retry: false, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  return <Picker {...props} query={query} options={query.isSuccess ? query.data : []} noun="award" />;
}
function ProgrammePicker({ tenant, ...props }) {
  const query = useAwardProgrammes(tenant);
  return <Picker {...props} query={query} options={query.isSuccess ? query.data.filter(item => !isProgrammeArchived(item)) : []} noun="programme" />;
}
