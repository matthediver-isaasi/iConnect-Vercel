import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { validateCriteria } from '../../../../api/_lib/assessment/scoring.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  copyTemplateDefinition, sameTemplateDefinition, saveScoringTemplate, scoringTemplatesKey, useScoringTemplates,
} from './useScoringTemplates';

export default function ScoringTemplateControls({
  tenant, definition, locked, disabled, source, sourceSaved, onApply, onDirtyChange, onBusyChange,
}) {
  const queryClient = useQueryClient();
  const query = useScoringTemplates(tenant);
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState('new');
  const [newName, setNewName] = useState('');
  const [versionName, setVersionName] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [uncertainCreate, setUncertainCreate] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const alive = useRef(false);
  const callbacks = useRef({});
  callbacks.current = { onDirtyChange, onBusyChange, onApply };
  const templates = query.data || [];
  const ready = query.isSuccess && !query.isFetching && !refreshing;
  const current = selected && templates.find(template => template.series_id === selected.series_id);
  const stale = !!selected && (!current || current.id !== selected.id || current.revision !== selected.revision);
  const versionChanged = !!selected && (versionName.trim() !== selected.name || !sameTemplateDefinition(definition, selected.definition));
  const dirty = !!newName || (mode === 'version' && !!selected
    && (versionName !== selected.name || !sameTemplateDefinition(definition, selected.definition)));
  let validationError = '';
  try { validateCriteria(definition); } catch (failure) { validationError = failure.message; }
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false);
    };
  }, []);
  const select = value => {
    if (pending.current || disabled) return;
    if (selected && versionName !== selected.name && !window.confirm('Discard the unsaved template-version name? Your round criteria and new-template name will be kept.')) return;
    const template = templates.find(item => item.id === value);
    setSelected(template ? { ...template, definition: copyTemplateDefinition(template.definition) } : null);
    setVersionName(template?.name || ''); setNotice('');
  };
  const refresh = async () => {
    if (pending.current || disabled) return;
    pending.current = true; setRefreshing(true);
    try {
      tenant.assertCurrent();
      const result = await query.refetch();
      tenant.assertCurrent();
      if (result.error) throw result.error;
      if (alive.current) {
        setBlocked(false); setError(null);
        setNotice('Complete library reloaded. Round criteria, names and the selected version were kept. If a newer version exists, explicitly select it before appending.'
          + (uncertainCreate ? ' An earlier creation may already have been saved; inspect the library before creating another template.' : ''));
      }
    } catch (failure) { if (alive.current) { setError(failure); setBlocked(true); } }
    finally { pending.current = false; if (alive.current) setRefreshing(false); }
  };
  const adoptLatest = () => {
    if (pending.current || disabled || !ready || !current) return;
    if (!window.confirm(`Use revision ${current.revision} as the expected latest version of “${current.name}”? This keeps your current criteria and typed names. It does not copy the template definition or save anything.`)) return;
    setSelected({ ...current, definition: copyTemplateDefinition(current.definition) });
    setNotice('Expected template version updated explicitly. Current criteria and names are unchanged; review them before appending a new version.');
  };
  const apply = () => {
    if (pending.current || disabled || locked || !ready || blocked || !selected || stale) return;
    try {
      tenant.assertCurrent(); validateCriteria(selected.definition);
      callbacks.current.onApply({ ...selected, definition: copyTemplateDefinition(selected.definition) });
    } catch (failure) { setError(failure); }
  };
  const save = async event => {
    event.preventDefault();
    if (pending.current || disabled || !ready || blocked || validationError || (mode === 'version' && (!selected || stale || !versionChanged))) return;
    const name = (mode === 'new' ? newName : versionName).trim();
    if (!name || name.length > 300) return;
    const message = mode === 'new'
      ? `Save the current structured criteria as a NEW reusable template named “${name}”?${uncertainCreate ? ' An earlier creation was not confirmed; check the library first to avoid a duplicate.' : ''}`
      : `Append immutable revision ${selected.revision + 1} to “${selected.name}”, named “${name}”, using the current criteria? Earlier versions will be retained.`;
    if (!window.confirm(`${message} This saves the reusable library only; it does not save or apply round criteria.`)) return;
    pending.current = true; setSaving(true); callbacks.current.onBusyChange(true); setError(null); setNotice('');
    const payload = {
      seriesId: mode === 'new' ? null : selected.series_id,
      revision: mode === 'new' ? 0 : selected.revision,
      name, definition: copyTemplateDefinition(definition),
    };
    let confirmed = false;
    try {
      const template = await saveScoringTemplate(tenant, payload);
      tenant.assertCurrent();
      if (!alive.current) return;
      confirmed = true;
      queryClient.setQueryData(scoringTemplatesKey(tenant), old => Array.isArray(old)
        ? [...old.filter(item => item.series_id !== template.series_id), template].sort((a, b) => a.series_id.localeCompare(b.series_id))
        : old);
      setSelected({ ...template, definition: copyTemplateDefinition(template.definition) });
      setVersionName(template.name);
      if (mode === 'new') { setNewName(''); setUncertainCreate(false); }
      setNotice(`Reusable template “${template.name}” revision ${template.revision} saved. Your round criteria and its source association were not changed or saved.`);
      const refreshed = await query.refetch();
      tenant.assertCurrent();
      if (refreshed.error) throw refreshed.error;
    } catch (failure) {
      if (alive.current) {
        setBlocked(true);
        setError(Object.assign(new Error(confirmed
          ? `The reusable template was saved, but refreshing the library failed: ${failure.message}. Reload the library; do not repeat the save.`
          : failure.message || 'The reusable template save could not be confirmed.'), { status: failure.status }));
        if (!confirmed && mode === 'new') setUncertainCreate(true);
      }
    } finally {
      pending.current = false;
      if (alive.current) { setSaving(false); callbacks.current.onBusyChange(false); }
    }
  };
  const clear = () => {
    if (pending.current || disabled || (dirty && !window.confirm('Discard unsaved template names and save choices? Your round criteria and its source association will not change.'))) return;
    setNewName(''); setVersionName(''); setSelected(null); setMode('new'); setNotice('');
  };
  return <section className="my-6 space-y-4 rounded-lg border border-[#d3e3e4] bg-[#edf4f4]/40 p-4 sm:p-5" aria-labelledby="scoring-templates-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h4 id="scoring-templates-title" className="text-sm font-semibold">Reusable scoring templates</h4><p className="awards-help mt-1">A separate library of immutable versions. Saving a template never saves round criteria; copying one only changes the local criteria draft.</p></div>
      <Button type="button" variant="outline" size="sm" disabled={disabled || saving || refreshing || query.isFetching} onClick={refresh}>{refreshing || query.isFetching ? 'Loading all templates…' : 'Refresh template library'}</Button>
    </div>
    {query.isPending && <div role="status" aria-label="Loading complete scoring template library" className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-6 w-2/3" /></div>}
    {query.isError && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">{query.error.message} No partial template list is offered. Use Refresh template library to retry.</div>}
    {error && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">
      <p>{error.message}</p><p className="mt-2">Round criteria and unsaved names are retained. Reload the complete library before another template operation; a failed response does not prove the save was rejected.</p>
      {uncertainCreate && <p className="mt-2">A new template may already exist. Inspect the reloaded library before repeating creation; it is never retried automatically.</p>}
    </div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {query.isSuccess && !templates.length && <div className="rounded-lg border border-dashed p-4"><p className="text-sm font-medium">No reusable templates yet</p><p className="awards-help mt-1">Complete the structured criteria below and save a named template to make it reusable.</p></div>}
    <fieldset disabled={disabled || saving || refreshing || !ready} className="space-y-4">
      <legend className="sr-only">Choose an existing scoring template</legend>
      <div className="awards-field"><Label htmlFor="scoring-template-choice">Saved template — latest version per series</Label>
        <select id="scoring-template-choice" className="awards-select" value={selected?.id || ''} onChange={event => select(event.target.value)}>
          <option value="">Choose a template explicitly</option>
          {selected && !templates.some(item => item.id === selected.id) && <option value={selected.id}>{selected.name} · revision {selected.revision} (last selected; not the latest loaded version)</option>}
          {templates.map(template => <option key={template.id} value={template.id}>{template.name} · revision {template.revision} · series {template.series_id.slice(0, 8)}</option>)}
        </select><p className="awards-help">{query.isSuccess ? `${templates.length} latest versions loaded across every server page. ` : ''}Choosing or refreshing this list never applies criteria automatically.</p>
      </div>
      {selected && <div className="space-y-3 rounded-lg border p-4">
        <p className="text-sm font-medium">{selected.name} · revision {selected.revision}</p>
        <p className="awards-help">{selected.definition.criteria.length} criteria · Optional-score policy: {selected.definition.optionalPolicy === 'renormalise' ? 'Renormalise' : 'Incomplete'}</p>
        <details><summary className="cursor-pointer text-sm font-medium">Inspect template criteria</summary>
          <ol className="mt-3 max-h-64 list-decimal space-y-2 overflow-y-auto pl-5 text-sm">{selected.definition.criteria.map(criterion => <li key={criterion.id}>
            <span className="font-medium">{criterion.title}</span><span className="awards-help"> · {criterion.type.replaceAll('_', ' ')} · {criterion.required ? 'required' : 'optional'}{criterion.commentsRequired ? ' · comment required' : ''}{criterion.type === 'numeric' || criterion.type === 'rating' ? ` · weight ${criterion.weight}% · range ${criterion.min}–${criterion.max}` : criterion.type !== 'text' ? ` · ${criterion.effect} effect` : ''}</span>
            {criterion.type === 'rating' && <ul className="awards-help mt-1 list-disc pl-4">{criterion.options.map(option => <li key={option.key}>{option.key}: {option.value}</li>)}</ul>}
          </li>)}</ol>
        </details>
        {stale && <div role="alert" className="space-y-2 text-sm"><p>The selected version is no longer the latest loaded version. Your current criteria and names were not replaced.</p>
          {current && <Button type="button" size="sm" variant="outline" onClick={adoptLatest}>Use latest revision as save target (keep draft)</Button>}
        </div>}
        <Button type="button" variant="outline" disabled={locked || blocked || stale || !ready} onClick={apply}>Copy selected definition into criteria draft</Button>
      </div>}
    </fieldset>
    {locked && <p className="awards-help">This round is read-only: templates cannot replace its criteria. You may still save the current definition to the reusable library.</p>}
    <p className="awards-help">{source
      ? `${sourceSaved ? 'Saved round criteria retain' : 'The current draft retains'} template provenance${source.name ? ` from “${source.name}”${source.revision ? ` revision ${source.revision}` : ''}` : ''}. ${sourceSaved ? 'Any criteria edit clears the draft association for the next criteria revision.' : locked ? 'This is a local draft association only; the read-only round cannot save it.' : 'Save a round criteria revision separately to persist that association. Any criteria edit clears it.'}`
      : 'No template source is claimed for the current draft. A matching name or definition is never treated as provenance automatically.'}</p>
    <form className="space-y-4 border-t pt-4" onSubmit={save}>
      <fieldset disabled={disabled || saving || refreshing} className="space-y-4">
        <legend className="text-sm font-semibold">Save current structured criteria to the library</legend>
        <div className="awards-field"><Label htmlFor="scoring-template-mode">Save destination</Label><select id="scoring-template-mode" className="awards-select" value={mode} onChange={event => setMode(event.target.value)}>
          <option value="new">A new named template</option><option value="version" disabled={!selected}>A new version of the explicitly selected template</option>
        </select></div>
        <div className="awards-field"><Label htmlFor="scoring-template-name">{mode === 'new' ? 'New template name' : 'Name for the new template version'}</Label>
          <Input id="scoring-template-name" required maxLength={300} value={mode === 'new' ? newName : versionName}
            onChange={event => mode === 'new' ? setNewName(event.target.value) : setVersionName(event.target.value)} />
        </div>
        {mode === 'version' && selected && <p className="awards-help">Appends after expected revision {selected.revision} of “{selected.name}”. It does not overwrite any immutable version.</p>}
        {validationError && <p className="awards-help">Before saving a template, resolve the current criteria: {validationError}.</p>}
        {mode === 'version' && selected && !versionChanged && <p className="awards-help">The selected template already matches this definition and name. There is no new version to save.</p>}
        <div className="flex flex-wrap gap-3"><Button type="submit" variant="outline"
          disabled={!ready || blocked || !!validationError || !(mode === 'new' ? newName.trim() : versionName.trim())
            || (mode === 'version' && (!selected || stale || !versionChanged))}>
          {saving ? 'Saving reusable template…' : mode === 'new' ? 'Save new reusable template' : 'Append reusable template version'}
        </Button><Button type="button" variant="ghost" onClick={clear}>Clear template choices (keep criteria)</Button></div>
      </fieldset>
    </form>
    {dirty && <p className="awards-help">Unsaved reusable-template save choices. They are separate from the round criteria draft.</p>}
  </section>;
}
