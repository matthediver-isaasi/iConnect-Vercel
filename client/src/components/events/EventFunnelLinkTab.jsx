import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitBranch, Loader2, Search } from 'lucide-react';
import { useMemberAccess } from '@/hooks/useMemberAccess';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { eventFunnelChoices, eventFunnelRequest, eventFunnelSetupUrl, funnelSourceEvent } from '@/lib/eventFunnelApi';

// Event setup "Funnel" tab. Links this event to one funnel or one Funnel Group
// so registration only considers those funnels. Saved immediately and
// independently of the surrounding event form.
export default function EventFunnelLinkTab({ eventId, eventKind }) {
  const { memberInfo, isAdmin, isAccessReady, isFeatureExcluded } = useMemberAccess();
  const allowed = isAccessReady && isAdmin && !isFeatureExcluded('events.browse-events.create');
  const queryClient = useQueryClient();
  const queryKey = ['event-funnel-definitions', memberInfo?.tenant_id, memberInfo?.id];
  const state = useQuery({ queryKey, queryFn: () => eventFunnelRequest(), enabled: allowed && !!eventId, retry: false, staleTime: 0 });
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const data = state.data;
  const link = data?.eventLinks?.find(row => row.event_kind === eventKind && row.event_id === eventId);
  const setting = data?.eventSettings?.find(row => row.event_kind === eventKind && row.event_id === eventId);
  const saved = link?.definition_id ? `funnel:${link.definition_id}` : link?.collection_id ? `group:${link.collection_id}` : 'none';
  const selected = pending ?? saved;
  const choices = useMemo(() => eventFunnelChoices(data || {}, query), [data, query]);

  if (!eventId) return <p className="text-sm text-muted-foreground">Save the event first, then link it to a funnel.</p>;
  if (!isAccessReady) return <p role="status">Checking access…</p>;
  if (!allowed) return <p role="alert">You do not have permission to manage event funnels.</p>;
  if (state.error) return <div role="alert" className="space-y-2 text-sm text-destructive">
    <p>{state.error.message}</p>
    <Button type="button" variant="outline" onClick={() => state.refetch()}>Retry loading</Button>
  </div>;
  if (!data) return <p role="status" className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading funnels…</p>;

  const update = patch => queryClient.setQueryData(queryKey, current => ({ ...current, ...patch(current) }));
  const run = async (fn, success) => {
    setSaving(true); setError(null); setNotice(null);
    try { await fn(); setNotice(success); queryClient.invalidateQueries({ queryKey: ['event-funnel-entry'] }); }
    catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  };
  const saveLink = () => run(async () => {
    const [type, id] = selected.split(':');
    const row = await eventFunnelRequest({ action: 'set_event_link', eventId, eventKind,
      definitionId: type === 'funnel' ? id : null, groupId: type === 'group' ? id : null,
      expectedRevision: link?.revision || 0 });
    update(current => ({ eventLinks: [...(current.eventLinks || [])
      .filter(item => item.event_kind !== eventKind || item.event_id !== eventId), row] }));
    setPending(null);
  }, 'Funnel link saved.');
  const toggleEnabled = enabled => run(async () => {
    const row = await eventFunnelRequest({ action: 'set_enabled', eventId, eventKind, enabled, expectedRevision: setting?.revision || 0 });
    update(current => ({ eventSettings: [...(current.eventSettings || [])
      .filter(item => item.event_kind !== eventKind || item.event_id !== eventId), row] }));
  }, enabled ? 'Ticket funnels switched on for this event.' : 'Ticket funnels switched off for this event.');

  const selectedFunnel = selected.startsWith('funnel:') ? data.definitions.find(item => `funnel:${item.id}` === selected) : null;
  const source = funnelSourceEvent(selectedFunnel);
  const otherSource = source && (source.kind !== eventKind || source.id !== eventId);
  const option = (value, label, extra) => <label key={value} className="flex items-start gap-3 rounded-md border p-3 hover:bg-muted/40">
    <input type="radio" name="event-funnel-link" className="mt-1" value={value} checked={selected === value}
      onChange={() => { setPending(value); setNotice(null); }} data-testid={`event-funnel-option-${value}`} />
    <span className="min-w-0 flex-1">{label}{extra}</span>
  </label>;

  return <Card data-testid="event-funnel-link-tab">
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-lg"><GitBranch className="h-5 w-5" />Funnel</CardTitle>
      <CardDescription>Choose the funnel, or Funnel Group, this event uses. Registration then only checks those funnels instead of every funnel. Changes here are saved straight away, separately from the rest of the event.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {!data.groupsAvailable && <p role="status" className="rounded-md border p-3 text-sm">Funnel links are not available yet on this site.</p>}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" disabled={saving} checked={setting?.enabled === true}
          onChange={event => toggleEnabled(event.target.checked)} data-testid="event-funnel-enabled" />
        Use ticket funnels for this event
      </label>
      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search funnels and groups" aria-label="Search funnels and groups"
          value={query} onChange={event => setQuery(event.target.value)} data-testid="event-funnel-search" />
      </div>
      <fieldset disabled={saving || !data.groupsAvailable} className="max-h-[28rem] space-y-2 overflow-y-auto">
        <legend className="sr-only">Funnel for this event</legend>
        {option('none', <strong>No specific funnel</strong>, <span className="block text-sm text-muted-foreground">Any published funnel that starts from this event's tickets can be used.</span>)}
        {choices.groups.length > 0 && <p className="pt-2 text-xs font-semibold uppercase text-muted-foreground">Funnel Groups</p>}
        {choices.groups.map(group => option(`group:${group.id}`, <strong>{group.name}</strong>,
          <span className="block text-sm text-muted-foreground">{group.funnelCount} funnel{group.funnelCount === 1 ? '' : 's'}</span>))}
        {choices.funnels.length > 0 && <p className="pt-2 text-xs font-semibold uppercase text-muted-foreground">Funnels</p>}
        {choices.funnels.map(funnel => option(`funnel:${funnel.id}`, <span className="flex flex-wrap items-center justify-between gap-2">
          <span><strong>{funnel.name}</strong>
            <span className="block text-sm text-muted-foreground">{funnel.published_version_id ? 'Published' : 'Draft only'}{funnel.groupName ? ` · ${funnel.groupName}` : ''}</span>
          </span>
          <a href={eventFunnelSetupUrl(funnel.id)} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline" onClick={event => event.stopPropagation()}>
            Open funnel setup<ExternalLink className="h-3.5 w-3.5" />
          </a>
        </span>))}
        {query && !choices.groups.length && !choices.funnels.length && <p className="text-sm text-muted-foreground">No funnels or groups match “{query}”.</p>}
      </fieldset>
      {otherSource && <p role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">This funnel starts from a different event, so it will not route registrations for this event's tickets.</p>}
      {selectedFunnel && !selectedFunnel.published_version_id && <p role="status" className="text-sm text-muted-foreground">This funnel has not been published yet. Registration uses normal checkout until it is.</p>}
      <div className="flex items-center gap-3">
        <Button type="button" disabled={saving || selected === saved || !data.groupsAvailable} onClick={saveLink} data-testid="event-funnel-save-link">
          {saving ? 'Saving…' : 'Save funnel link'}
        </Button>
        {pending !== null && pending !== saved && <Button type="button" variant="ghost" onClick={() => setPending(null)}>Undo</Button>}
        <a href="/EventFunnels" target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline">Manage funnels and groups</a>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
    </CardContent>
  </Card>;
}
