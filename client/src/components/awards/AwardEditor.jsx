import React, { useEffect, useRef, useState } from 'react';
import { Archive, ArrowRight, FileText, LockKeyhole, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import TimezoneSelect from '@/components/TimezoneSelect';
import { TimezoneAwareDateTimeInput } from '@/components/events/TimezoneAwareDateTimeInput';
import { isProgrammeArchived } from './useAwardProgrammes';

const TARGETS = {
  draft: ['open', 'Open applications', 'Opening locks configuration. The server verifies the form, application window and retention policy.'],
  open: ['closed', 'Close applications', 'Closing stops applications. Competition stages move forwards only; intake cannot be reopened here.'],
  closed: ['judging', 'Move competition to judging', 'Start judging on at least one configured round first. The server checks that a round is judging; this competition-stage change does not start any round.'],
  judging: ['moderation', 'Move competition to moderation', 'All rounds must first be in moderation or closed with their required completed assessment counts. The server checks readiness; individual rounds are not moved automatically.'],
  moderation: ['shortlisting', 'Move competition to shortlisting', 'Every round must be in moderation or closed, with required assessments and mandatory approved moderation complete. This changes the competition stage; it does not record or confirm shortlist decisions.'],
  shortlisting: ['results_approved', 'Mark results approved', 'Close all rounds and approve the current outcome for every eligible application first. The server also requires at least one approved outcome. This stage change does not approve individual outcomes or publish results.'],
  results_approved: ['completed', 'Complete competition', 'The server rechecks closed rounds and approved current outcomes. Completion does not publish results, authorise recipient communications or send mail.'],
  completed: ['archived', 'Archive competition', 'Archiving preserves historical evidence. It does not delete personal information or trigger retention disposal.'],
};
const REVIEW_TYPES = new Set(['text', 'textarea', 'email', 'number', 'tel', 'date', 'time', 'country', 'percentage', 'currency', 'boolean', 'select', 'radio', 'url', 'checkbox', 'countries', 'file']);

function editable(award) {
  return {
    programme_id: award?.programme_id || null,
    name: award?.name || '', description: award?.description || '', cycle: award?.cycle || '',
    timezone: award?.timezone || 'UTC', opens_at: award?.opens_at || '', closes_at: award?.closes_at || '',
    eligibility_information: award?.eligibility_information || '', amendments_enabled: Boolean(award?.amendments_enabled),
    retention_policy: {
      retention_days: award?.retention_policy?.retention_days ?? '',
      disposal_authority: award?.retention_policy?.disposal_authority || '',
      legal_hold_policy: award?.retention_policy?.legal_hold_policy || '',
    },
  };
}

export default function AwardEditor({ award, creating, canEdit, busy, onCommand, formsQuery, programmesQuery, onCancel, onDirtyChange }) {
  const [draft, setDraft] = useState(() => editable(award));
  const [snapshot, setSnapshot] = useState(() => JSON.stringify(editable(award)));
  const [dateState, setDateState] = useState({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [formId, setFormId] = useState('');
  const [reviewFieldIds, setReviewFieldIds] = useState([]);
  const [transition, setTransition] = useState(false);
  const [reason, setReason] = useState('');
  const transitionPending = useRef(false);
  const [transitionBase, setTransitionBase] = useState(null);
  const [transitionBlocked, setTransitionBlocked] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = JSON.stringify(draft) !== snapshot || Object.values(dateState).some(value => value?.localValue !== undefined);
  const bindingDirty = Boolean(formId);
  const transitionDirty = Boolean(reason);
  useEffect(() => { onDirtyChange(dirty || bindingDirty || transitionDirty); }, [dirty, bindingDirty, transitionDirty, onDirtyChange]);
  const dirtyRef = useRef(dirty || bindingDirty || transitionDirty);
  dirtyRef.current = dirty || bindingDirty || transitionDirty;
  useEffect(() => {
    const unload = event => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    const followLink = event => {
      if (dirtyRef.current && event.target.closest?.('a[href]') && !window.confirm('Discard unsaved competition changes?')) event.preventDefault();
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', followLink, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', followLink, true); };
  }, []);
  const locked = !canEdit || (!creating && award.state !== 'draft');
  const patch = (field, value) => { setDraft(old => ({ ...old, [field]: value })); setSaved(''); };
  const retention = (field, value) => setDraft(old => ({ ...old, retention_policy: { ...old.retention_policy, [field]: value } }));
  const execute = async (command, payload, message) => {
    setError(''); setSaved('');
    try {
      const result = await onCommand(command, award, payload);
      if (mounted.current) { setSaved(message); }
      return result;
    } catch (failure) {
      if (mounted.current) setError(failure.message || 'Unable to save. Please try again.');
      return null;
    }
  };
  const save = async event => {
    event.preventDefault();
    if (locked || busy) return;
    if (!draft.name.trim()) { setError('Enter a competition name.'); return; }
    if (draft.programme_id !== (award?.programme_id || null)) {
      if (!programmesQuery?.isSuccess) { setError('Load the complete programme list before changing the programme. Your saved association is unchanged.'); return; }
      if (draft.programme_id && !programmesQuery.data.some(programme => programme.id === draft.programme_id && !isProgrammeArchived(programme))) {
        setError('The selected programme is no longer available for new associations. Choose an active programme or no programme.'); return;
      }
    }
    let payload = { name: draft.name.trim(), description: draft.description, cycle: draft.cycle, timezone: draft.timezone, programme_id: draft.programme_id };
    if (!creating) {
      if (Object.values(dateState).some(value => value?.error)) { setError('Resolve the highlighted local times before saving.'); return; }
      if (draft.opens_at && draft.closes_at && new Date(draft.closes_at) <= new Date(draft.opens_at)) {
        setError('The closing deadline must be after the opening time.'); return;
      }
      const days = draft.retention_policy.retention_days;
      const hasPolicy = days !== '' || draft.retention_policy.disposal_authority.trim() || draft.retention_policy.legal_hold_policy.trim();
      if (hasPolicy && (!Number.isSafeInteger(Number(days)) || Number(days) <= 0
        || !draft.retention_policy.disposal_authority.trim() || !draft.retention_policy.legal_hold_policy.trim())) {
        setError('Complete all retention fields, including a positive whole number of days.'); return;
      }
      payload = { ...draft, ...payload, opens_at: draft.opens_at || null, closes_at: draft.closes_at || null,
        retention_policy: hasPolicy ? { ...draft.retention_policy, retention_days: Number(days) } : {} };
    }
    const result = await execute(creating ? 'create' : 'configure', payload, creating ? 'Draft created.' : 'Configuration saved.');
    if (result && mounted.current) {
      const next = editable(result); setDraft(next); setSnapshot(JSON.stringify(next)); setDateState({});
    }
  };
  const target = !creating && TARGETS[award.state];
  const forms = formsQuery.data || [];
  const programmes = programmesQuery?.isSuccess ? programmesQuery.data || [] : [];
  const visibleProgrammes = programmes.filter(programme => !isProgrammeArchived(programme) || programme.id === award?.programme_id);
  const programmeMissing = draft.programme_id && !visibleProgrammes.some(programme => programme.id === draft.programme_id);
  const selectedForm = forms.find(form => String(form.id) === formId);
  const formFields = Array.isArray(selectedForm?.fields) ? selectedForm.fields : [];
  const reviewFields = formFields.filter(field => field.id && REVIEW_TYPES.has(field.type));
  const unsupportedCount = formFields.length - reviewFields.length;
  const savedReviewCount = Array.isArray(award?.review_field_ids) ? award.review_field_ids.length : 0;
  const cancel = () => { if (!(dirty || bindingDirty || transitionDirty) || window.confirm('Discard unsaved competition changes and any retained stage-change reason?')) onCancel(); };
  return <Card className="min-w-0 shadow-sm">
    <CardHeader className="border-b">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="awards-kicker mb-2">{creating ? 'New competition' : 'Competition configuration'}</p>
          <CardTitle className="text-xl break-words">{creating ? 'Start with the essentials' : award.name}</CardTitle></div>
        {!creating && <span className="awards-status" data-state={award.state}>{award.state.replaceAll('_', ' ')}</span>}
      </div>
      <p className="awards-help">{creating ? 'Create a draft, then configure intake, eligibility and retention.' : `Version ${award.version} · ${award.cycle || 'No cycle specified'}`}</p>
    </CardHeader>
    <CardContent className="pt-6">
      {locked && <div className="flex gap-3 rounded-lg bg-slate-50 p-4 mb-6 text-sm text-slate-600"><LockKeyhole className="h-4 w-4 shrink-0 mt-0.5" />
        <p>{!canEdit ? 'You have read-only access to competition configuration.' : 'Configuration and form binding are locked outside draft.'}</p></div>}
      <form onSubmit={save}>
        <fieldset disabled={locked || busy}>
          <section className="awards-section">
            <h3>Competition details</h3><p className="awards-help mb-5">The name and cycle distinguish this competition from other awards.</p>
            <div className="space-y-4">
              <div className="awards-field"><Label htmlFor="award-name">Competition name <span aria-hidden="true">*</span></Label><Input id="award-name" required value={draft.name} onChange={e => patch('name', e.target.value)} /></div>
              <div className="awards-field"><Label htmlFor="award-cycle">Cycle</Label><Input id="award-cycle" value={draft.cycle} onChange={e => patch('cycle', e.target.value)} /></div>
              <div className="awards-field"><Label htmlFor="award-programme">Programme (optional)</Label>
                <select id="award-programme" className="awards-select" value={draft.programme_id || ''} disabled={!programmesQuery?.isSuccess} onChange={event => patch('programme_id', event.target.value || null)} aria-describedby="award-programme-help">
                  <option value="">No programme</option>
                  {programmeMissing && <option value={draft.programme_id} disabled={draft.programme_id !== award?.programme_id}>{draft.programme_id === award?.programme_id ? `Saved programme (${draft.programme_id})` : 'Unavailable selection — choose again'}</option>}
                  {visibleProgrammes.map(programme => <option value={programme.id} key={programme.id}>{programme.name}{isProgrammeArchived(programme) ? ' · Archived (saved association)' : ''}</option>)}
                </select>
                <p id="award-programme-help" className="awards-help">{programmesQuery?.isLoading ? 'Loading all programmes…' : programmeMissing && draft.programme_id === award?.programme_id ? 'The saved programme is not in the available list. Its ID is retained unless you explicitly choose another programme or no programme.' : 'Group this competition under a programme, or leave it ungrouped. Only saved archived associations are shown.'}</p>
                {(!programmesQuery || programmesQuery.isError) && <div role="alert" className="text-sm text-red-800">{programmesQuery?.error?.message || 'The programme list is unavailable.'} The saved programme has not been cleared.<Button type="button" variant="outline" size="sm" className="mt-2 block" onClick={() => programmesQuery?.refetch()}>Retry full programme list</Button></div>}
              </div>
              <div className="awards-field"><Label htmlFor="award-description">Description</Label><Textarea id="award-description" rows={3} value={draft.description} onChange={e => patch('description', e.target.value)} /></div>
              <div className="awards-field"><Label htmlFor="award-timezone">Competition timezone</Label><TimezoneSelect id="award-timezone" value={draft.timezone} onChange={value => { patch('timezone', value); setDateState({}); }} /></div>
            </div>
          </section>
          {!creating && <>
            <section className="awards-section">
              <h3>Application window</h3><p className="awards-help mb-5">Applications open at the opening instant and close at, not after, the deadline. All times below are in {draft.timezone}.</p>
              <div className="grid md:grid-cols-2 gap-4">
                {[['opens_at', 'Opens at'], ['closes_at', 'Closes at']].map(([field, label]) => <div key={field} className="awards-field">
                  <Label htmlFor={`award-${field}`}>{label} ({draft.timezone})</Label>
                  <TimezoneAwareDateTimeInput id={`award-${field}`} tz={draft.timezone} value={draft[field]} strict
                    pendingLocalValue={dateState[field]?.localValue}
                    onChange={(iso, meta) => { patch(field, iso); setDateState(old => ({ ...old, [field]: meta })); }} />
                </div>)}
              </div>
            </section>
            <section className="awards-section">
              <h3>Eligibility & amendments</h3>
              <div className="awards-field mt-4"><Label htmlFor="award-eligibility">Eligibility information</Label><Textarea id="award-eligibility" rows={5} value={draft.eligibility_information} onChange={e => patch('eligibility_information', e.target.value)} /></div>
              <label className="flex items-start gap-3 mt-5 cursor-pointer"><input type="checkbox" className="mt-1" checked={draft.amendments_enabled} onChange={e => patch('amendments_enabled', e.target.checked)} />
                <span className="text-sm"><span className="font-medium block">Permit applicant amendments</span><span className="awards-help">Allow amendments before the closing deadline.</span></span></label>
            </section>
            <section className="awards-section">
              <h3>Evidence retention</h3><p className="awards-help mb-5">Required before opening. Archiving retains evidence; it does not authorise deletion.</p>
              <div className="space-y-4">
                <div className="awards-field"><Label htmlFor="award-retention-days">Retention period (days)</Label><Input id="award-retention-days" type="number" min="1" step="1" value={draft.retention_policy.retention_days} onChange={e => retention('retention_days', e.target.value)} /></div>
                <div className="awards-field"><Label htmlFor="award-disposal">Permitted disposal authority</Label><Textarea id="award-disposal" value={draft.retention_policy.disposal_authority} onChange={e => retention('disposal_authority', e.target.value)} /></div>
                <div className="awards-field"><Label htmlFor="award-hold">Legal-hold policy</Label><Textarea id="award-hold" value={draft.retention_policy.legal_hold_policy} onChange={e => retention('legal_hold_policy', e.target.value)} /></div>
              </div>
            </section>
          </>}
        </fieldset>
        <div className="flex flex-wrap justify-between items-center gap-3 py-5">
          <span className="awards-help">{dirty ? 'Unsaved changes' : creating ? 'Not yet created' : 'Saved configuration'}</span>
          <div className="flex gap-2">{creating && <Button type="button" variant="outline" disabled={busy} onClick={cancel}>Cancel</Button>}
            {!locked && <Button type="submit" disabled={busy || (!creating && !dirty)}><Save className="w-4 h-4 mr-2" />{busy ? 'Saving…' : creating ? 'Create draft' : 'Save configuration'}</Button>}</div>
        </div>
      </form>
      {!creating && <section className="awards-section">
        <h3 className="flex items-center gap-2"><FileText className="h-4 w-4" />Application form</h3>
        <p className="awards-help mb-4">Bind an existing form while this competition is in draft. Shared forms will require an explicit award application link.</p>
        <p role="status" className="text-sm text-emerald-800 mb-4">{award.form_id
          ? `Saved application form: ${forms.find(form => form.id === award.form_id)?.name || 'Form selected'}`
          : 'No application form selected.'}</p>
        <p className="awards-help mb-4">Saved judge-visible fields: {savedReviewCount}. Only explicitly selected fields are included in the immutable review-field capture.</p>
        {!locked && <>
          {formsQuery.isLoading ? <Skeleton className="h-10 w-full" /> : formsQuery.isError ?
            <div role="alert" className="text-sm text-red-700">{formsQuery.error.message}<Button type="button" variant="outline" size="sm" className="ml-3" onClick={() => formsQuery.refetch()}>Retry forms</Button></div>
            : !forms.length ? <p className="awards-help rounded-lg border p-4">No forms are available. Create a form in FormBuilder, then refresh this list.<Button type="button" variant="outline" size="sm" className="mt-3 block" onClick={() => formsQuery.refetch()}>Refresh forms</Button></p>
              : <div className="space-y-3"><Label htmlFor="award-form">Existing form</Label><select id="award-form" className="awards-select" disabled={busy} value={formId} onChange={e => { setFormId(e.target.value); setReviewFieldIds([]); setSaved(''); }}><option value="">Choose a form</option>{forms.map(form => <option key={form.id} value={form.id}>{form.name || form.title || 'Untitled form'}</option>)}</select>
                {formId && <fieldset disabled={busy} className="rounded-lg border p-4 space-y-3">
                  <legend className="px-1 text-sm font-semibold">Fields visible to judges</legend>
                  <p className="awards-help">Nothing is selected by default. Select only the fields judges should be allowed to see; binding with no fields is permitted.</p>
                  {reviewFields.map(field => <label key={field.id} className="flex items-start gap-3 text-sm">
                    <input type="checkbox" className="mt-1" checked={reviewFieldIds.includes(field.id)} onChange={event => setReviewFieldIds(old => event.target.checked ? [...old, field.id] : old.filter(id => id !== field.id))} />
                    <span className="break-words">{field.label || 'Unlabelled field'} <span className="text-xs text-slate-500">({field.type})</span></span>
                  </label>)}
                  {!reviewFields.length && <p className="awards-help">This form has no fields currently supported for review.</p>}
                  <p className="awards-help">{unsupportedCount ? `${unsupportedCount} unsupported ${unsupportedCount === 1 ? 'field is' : 'fields are'} omitted. ` : ''}Due-diligence and unsupported composite fields cannot currently be included.</p>
                  <p className="text-sm font-medium" role="status">{reviewFieldIds.length} selected · Unsaved binding choice</p>
                </fieldset>}
                <Button type="button" variant="outline" disabled={busy || dirty || !formId} onClick={async () => {
                  if (!window.confirm('Bind this form? Any previous active form binding will be replaced.')) return;
                  const allowedIds = new Set(reviewFields.map(field => field.id));
                  const result = await execute('bind_form', { form_id: formId, review_field_ids: reviewFieldIds.filter(id => allowedIds.has(id)) }, 'Application form and review-field selection bound.');
                  if (result && mounted.current) { setFormId(''); setReviewFieldIds([]); }
                }}>Bind selected form</Button></div>}
          {dirty && <p className="awards-help mt-2">Save configuration changes before binding a form.</p>}
        </>}
      </section>}
      {!creating && canEdit && target && <section className="pt-6">
        <h3 className="font-semibold mb-2">Change competition state</h3>
        <p className="awards-help mb-4">{target[2]} No transition automatically publishes results or sends messages.</p>
        <Button type="button" variant="outline" disabled={busy || dirty || bindingDirty || transitionBlocked} onClick={() => {
          if (!reason || !transitionBase) setTransitionBase({ state: award.state, version: award.version, target });
          setTransition(true);
        }}>
          {target[0] === 'archived' ? <Archive className="h-4 w-4 mr-2" /> : <ArrowRight className="h-4 w-4 mr-2" />}{target[1]}
        </Button>{(dirty || bindingDirty) && <p className="awards-help mt-2">Save configuration and bind the selected form, or clear the form selection, before changing state.</p>}
        {reason && !transition && <div className="mt-3 space-y-2"><p className="awards-help">Your unsaved stage-change reason is retained. Reopen the action to review it; closing the dialog did not submit anything.</p>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { if (window.confirm('Discard the retained competition-stage reason? This does not undo any server action.')) { setReason(''); setTransitionBase(null); } }}>Discard retained stage reason</Button>
        </div>}
      </section>}
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 text-red-800 p-4 text-sm mt-5">{error}<p className="mt-1">Your edits are retained. If the version changed, reload the competition before retrying.</p></div>}
      {saved && <p role="status" className="text-sm text-emerald-800 mt-4">{saved}</p>}
      <Dialog open={transition} onOpenChange={value => { if (!busy && !transitionPending.current) setTransition(value); }}>
        <DialogContent><DialogHeader><DialogTitle>{transitionBase?.target[1]}</DialogTitle><DialogDescription>{transitionBase?.target[2]} This changes the competition stage only. It does not publish results or send messages.</DialogDescription></DialogHeader>
          <p className="awards-help">Expected state {transitionBase?.state} · version {transitionBase?.version}. Ordinary competition-stage changes move forwards only. Finalised review reopening uses the separate versioned review control.</p>
          <Label htmlFor="award-transition-reason">Reason (required)</Label><Textarea id="award-transition-reason" required maxLength={20000} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} />
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          {(transitionBlocked || (transitionBase && (transitionBase.version !== award.version || transitionBase.state !== award.state))) && <p role="alert" className="text-sm">Reconciliation is required. Your reason is retained. Reload the competition using its existing reload control before another stage change; no action is retried automatically.</p>}
          <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setTransition(false)}>Close (keep reason)</Button><Button disabled={busy || !reason.trim() || reason.length > 20000 || !canEdit || dirty || bindingDirty || transitionBlocked || !transitionBase || transitionBase.version !== award.version || transitionBase.state !== award.state} onClick={async () => {
            if (transitionPending.current || busy || !canEdit || !transitionBase || transitionBlocked || !reason.trim()
              || transitionBase.version !== award.version || transitionBase.state !== award.state || dirty || bindingDirty) return;
            transitionPending.current = true;
            try {
              const result = await execute('transition', { state: transitionBase.target[0], reason: reason.trim() }, 'Competition state updated. No results were published or messages sent.');
              if (!mounted.current) return;
              if (result?.state === transitionBase.target[0] && result.version > transitionBase.version) { setTransition(false); setReason(''); }
              else if (result) { setTransitionBlocked(true); setError('The server did not confirm the requested stage. Reload the competition before another action.'); }
            } finally { transitionPending.current = false; }
          }}>{busy ? 'Saving…' : 'Confirm change'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </CardContent>
  </Card>;
}
