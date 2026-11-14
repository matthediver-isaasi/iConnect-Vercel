import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { isProgrammeArchived, programmeQueryKey, saveAwardProgramme } from './useAwardProgrammes';

const draftOf = programme => ({ name: programme?.name || '', description: programme?.description || '', cycle: programme?.cycle || '', archived: isProgrammeArchived(programme) });

export default function ProgrammeManager({ tenant, canEdit, programmesQuery, onDirtyChange, onBusyChange }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(() => draftOf(null));
  const [snapshot, setSnapshot] = useState(() => JSON.stringify(draftOf(null)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const alive = useRef(true);
  const callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const dirty = open && JSON.stringify(draft) !== snapshot;
  const live = useRef({ dirty, busy });
  live.current = { dirty, busy };
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => {
    alive.current = true;
    const unload = event => { if (live.current.dirty || live.current.busy) { event.preventDefault(); event.returnValue = ''; } };
    const links = event => {
      if (!event.target.closest?.('a[href]')) return;
      if (live.current.busy || (live.current.dirty && !window.confirm('Discard unsaved programme changes?'))) event.preventDefault();
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', links, true);
    return () => {
      alive.current = false; window.removeEventListener('beforeunload', unload); document.removeEventListener('click', links, true);
      callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false);
    };
  }, []);
  const programmes = programmesQuery.data || [];
  const pages = Math.max(1, Math.ceil(programmes.length / 5));
  const currentPage = Math.min(page, pages);
  const edit = programme => {
    if (busy || !canEdit || (dirty && !window.confirm('Discard unsaved programme changes?'))) return;
    const next = draftOf(programme);
    setSelected(programme); setDraft(next); setSnapshot(JSON.stringify(next)); setError(''); setOpen(true);
  };
  const close = () => { if (!busy && (!dirty || window.confirm('Discard unsaved programme changes?'))) { setOpen(false); setError(''); } };
  const save = async (programme, payload, archivedAction = false) => {
    if (pending.current || !canEdit) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await saveAwardProgramme(tenant, programme, payload);
      queryClient.setQueryData(programmeQueryKey(tenant), old => {
        if (!old) return old;
        return old.some(item => item.id === result.id) ? old.map(item => item.id === result.id ? result : item) : [result, ...old];
      });
      if (alive.current) {
        setOpen(false);
        setNotice(archivedAction ? isProgrammeArchived(result) ? 'Programme archived. Its competitions are retained.' : 'Programme restored.' : 'Programme saved.');
      }
    } catch (failure) { if (alive.current) setError(failure.message || 'Unable to save programme.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <Card className="shadow-sm">
    <CardContent className="p-0">
      <details className="group">
        <summary className="cursor-pointer px-5 py-4 text-sm font-semibold">Programmes <span className="font-normal text-slate-500 ml-2">{programmesQuery.isSuccess ? `${programmes.length} total` : 'Manage competition groupings'}</span></summary>
        <div className="px-5 pb-5 border-t pt-4 space-y-4">
          <div className="flex flex-wrap justify-between items-start gap-3"><p className="awards-help max-w-xl">Group competitions by programme. Archiving a programme retains its competitions and can be reversed.</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || programmesQuery.isFetching} onClick={() => programmesQuery.refetch()}>Refresh programmes</Button>{canEdit && <Button size="sm" variant="outline" disabled={busy || !programmesQuery.isSuccess} onClick={() => edit(null)}><Plus className="h-4 w-4 mr-2" />New programme</Button>}</div></div>
          {programmesQuery.isLoading ? <Skeleton className="h-16 w-full" /> : programmesQuery.isError ? <div role="alert" className="text-sm text-red-800">{programmesQuery.error.message}<Button size="sm" variant="outline" className="ml-3" onClick={() => programmesQuery.refetch()}>Retry full programme list</Button></div>
            : !programmes.length ? <p className="awards-help rounded-lg border p-4">No programmes have been created. Competitions can also remain ungrouped.</p>
              : <ul className="divide-y">{programmes.slice((currentPage - 1) * 5, currentPage * 5).map(programme => <li key={programme.id} className="py-3 first:pt-0 flex flex-wrap justify-between items-start gap-3">
                <div className="min-w-0 flex-1"><p className="font-medium text-sm break-words">{programme.name} {isProgrammeArchived(programme) && <span className="awards-status ml-2">Archived</span>}</p>{programme.cycle && <p className="awards-help mt-1">{programme.cycle}</p>}{programme.description && <p className="awards-help mt-1 whitespace-pre-wrap break-words">{programme.description}</p>}</div>
                {canEdit && <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => edit(programme)}>Edit</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => {
                  if (window.confirm(isProgrammeArchived(programme) ? `Restore “${programme.name}” so it can be chosen for competitions again?` : `Archive “${programme.name}”? Existing competitions are retained; this can be reversed.`)) save(programme, { ...draftOf(programme), archived: !isProgrammeArchived(programme) }, true);
                }}><Archive className="h-3.5 w-3.5 mr-2" />{isProgrammeArchived(programme) ? 'Restore' : 'Archive'}</Button></div>}
              </li>)}</ul>}
          {programmes.length > 5 && <div className="flex items-center justify-between gap-3"><Button size="sm" variant="outline" disabled={busy || currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous programmes</Button><span className="awards-help">Page {currentPage} of {pages}</span><Button size="sm" variant="outline" disabled={busy || currentPage >= pages} onClick={() => setPage(currentPage + 1)}>Next programmes</Button></div>}
          {error && !open && <p role="alert" className="text-sm text-red-800">{error} Reload the list if its version changed.</p>}
          {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
        </div>
      </details>
      <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
        <DialogContent className="awards-workspace"><DialogHeader><DialogTitle>{selected ? 'Edit programme' : 'Create programme'}</DialogTitle><DialogDescription>Programmes group competitions without changing their application evidence or outcomes.</DialogDescription></DialogHeader>
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (draft.name.trim()) save(selected, { ...draft, name: draft.name.trim() }); }}>
            <fieldset disabled={busy || !canEdit} className="space-y-4">
              <div className="awards-field"><Label htmlFor="programme-name">Programme name (required)</Label><Input id="programme-name" required value={draft.name} onChange={event => setDraft(old => ({ ...old, name: event.target.value }))} /></div>
              <div className="awards-field"><Label htmlFor="programme-cycle">Cycle</Label><Input id="programme-cycle" value={draft.cycle} onChange={event => setDraft(old => ({ ...old, cycle: event.target.value }))} /></div>
              <div className="awards-field"><Label htmlFor="programme-description">Description</Label><Textarea id="programme-description" rows={4} value={draft.description} onChange={event => setDraft(old => ({ ...old, description: event.target.value }))} /></div>
            </fieldset>
            {error && <p role="alert" className="text-sm text-red-800">{error} Your edits are retained. If the version changed, copy your edits and reload programmes before retrying.</p>}
            {error && selected && <Button type="button" variant="outline" disabled={busy} onClick={async () => {
              if (!window.confirm('Discard this programme draft and load its latest saved version? Copy any needed edits first.')) return;
              setBusy(true);
              try {
                const result = await programmesQuery.refetch();
                tenant.assertCurrent();
                if (result.error) throw result.error;
                const fresh = result.data.find(programme => programme.id === selected.id);
                if (!fresh) throw new Error('This programme is no longer in the complete list. Your draft has been retained.');
                if (alive.current) { const next = draftOf(fresh); setSelected(fresh); setDraft(next); setSnapshot(JSON.stringify(next)); setError(''); }
              } catch (failure) { if (alive.current) setError(failure.message); }
              finally { if (alive.current) setBusy(false); }
            }}>Reload saved programme</Button>}
            <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" disabled={busy || !canEdit || !draft.name.trim() || (Boolean(selected) && !dirty)}>{busy ? 'Saving…' : 'Save programme'}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </CardContent>
  </Card>;
}
