import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { decisionRequest } from './useAwardDecisions';

export default function OutcomeCategories({ awardId, tenant, categories, outcomes, ready, canEdit, disabled, onSaved, onDirtyChange, onBusyChange }) {
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState('');
  const [certificate, setCertificate] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef(false), alive = useRef(true), callbacks = useRef({ onDirtyChange, onBusyChange, onSaved });
  callbacks.current = { onDirtyChange, onBusyChange, onSaved };
  const dirty = open && (name !== (editing?.name || '') || certificate !== Boolean(editing?.certificate_enabled));
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const used = new Set(outcomes.map(outcome => outcome.category_id));
  const begin = category => {
    if (dirty && !window.confirm('Discard unsaved category changes?')) return;
    setEditing(category); setName(category?.name || ''); setCertificate(Boolean(category?.certificate_enabled)); setOpen(true); setError('');
  };
  return <section className="border rounded-lg p-4 space-y-4">
    <div className="flex justify-between gap-3 items-center"><h3 className="font-semibold text-sm">Outcome categories</h3>{canEdit && <Button size="sm" variant="outline" disabled={disabled || busy || !ready || uncertain} onClick={() => begin(null)}>Add category</Button>}</div>
    <p className="awards-help">Used categories are immutable. The certificate setting records category configuration; it does not create, issue or send certificates.</p>
    {categories.length ? <ul className="space-y-3">{categories.map(category => <li key={category.id} className="flex flex-wrap items-start justify-between gap-2">
      <div><p className="text-sm font-medium">{category.name}</p><p className="awards-help">{category.certificate_enabled ? 'Certificate-enabled category' : 'No certificate enabled'}{used.has(category.id) ? ' · Used category — immutable' : ''}</p></div>
      {canEdit && <Button size="sm" variant="outline" disabled={disabled || busy || !ready || uncertain || used.has(category.id)} onClick={() => begin(category)}>Edit category</Button>}
    </li>)}</ul> : <p className="awards-help">{ready ? 'No outcome categories have been configured.' : 'Load the complete outcome history to view categories.'}</p>}
    {open && canEdit && <form className="space-y-4 border-t pt-4" onSubmit={async event => {
      event.preventDefault(); if (pending.current || !ready || uncertain || !name.trim()) return;
      pending.current = true; setBusy(true); setError(''); setNotice('');
      try {
        const result = await decisionRequest(tenant, '/api/awards/outcomes', { command: 'category', awardId, ...(editing ? { id: editing.id } : {}), name: name.trim(), certificateEnabled: certificate });
        if (!result.category?.id) throw new Error('The server did not confirm the category. Refresh the complete history before retrying.');
        if (!alive.current) return;
        setOpen(false); setName(''); setCertificate(false); setEditing(null); setNotice('Category saved.');
        await callbacks.current.onSaved();
      } catch (failure) { if (alive.current) { setError(failure.message); setUncertain(true); } }
      finally { pending.current = false; if (alive.current) setBusy(false); }
    }}>
      <fieldset className="space-y-4" disabled={busy || disabled || !ready || uncertain}>
        <div className="awards-field"><Label htmlFor="outcome-category-name">Category name</Label><Input id="outcome-category-name" required maxLength={300} value={name} onChange={event => setName(event.target.value)} /></div>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={certificate} onChange={event => setCertificate(event.target.checked)} /><span>Enable certificates for this category</span></label>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={!name.trim() || (Boolean(editing) && !dirty)}>Save category</Button><Button type="button" variant="outline" onClick={() => { if (!dirty || window.confirm('Discard unsaved category changes?')) setOpen(false); }}>Cancel category edit</Button></div>
      </fieldset>
    </form>}
    {uncertain && <div className="space-y-3"><p className="awards-help">Inspect the refreshed category list before retrying: an unconfirmed create may already have succeeded. Inputs have not been discarded.</p><Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={async () => {
      if (pending.current) return;
      pending.current = true; setBusy(true);
      try { await callbacks.current.onSaved(); if (alive.current) { setUncertain(false); setError(''); } }
      catch (failure) { if (alive.current) setError(failure.message); }
      finally { pending.current = false; if (alive.current) setBusy(false); }
    }}>Reload categories before retrying</Button></div>}
    {error && <p role="alert" className="text-sm text-red-800">{error} Unsaved inputs are retained unless the server already confirmed the save.</p>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
  </section>;
}
