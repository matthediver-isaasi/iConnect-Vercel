import React, { useState } from 'react';
import { FolderTree, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { eventFunnelRequest, sortByName } from '@/lib/eventFunnelApi';

// Funnel Groups: create, rename, delete, put funnels in a group and filter the
// funnel list by group. A funnel belongs to at most one group.
export default function EventFunnelGroupsPanel({ data, onChange, filter, onFilter }) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!data.groupsAvailable) return <p role="status" className="rounded-md border p-3 text-sm">Funnel Groups are not available yet on this site.</p>;
  const groups = sortByName(data.groups || []);
  const groupOf = new Map((data.groupMembers || []).map(row => [row.definition_id, row.collection_id]));
  const linkedEvents = id => (data.eventLinks || []).filter(row => row.collection_id === id).length;
  const run = async fn => {
    setBusy(true); setError(null);
    try { await fn(); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  const create = () => run(async () => {
    const saved = await eventFunnelRequest({ action: 'save_group', id: crypto.randomUUID(), name, expectedRevision: 0 });
    onChange(current => ({ groups: [...current.groups, saved] }));
    setName('');
  });
  const rename = group => run(async () => {
    const saved = await eventFunnelRequest({ action: 'save_group', id: group.id, name: editing.name, expectedRevision: group.revision });
    onChange(current => ({ groups: current.groups.map(item => item.id === saved.id ? saved : item) }));
    setEditing(null);
  });
  const remove = group => {
    const events = linkedEvents(group.id);
    if (!window.confirm(`Delete the group "${group.name}"? Its funnels are kept.${events ? ` ${events} event${events === 1 ? '' : 's'} linked to this group will no longer be limited to it.` : ''}`)) return;
    run(async () => {
      await eventFunnelRequest({ action: 'delete_group', id: group.id, expectedRevision: group.revision });
      onChange(current => ({
        groups: current.groups.filter(item => item.id !== group.id),
        groupMembers: current.groupMembers.filter(row => row.collection_id !== group.id),
        eventLinks: current.eventLinks.map(row => row.collection_id === group.id
          ? { ...row, collection_id: null, revision: row.revision + 1 } : row),
      }));
      if (filter === group.id) onFilter('');
    });
  };
  const assign = (definitionId, groupId) => run(async () => {
    await eventFunnelRequest({ action: 'assign_group', definitionId, groupId: groupId || null });
    onChange(current => ({ groupMembers: [
      ...current.groupMembers.filter(row => row.definition_id !== definitionId),
      ...(groupId ? [{ definition_id: definitionId, collection_id: groupId }] : []),
    ] }));
  });

  return <section className="space-y-4 rounded-md border p-4" data-testid="event-funnel-groups">
    <h3 className="flex items-center gap-2 font-semibold"><FolderTree className="h-4 w-4" />Funnel Groups</h3>
    <p className="text-sm text-muted-foreground">Group related funnels, for example all funnels for one event. An event can then be linked to a whole group from its Funnel tab.</p>
    <fieldset disabled={busy} className="space-y-4">
      <div className="flex gap-2">
        <Input aria-label="New group name" placeholder="New group name" maxLength={120} value={name}
          onChange={event => setName(event.target.value)} data-testid="event-funnel-group-name" />
        <Button type="button" disabled={!name.trim()} onClick={create} data-testid="event-funnel-group-create">Create group</Button>
      </div>
      {groups.length > 0 && <ul className="divide-y rounded-md border">
        {groups.map(group => <li key={group.id} className="flex flex-wrap items-center gap-2 p-2">
          {editing?.id === group.id ? <>
            <Input aria-label={`Rename ${group.name}`} className="max-w-xs" maxLength={120} value={editing.name}
              onChange={event => setEditing({ id: group.id, name: event.target.value })} />
            <Button type="button" size="sm" disabled={!editing.name.trim()} onClick={() => rename(group)}>Save</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </> : <>
            <span className="flex-1 font-medium">{group.name}</span>
            <span className="text-sm text-muted-foreground">
              {(data.groupMembers || []).filter(row => row.collection_id === group.id).length} funnels · {linkedEvents(group.id)} linked events
            </span>
            <Button type="button" size="sm" variant="ghost" aria-label={`Rename ${group.name}`} onClick={() => setEditing({ id: group.id, name: group.name })}><Pencil className="h-4 w-4" /></Button>
            <Button type="button" size="sm" variant="ghost" aria-label={`Delete ${group.name}`} onClick={() => remove(group)}><Trash2 className="h-4 w-4" /></Button>
          </>}
        </li>)}
      </ul>}
      <label className="block text-sm">Show funnels in
        <select aria-label="Filter funnels by group" className="mt-1 block w-full rounded border p-2" value={filter}
          onChange={event => onFilter(event.target.value)} data-testid="event-funnel-group-filter">
          <option value="">All groups</option>
          <option value="__none">Not in a group</option>
          {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
      </label>
      {(data.definitions || []).length > 0 && groups.length > 0 && <details>
        <summary className="cursor-pointer text-sm font-medium">Add or remove funnels from groups</summary>
        <ul className="mt-2 space-y-2">
          {sortByName(data.definitions).map(definition => <li key={definition.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex-1">{definition.name}</span>
            <select aria-label={`Group for ${definition.name}`} className="rounded border p-1" value={groupOf.get(definition.id) || ''}
              onChange={event => assign(definition.id, event.target.value)}>
              <option value="">No group</option>
              {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          </li>)}
        </ul>
      </details>}
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
