import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react';
import { listAwardRounds, getAwardRound, awardRoundCommand } from '@/lib/awardsApi';
import { validateCriteria } from '../../../../api/_lib/assessment/scoring.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { TimezoneAwareDateTimeInput } from '@/components/events/TimezoneAwareDateTimeInput';
import RoundOperations from './RoundOperations';
import ScoringTemplateControls from './ScoringTemplateControls';
import { copyTemplateDefinition, sameTemplateDefinition } from './useScoringTemplates';
import './awards.css';

const TYPES = [['numeric', 'Numeric score'], ['rating', 'Mapped rating'], ['yes_no', 'Yes / no'], ['pass_fail', 'Pass / fail'], ['text', 'Text response']];
const scored = type => type === 'numeric' || type === 'rating';
const emptyDefinition = () => ({ optionalPolicy: '', criteria: [] });
const configOf = round => ({
  name: round.name || '', opens_at: round.opens_at || '', closes_at: round.closes_at || '',
  required_judges: round.required_judges ?? '', require_all: Boolean(round.require_all),
  visibility: round.visibility || 'blind', comments_visible: Boolean(round.comments_visible),
  moderation_required: Boolean(round.moderation_required), self_approval: Boolean(round.self_approval),
});
const move = (items, index, direction) => {
  const next = [...items], target = index + direction;
  if (target < 0 || target >= next.length) return items;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};
const freshCriterion = () => ({
  id: `criterion_${crypto.randomUUID().replaceAll('-', '')}`, title: '', type: 'numeric',
  required: true, commentsRequired: false, min: '', max: '', weight: '',
});

export default function RoundConfiguration({ award, tenant, canEdit, canAssign = false, onDirtyChange, onBusyChange }) {
  // Scope remounts discard only drafts belonging to the previous award/session.
  return <RoundWorkspace key={`${tenant.scopeKey}:${award.id}`} award={award} tenant={tenant} canEdit={canEdit} canAssign={canAssign}
    onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} />;
}

function RoundWorkspace({ award, tenant, canEdit, canAssign, onDirtyChange, onBusyChange }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [editorDirty, setEditorDirty] = useState(false);
  const [commandBusy, setBusy] = useState(false);
  const [operationsBusy, setOperationsBusy] = useState(false);
  const [operationsDirty, setOperationsDirty] = useState(false);
  const [criteriaReconciliationRequired, setCriteriaReconciliationRequired] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const busy = commandBusy || operationsBusy || templateBusy;
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const scope = ['award-rounds', tenant.scopeKey, award.id];
  const detailKey = [...scope, 'detail', selectedId];
  const dirty = editorDirty || operationsDirty || (creating && Boolean(name));
  const callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  useEffect(() => { callbacks.current.onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange?.(busy); }, [busy]);
  useEffect(() => () => { callbacks.current.onDirtyChange?.(false); callbacks.current.onBusyChange?.(false); }, []);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const unload = event => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    const link = event => {
      if (dirtyRef.current && event.target.closest?.('a[href]') && !window.confirm('Discard unsaved round changes?')) event.preventDefault();
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', link, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', link, true); };
  }, []);
  const roundsQuery = useQuery({
    queryKey: [...scope, 'list', page],
    queryFn: async () => { tenant.assertCurrent(); const data = await listAwardRounds(award.id, page); tenant.assertCurrent(); return data; },
    refetchOnWindowFocus: false,
  });
  const detailQuery = useQuery({
    queryKey: detailKey, enabled: Boolean(selectedId) && !creating,
    queryFn: async () => { tenant.assertCurrent(); const data = await getAwardRound(award.id, selectedId); tenant.assertCurrent(); return data; },
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const leave = () => !busy && (!dirty || window.confirm('Discard unsaved round settings, criteria, reusable-template names or administration choices?'));
  const runCommand = async (command, round, payload) => {
    if (command === 'appoint' ? !canAssign : !canEdit) throw new Error('Your role does not allow this round action.');
    if (pending.current) throw new Error('A round save is already in progress.');
    tenant.assertCurrent(); pending.current = true; setBusy(true);
    try {
      const result = await awardRoundCommand(award.id, command, round, payload);
      tenant.assertCurrent();
      queryClient.setQueriesData({ queryKey: [...scope, 'list'] }, old => old ? {
        ...old, rounds: old.rounds.map(item => item.id === result.id ? result : item),
      } : old);
      if (command !== 'create') queryClient.setQueryData([...scope, 'detail', result.id], old => old ? {
        ...old, round: result,
        criteria: command === 'criteria' ? { id: result.criteria_version_id, revision: null, definition: payload.definition, template_version_id: payload.template_version_id || null } : old.criteria,
      } : old);
      if (command === 'create') {
        queryClient.invalidateQueries({ queryKey: [...scope, 'list'] });
        setSelectedId(result.id); setCreating(false); setName(''); setEditorDirty(false);
      }
      return result;
    } finally { pending.current = false; setBusy(false); }
  };
  const reloadDetail = async () => {
    if (busy || !leave()) return;
    setError(''); setBusy(true);
    try {
      tenant.assertCurrent();
      const result = await detailQuery.refetch();
      tenant.assertCurrent();
      if (result.error) throw result.error;
      setReload(value => value + 1); setEditorDirty(false);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const updateRound = fresh => {
    queryClient.setQueriesData({ queryKey: [...scope, 'list'] }, old => old ? {
      ...old, rounds: old.rounds.map(item => item.id === selectedId ? { ...item, ...fresh } : item),
    } : old);
    queryClient.setQueryData(detailKey, old => old ? { ...old, round: { ...old.round, ...fresh } } : old);
  };
  const refreshRoundMetadata = async () => {
    tenant.assertCurrent();
    const result = await getAwardRound(award.id, selectedId);
    tenant.assertCurrent();
    if (result.round?.id !== selectedId || !Number.isSafeInteger(result.round.version)) throw new Error('The server did not return the current round version. Your drafts are retained.');
    updateRound(result.round);
    return result.round;
  };
  const refreshRoundCriteria = async () => {
    tenant.assertCurrent();
    const result = await getAwardRound(award.id, selectedId);
    tenant.assertCurrent();
    if (result.round?.id !== selectedId || !Number.isSafeInteger(result.round.version)
      ) throw new Error('The current round version could not be verified. Local drafts were retained.');
    if (!result.criteria) throw new Error('No saved rubric exists. Save the initial criteria using the ordinary draft editor first; this separate correction requires a saved version.');
    if (!result.criteria.id || !Number.isSafeInteger(result.criteria.revision)) throw new Error('The saved criteria version could not be verified. Local drafts were retained.');
    validateCriteria(result.criteria.definition);
    updateRound(result.round);
    queryClient.setQueryData(detailKey, old => old ? { ...old, criteria: result.criteria } : old);
    return result;
  };
  const invalidateLifecyclePreviews = () => {
    queryClient.setQueryData(['award-round-preview-epoch', tenant.scopeKey, selectedId], old => (old || 0) + 1);
    queryClient.invalidateQueries({ queryKey: ['award-decision-rounds', tenant.scopeKey, award.id] });
    queryClient.invalidateQueries({ queryKey: ['award-audit-history', tenant.scopeKey, award.id] });
  };
  const invalidateCriteriaViews = () => {
    invalidateLifecyclePreviews();
    queryClient.invalidateQueries({ queryKey: ['awards-moderation', tenant.scopeKey, selectedId] });
    queryClient.invalidateQueries({ queryKey: ['award-report', tenant.scopeKey, selectedId] });
    // Assignment refetch is explicitly awaited by RoundOperations, only when
    // this user has assign capability. Configure alone must not issue that GET.
    queryClient.invalidateQueries({ queryKey: ['award-round-assignment-controls', tenant.scopeKey, selectedId], refetchType: 'none' });
  };
  const rounds = roundsQuery.data?.rounds || [];
  const { total = 0, pageSize = 50 } = roundsQuery.data || {};
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  return <Card className="mt-6 min-w-0 shadow-sm">
    <CardHeader className="border-b">
      <div className="flex flex-wrap justify-between items-start gap-3">
        <div><p className="awards-kicker mb-2">Assessment configuration</p><CardTitle className="text-xl">Rounds & criteria</CardTitle></div>
        {canEdit && <Button variant="outline" size="sm" disabled={busy} onClick={() => {
          if (creating || !leave()) return;
          setCreating(true); setName(''); setEditorDirty(false); setError('');
        }}><Plus className="w-4 h-4 mr-2" />New round</Button>}
      </div>
      <p className="awards-help">Set assessment rules and save versioned criteria. Round settings are editable only in draft.</p>
    </CardHeader>
    <CardContent className="pt-5 space-y-5">
      {roundsQuery.isLoading ? <div aria-label="Loading rounds" className="space-y-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
        : roundsQuery.isError ? <div role="alert" className="text-sm text-red-700"><p>{roundsQuery.error.message}</p><Button variant="outline" className="mt-3" onClick={() => roundsQuery.refetch()}>Retry rounds</Button></div>
          : rounds.length ? <div className="rounded-lg border overflow-hidden" role="group" aria-label="Select assessment round">
            {rounds.map(round => <button type="button" key={round.id} className="awards-choice" disabled={busy}
              aria-pressed={!creating && selectedId === round.id} onClick={() => {
                if ((!creating && round.id === selectedId) || !leave()) return;
                setCreating(false); setSelectedId(round.id); setEditorDirty(false); setError('');
              }}>
              <span className="flex justify-between items-start gap-3"><span className="text-sm font-medium break-words">{round.name}</span><span className="awards-status" data-state={round.state}>{round.state.replaceAll('_', ' ')}</span></span>
              <span className="block awards-help mt-1">Version {round.version}</span>
            </button>)}
          </div> : <div className="rounded-lg border bg-slate-50 p-6"><h3 className="font-medium text-sm">No rounds on this page</h3><p className="awards-help mt-1">{canEdit ? 'Create a draft round to define its assessment rules.' : 'Saved assessment rounds will appear here.'}</p></div>}
      {roundsQuery.data && <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="outline" disabled={busy || page <= 1} onClick={() => { if (leave()) { setPage(page - 1); setSelectedId(''); setCreating(false); setEditorDirty(false); } }}>Previous</Button>
        <span className="text-xs text-slate-500">Page {page} of {pages} · {total} rounds</span>
        <Button size="sm" variant="outline" disabled={busy || page >= pages} onClick={() => { if (leave()) { setPage(page + 1); setSelectedId(''); setCreating(false); setEditorDirty(false); } }}>Next</Button>
      </div>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {creating ? <form className="rounded-lg border p-4 space-y-4" onSubmit={async event => {
        event.preventDefault(); if (busy || !name.trim()) return;
        setError('');
        try { await runCommand('create', null, { name: name.trim() }); }
        catch (failure) { setError(failure.message); }
      }}>
        <div className="awards-field"><Label htmlFor="new-round-name">Round name</Label><Input id="new-round-name" required value={name} disabled={busy || !canEdit} onChange={event => setName(event.target.value)} /></div>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => { if (leave()) { setCreating(false); setName(''); } }}>Cancel</Button>
          <Button type="submit" disabled={busy || !canEdit || !name.trim()}>{busy ? 'Saving…' : 'Create draft round'}</Button></div>
      </form> : selectedId ? <>
        <div className="flex justify-end"><Button variant="outline" size="sm" disabled={busy} onClick={reloadDetail}>Reload round</Button></div>
        {detailQuery.isLoading ? <div aria-label="Loading round configuration" className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-48 w-full" /></div>
          : detailQuery.isError ? <div role="alert" className="text-sm text-red-700"><p>{detailQuery.error.message}</p><Button variant="outline" className="mt-3" onClick={reloadDetail}>Retry round</Button></div>
             : detailQuery.data && <RoundEditor key={`${selectedId}:${reload}`} initial={detailQuery.data} timezone={award.timezone} canEdit={canEdit}
                tenant={tenant} busy={busy || criteriaReconciliationRequired} reconciliationRequired={criteriaReconciliationRequired}
                templateSaving={templateBusy} runCommand={runCommand} onDirtyChange={setEditorDirty} onTemplateBusyChange={setTemplateBusy} />}
        {detailQuery.data && !detailQuery.isError && (canAssign || canEdit) && <RoundOperations
          key={`operations:${selectedId}:${reload}`} awardId={award.id} round={detailQuery.data.round} timezone={award.timezone}
           tenant={tenant} canEdit={canEdit} canAssign={canAssign} parentBusy={commandBusy || templateBusy} editorDirty={editorDirty}
           runCommand={runCommand} onVersionChange={version => updateRound({ version })} onRoundChange={updateRound}
           onLifecycleChanged={invalidateLifecyclePreviews} refreshRound={refreshRoundMetadata}
           CriteriaEditor={CriteriaDefinitionFields} refreshCriteria={refreshRoundCriteria}
           onCriteriaChanged={invalidateCriteriaViews}
           onCriteriaUncertainChange={setCriteriaReconciliationRequired}
          onDirtyChange={setOperationsDirty} onBusyChange={setOperationsBusy} />}
      </> : <p className="awards-help">Select a round to review its settings and criteria.</p>}
    </CardContent>
  </Card>;
}

function RoundEditor({ initial, timezone, canEdit, tenant, busy, reconciliationRequired, templateSaving, runCommand, onDirtyChange, onTemplateBusyChange }) {
  const [round, setRound] = useState(initial.round);
  // Own appointment/allocation commands advance only round metadata. Keep
  // unsaved settings and criteria intact while using the server's next version.
  useEffect(() => { setRound(initial.round); }, [initial.round.id, initial.round.version]);
  const [config, setConfig] = useState(() => configOf(initial.round));
  const [savedConfig, setSavedConfig] = useState(() => JSON.stringify(configOf(initial.round)));
  const [definition, setDefinition] = useState(() => initial.criteria?.definition || emptyDefinition());
  const [savedDefinition, setSavedDefinition] = useState(() => JSON.stringify(initial.criteria?.definition || emptyDefinition()));
  const [criteriaRevision, setCriteriaRevision] = useState(initial.criteria?.revision);
  const [templateDirty, setTemplateDirty] = useState(false);
  const [source, setSource] = useState(() => initial.criteria?.template_version_id
    ? { id: initial.criteria.template_version_id, definition: copyTemplateDefinition(initial.criteria.definition) } : null);
  const [savedTemplateId, setSavedTemplateId] = useState(initial.criteria?.template_version_id || null);
  const [dates, setDates] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const configDirty = JSON.stringify(config) !== savedConfig || Object.values(dates).some(value => value?.localValue !== undefined);
  const templateId = source && sameTemplateDefinition(source.definition, definition) ? source.id : null;
  const criteriaDirty = JSON.stringify(definition) !== savedDefinition || templateId !== savedTemplateId;
  const settingsMetadataVersion = useRef(initial.round.version);
  useEffect(() => {
    if (settingsMetadataVersion.current === initial.round.version) return;
    settingsMetadataVersion.current = initial.round.version;
    const previous = JSON.parse(savedConfig), fresh = configOf(initial.round);
    if (fresh.closes_at === previous.closes_at) return;
    // A separately authorised revision/lifecycle change owns its saved
    // deadline. Rebase only an untouched date; retain explicitly edited dates,
    // pending local-time input and every unrelated settings draft.
    if (config.closes_at === previous.closes_at && dates.closes_at?.localValue === undefined && !dates.closes_at?.error) {
      setConfig(old => ({ ...old, closes_at: fresh.closes_at }));
    }
    setSavedConfig(old => JSON.stringify({ ...JSON.parse(old), closes_at: fresh.closes_at }));
  }, [initial.round, savedConfig, config.closes_at, dates.closes_at]);
  const loadedCriteria = useRef(initial.criteria?.id);
  const adoptLoadedCriteria = () => {
    const saved = initial.criteria;
    if (!saved) return;
    setDefinition(copyTemplateDefinition(saved.definition)); setSavedDefinition(JSON.stringify(saved.definition));
    setCriteriaRevision(saved.revision); setSavedTemplateId(saved.template_version_id || null);
    setSource(saved.template_version_id ? { id: saved.template_version_id, definition: copyTemplateDefinition(saved.definition) } : null);
    loadedCriteria.current = saved.id;
  };
  useEffect(() => {
    if (initial.criteria?.id !== loadedCriteria.current && !criteriaDirty && !templateDirty) adoptLoadedCriteria();
    // Only clean criteria follow a newly loaded server version. Settings and
    // retained criteria/template drafts are never reinitialised by this read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.criteria, criteriaDirty, templateDirty]);
  useEffect(() => { onDirtyChange(configDirty || criteriaDirty || templateDirty); }, [configDirty, criteriaDirty, templateDirty, onDirtyChange]);
  const locked = !canEdit || round.state !== 'draft' || initial.round.state !== 'draft';
  const patch = (key, value) => { setConfig(old => ({ ...old, [key]: value })); setNotice(''); };
  const editDefinition = update => {
    if (locked || busy) return;
    setSource(null); setDefinition(update); setNotice('');
  };
  const applyTemplate = template => {
    if (locked || busy) return;
    tenant.assertCurrent(); validateCriteria(template.definition);
    if (!window.confirm(`Replace the current criteria draft with “${template.name}” revision ${template.revision}? Unsaved criteria edits will be discarded. Round settings and reusable-template names will be kept. This does not save round criteria.`)) return;
    const next = copyTemplateDefinition(template.definition);
    setDefinition(next);
    setSource({ id: template.id, name: template.name, revision: template.revision, definition: copyTemplateDefinition(next) });
    setError(''); setNotice('Template definition copied into the criteria draft. Save a criteria revision separately to persist it to this draft round.');
  };
  const save = async (kind, event) => {
    event.preventDefault(); if (locked || busy) return;
    setError(''); setNotice('');
    try {
      let payload;
      if (kind === 'configure') {
        if (!config.name.trim()) throw new Error('Enter a round name.');
        const judges = Number(config.required_judges);
        if (!Number.isInteger(judges) || judges < 1 || judges > 100) throw new Error('Required judges must be a whole number between 1 and 100.');
        if (Object.values(dates).some(value => value?.error)) throw new Error('Resolve local date and time errors before saving.');
        if (config.opens_at && config.closes_at && new Date(config.closes_at) <= new Date(config.opens_at)) throw new Error('The round closing time must be after its opening time.');
        payload = { ...config, name: config.name.trim(), required_judges: judges, opens_at: config.opens_at || null, closes_at: config.closes_at || null };
      } else {
        validateCriteria(definition);
        payload = { definition, ...(templateId ? { template_version_id: templateId } : {}) };
      }
      const result = await runCommand(kind, round, payload);
      if (!alive.current) return;
      setRound(result);
      if (kind === 'configure') {
        const next = configOf(result); setConfig(next); setSavedConfig(JSON.stringify(next)); setDates({});
      } else {
        setSavedDefinition(JSON.stringify(definition)); setSavedTemplateId(payload.template_version_id || null); setCriteriaRevision(null);
      }
      setNotice(kind === 'configure' ? 'Round settings saved.' : 'Criteria revision saved. Reload the round to retrieve its revision number.');
    } catch (failure) { if (alive.current) setError(failure.message || 'Unable to save round configuration.'); }
  };
  return <div className="border-t pt-5">
    <div className="flex justify-between gap-3 mb-4"><h3 className="font-semibold break-words">{round.name}</h3><span className="awards-help shrink-0">Version {round.version}</span></div>
    {locked && <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600 mb-5">{canEdit ? 'This round is no longer in draft. Settings and criteria are read-only.' : 'Your role has read-only access to round configuration.'}</p>}
    <form onSubmit={event => save('configure', event)}>
      <fieldset disabled={locked || busy} className="space-y-5">
        <legend className="text-sm font-semibold mb-4">Round settings</legend>
        <div className="awards-field"><Label htmlFor="round-name">Name</Label><Input id="round-name" required value={config.name} onChange={event => patch('name', event.target.value)} /></div>
        <div className="grid md:grid-cols-2 gap-4">
          {[['opens_at', 'Opens at'], ['closes_at', 'Closes at']].map(([key, title]) => <div className="awards-field" key={key}><Label htmlFor={`round-${key}`}>{title} ({timezone})</Label>
            <TimezoneAwareDateTimeInput id={`round-${key}`} value={locked && !configDirty ? round[key] || '' : config[key]} tz={timezone} strict pendingLocalValue={dates[key]?.localValue}
              onChange={(iso, meta) => { patch(key, iso); setDates(old => ({ ...old, [key]: meta?.localValue === '' ? { localValue: undefined, error: '' } : meta })); }} /></div>)}
        </div>
        <p className="awards-help">Times use the competition timezone, {timezone}. Stored timestamps are UTC.</p>
        <div className="awards-field"><Label htmlFor="round-judges">Minimum completed judge assessments</Label><Input id="round-judges" type="number" min="1" max="100" step="1" required value={config.required_judges} onChange={event => patch('required_judges', event.target.value)} /></div>
        <div className="awards-field"><Label htmlFor="round-visibility">Other judges’ assessment visibility</Label><select id="round-visibility" className="awards-select" value={config.visibility} onChange={event => patch('visibility', event.target.value)}>
          <option value="blind">Blind — hidden from other judges</option><option value="after_submit">After submission — completed assessments only</option><option value="open">Open — completed assessments visible</option>
        </select><p className="awards-help">Blind assessment does not anonymise applicant answers.</p></div>
        {[
          ['require_all', 'Require all assigned judges to complete', 'Require every assigned assessment in addition to the configured minimum.'],
          ['comments_visible', 'Show assessment comments when visibility permits', 'Comments remain subject to the selected visibility rule.'],
          ['moderation_required', 'Require moderation', 'Record moderation as a required part of this round.'],
          ['self_approval', 'Permit self-approval', 'Explicitly allow self-approval where the actor also has the required authority.'],
        ].map(([key, title, help]) => <label key={key} className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={config[key]} onChange={event => patch(key, event.target.checked)} /><span><span className="block text-sm font-medium">{title}</span><span className="awards-help">{help}</span></span></label>)}
      </fieldset>
      {!locked && <div className="flex justify-between items-center gap-3 mt-5"><span className="awards-help">{configDirty ? 'Unsaved round settings' : 'Saved round settings'}</span><Button type="submit" disabled={busy || !configDirty}><Save className="h-4 w-4 mr-2" />Save settings</Button></div>}
    </form>
    {canEdit && <ScoringTemplateControls tenant={tenant} definition={definition} locked={locked} disabled={busy}
      source={templateId ? source : null} sourceSaved={!!templateId && templateId === savedTemplateId && !criteriaDirty}
      onApply={applyTemplate} onDirtyChange={setTemplateDirty} onBusyChange={onTemplateBusyChange} />}
    <form className="border-t mt-6 pt-6" onSubmit={event => save('criteria', event)}>
      <CriteriaDefinitionFields definition={definition} onChange={editDefinition} disabled={busy} readOnly={locked}
        legend={`Assessment criteria${criteriaRevision ? ` · revision ${criteriaRevision}` : ''}`} />
      {!locked && <div className="flex flex-wrap justify-between items-center gap-3 mt-5"><span className="awards-help">{criteriaDirty ? 'Unsaved criteria changes' : initial.criteria || criteriaRevision === null ? 'Saved criteria definition' : 'No saved criteria definition'}</span><Button type="submit" disabled={busy || !criteriaDirty}><Save className="h-4 w-4 mr-2" />Save criteria revision</Button></div>}
    </form>
    {initial.criteria?.id !== loadedCriteria.current && <div className="rounded-lg border p-4 mt-4 space-y-3"><p className="awards-help">A newer saved criteria revision is loaded. Your existing criteria/template draft was retained; it has not replaced that saved version. Round settings are unaffected.</p><Button type="button" variant="outline" disabled={busy || templateDirty} onClick={() => {
      if (window.confirm('Discard only this retained criteria draft and display the latest saved rubric? Round settings and template-save drafts are not changed.')) adoptLoadedCriteria();
    }}>Display latest saved criteria (discard criteria draft)…</Button></div>}
    {busy && <p role="status" className="awards-help mt-4">{reconciliationRequired ? 'Authorised rubric correction needs reconciliation below before other round edits can be saved. Your existing settings and criteria drafts are retained.' : templateSaving ? 'Saving the reusable template only. Round criteria are not being saved.' : 'Saving round changes…'}</p>}
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 text-sm mt-5">{error}<p className="mt-2">Your edits are retained. If the round version changed, copy any needed edits before reloading the round.</p></div>}
    {notice && <p role="status" className="text-sm text-emerald-800 mt-4">{notice}</p>}
  </div>;
}

function CriteriaDefinitionFields({ definition, onChange, disabled, readOnly = false, idPrefix = 'round', legend = 'Assessment criteria' }) {
  return <fieldset disabled={disabled || readOnly} className="space-y-5">
    <legend className="font-semibold mb-2">{legend}</legend>
    <p className="awards-help">Each save retains a new criteria revision. Numeric and mapped ratings contribute to the score; their weights must total exactly 100%.</p>
    <div className="awards-field"><Label htmlFor={`${idPrefix}-optional-policy`}>Unanswered optional scored criteria</Label><select id={`${idPrefix}-optional-policy`} className="awards-select" required value={definition.optionalPolicy || ''} onChange={event => onChange(old => ({ ...old, optionalPolicy: event.target.value }))}>
      <option value="" disabled>Select an explicit policy</option><option value="incomplete">Incomplete — no final ranking score</option><option value="renormalise">Renormalise — redistribute answered weights</option>
    </select><p className="awards-help">An unanswered score is never treated as zero. No answered scored criteria means no score.</p></div>
    {!definition.criteria.length && <div className="rounded-lg border border-dashed p-5"><p className="text-sm font-medium">No criteria defined</p><p className="awards-help mt-1">Add a scored criterion, then define its range and share of the final score.</p></div>}
    {definition.criteria.map((criterion, index) => <CriterionEditor key={criterion.id} idPrefix={idPrefix} criterion={criterion} index={index} count={definition.criteria.length}
      onChange={values => onChange(old => ({ ...old, criteria: old.criteria.map((item, position) => position === index ? { ...item, ...values } : item) }))}
      onMove={direction => onChange(old => ({ ...old, criteria: move(old.criteria, index, direction) }))}
      onRemove={() => { if (window.confirm(`Remove criterion ${index + 1}${criterion.title ? `, “${criterion.title}”` : ''} from this draft? Previously saved revisions are retained.`)) onChange(old => ({ ...old, criteria: old.criteria.filter((_, position) => position !== index) })); }} />)}
    {!readOnly && <Button type="button" variant="outline" disabled={definition.criteria.length >= 100} onClick={() => onChange(old => ({ ...old, criteria: [...old.criteria, freshCriterion()] }))}><Plus className="h-4 w-4 mr-2" />Add criterion</Button>}
  </fieldset>;
}

function CriterionEditor({ criterion, index, count, onChange, onMove, onRemove, idPrefix = 'round' }) {
  const id = `${idPrefix}-criterion-${criterion.id}`;
  const options = criterion.options || [];
  const updateOption = (position, patch) => onChange({ options: options.map((option, optionIndex) => position === optionIndex ? { ...option, ...patch } : option) });
  const changeType = type => {
    const base = { ...criterion, type };
    delete base.min; delete base.max; delete base.weight; delete base.options; delete base.effect;
    if (scored(type)) Object.assign(base, { min: '', max: '', weight: '', ...(type === 'rating' ? { options: [{ key: '', value: '' }, { key: '', value: '' }] } : {}) });
    else if (type !== 'text') base.effect = 'informational';
    // Explicit undefined removes fields from the serialized definition when types change.
    onChange({ min: undefined, max: undefined, weight: undefined, options: undefined, effect: undefined, ...base });
  };
  return <fieldset className="rounded-lg border p-4 space-y-4">
    <legend className="px-2 text-sm font-semibold">Criterion {index + 1}</legend>
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button type="button" variant="outline" size="icon" aria-label={`Move criterion ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp className="h-4 w-4" /></Button>
      <Button type="button" variant="outline" size="icon" aria-label={`Move criterion ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown className="h-4 w-4" /></Button>
      <Button type="button" variant="outline" size="icon" aria-label={`Remove criterion ${index + 1}`} onClick={onRemove}><Trash2 className="h-4 w-4" /></Button>
    </div>
    <div className="awards-field"><Label htmlFor={`${id}-title`}>Title</Label><Input id={`${id}-title`} required maxLength={500} value={criterion.title} onChange={event => onChange({ title: event.target.value })} /></div>
    <div className="awards-field"><Label htmlFor={`${id}-type`}>Response type</Label><select id={`${id}-type`} className="awards-select" value={criterion.type} onChange={event => changeType(event.target.value)}>{TYPES.map(([type, title]) => <option value={type} key={type}>{title}</option>)}</select></div>
    <div className="flex flex-wrap gap-5">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={criterion.required} onChange={event => onChange({ required: event.target.checked })} />Response required</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(criterion.commentsRequired)} onChange={event => onChange({ commentsRequired: event.target.checked })} />Comment required</label>
    </div>
    {scored(criterion.type) ? <>
      <div className="grid md:grid-cols-3 gap-3">{[['min', 'Minimum'], ['max', 'Maximum'], ['weight', 'Weight (%)']].map(([key, title]) => <div className="awards-field" key={key}><Label htmlFor={`${id}-${key}`}>{title}</Label><Input id={`${id}-${key}`} type="number" step="any" required value={criterion[key] ?? ''} onChange={event => onChange({ [key]: event.target.value })} /></div>)}</div>
      {criterion.type === 'rating' && <fieldset className="border-t pt-4 space-y-3"><legend className="text-sm font-medium">Mapped rating options</legend><p className="awards-help">Use unique option keys and numeric values within the criterion range. Between 2 and 100 options are required.</p>
        {options.map((option, position) => <fieldset key={position} className="rounded-md border p-3"><legend className="px-1 text-xs">Option {position + 1}</legend>
          <div className="grid md:grid-cols-2 gap-3"><div className="awards-field"><Label htmlFor={`${id}-option-${position}-key`}>Option key</Label><Input id={`${id}-option-${position}-key`} required value={option.key} onChange={event => updateOption(position, { key: event.target.value })} /></div>
            <div className="awards-field"><Label htmlFor={`${id}-option-${position}-value`}>Mapped score</Label><Input id={`${id}-option-${position}-value`} type="number" step="any" required value={option.value} onChange={event => updateOption(position, { value: event.target.value })} /></div></div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Button type="button" size="sm" variant="outline" aria-label={`Move option ${position + 1} up in criterion ${index + 1}`} disabled={position === 0} onClick={() => onChange({ options: move(options, position, -1) })}>Move up</Button>
            <Button type="button" size="sm" variant="outline" aria-label={`Move option ${position + 1} down in criterion ${index + 1}`} disabled={position === options.length - 1} onClick={() => onChange({ options: move(options, position, 1) })}>Move down</Button>
            <Button type="button" size="sm" variant="outline" aria-label={`Remove option ${position + 1} from criterion ${index + 1}`} onClick={() => onChange({ options: options.filter((_, optionIndex) => optionIndex !== position) })}>Remove option</Button>
          </div>
        </fieldset>)}
        <Button type="button" variant="outline" size="sm" disabled={options.length >= 100} onClick={() => onChange({ options: [...options, { key: '', value: '' }] })}>Add rating option</Button>
      </fieldset>}
    </> : criterion.type !== 'text' ? <div className="awards-field"><Label htmlFor={`${id}-effect`}>Negative response effect</Label><select id={`${id}-effect`} className="awards-select" value={criterion.effect || ''} onChange={event => onChange({ effect: event.target.value })}><option value="" disabled>Select effect</option><option value="informational">Informational only</option><option value="qualification">Qualification flag</option><option value="review">Review flag</option></select><p className="awards-help">Binary responses do not contribute numeric weight.</p></div>
      : <p className="awards-help">Text responses do not contribute numeric weight.</p>}
  </fieldset>;
}
