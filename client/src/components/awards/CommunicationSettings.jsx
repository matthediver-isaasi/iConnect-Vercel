import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import CommunicationAutomation from './CommunicationAutomation';
import { communicationRequest, communicationKey, communicationConfigurationDto, validCommunicationConfiguration, automaticMessageCategories, messageLabel } from './useAwardCommunications';

const flag = (set, category, value) => set(old => old[category] === value ? old : { ...old, [category]: value });

export default function CommunicationSettings({ tenant, awardId, choices, ready, disabled, reload, onDirtyChange, onBusyChange }) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState({}), [settingsBusy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
  const [automaticDirty, setAutomaticDirty] = useState({}), [automaticBusy, setAutomaticBusy] = useState({}), [automaticBlocked, setAutomaticBlocked] = useState({});
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(true), callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const dirty = Object.keys(drafts).length > 0 || Object.values(automaticDirty).some(Boolean);
  const busy = settingsBusy || Object.values(automaticBusy).some(Boolean);
  const automaticUncertain = Object.values(automaticBlocked).some(Boolean);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const initial = category => {
    const row = choices.configurations.find(item => item.category === category);
    return { templateId: row?.email_template_id || '', enabled: row?.enabled ?? true, version: row?.version || 0 };
  };
  const edit = (category, key, value) => setDrafts(old => ({ ...old, [category]: { ...(old[category] || initial(category)), [key]: value } }));
  const patchConfirmedConfiguration = row => {
    tenant.assertCurrent();
    const saved = communicationConfigurationDto(row);
    queryClient.setQueryData([...communicationKey(tenant, awardId), 'choices'], old => old ? {
      ...old, configurations: [...old.configurations.filter(item => item.category !== saved.category), saved],
    } : old);
  };
  const save = async category => {
    // Initial built-in/enabled defaults still require an explicit saved row
    // before any automatic policy may be configured.
    const draft = drafts[category] || (initial(category).version === 0 ? initial(category) : null);
    if (pending.current || busy || !ready || disabled || blocked || automaticUncertain || !draft || draft.version !== initial(category).version) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    let confirmed = false;
    try {
      const result = await communicationRequest(tenant, '/api/awards/communications', { body: { command: 'configure', awardId, category, templateId: draft.templateId || null, enabled: draft.enabled, version: draft.version } });
      const saved = result.configuration;
      if (!validCommunicationConfiguration(saved) || saved.category !== category || saved.version !== draft.version + 1 || saved.enabled !== draft.enabled
        || (saved.email_template_id || null) !== (draft.templateId || null)) throw new Error('The server did not confirm the requested configuration version.');
      confirmed = true;
      if (!alive.current) return;
      patchConfirmedConfiguration(saved);
      setDrafts(old => { const next = { ...old }; delete next[category]; return next; });
      setNotice(`Saved ${messageLabel(category)} configuration, version ${saved.version}. This is not evidence of queueing or delivery; any saved automatic worker policy remains separate.`);
      await reload();
    } catch (failure) { if (alive.current) { setBlocked(true); setError(confirmed ? `Settings were saved, but refreshing failed. Reconcile before another write. ${failure.message}` : `${failure.message} Drafts are retained. Reload and explicitly reconcile expected versions before retrying; the write may already have succeeded.`); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="space-y-4"><h3 className="font-semibold">Category settings</h3>
    <p className="awards-help">Use the tenant’s existing active Email Templates, or the safe built-in message. Template bodies are not edited here. Built-in winner and unsuccessful messages both describe the authorised released outcome neutrally; these category names do not determine a result.</p>
    <p className="awards-help">Without an explicit configuration, the backend uses its enabled built-in default. Disabling a category prevents dispatch when the worker rechecks its current settings.</p>
    <p className="awards-help">Automatic creation is OFF by default and requires a separately saved ordinary configuration, reason and explicit policy confirmation. It is supported only for application receipt/deadline, judge invitation reminders, judging deadline, incomplete assessments and moderation invitations. Outcome/certificate categories remain release-controlled and manually scheduled.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{notice && <p role="status" className="awards-help">{notice}</p>}
    {blocked && <Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={async () => { if (pending.current) return; pending.current = true; setBusy(true); try { await reload(); tenant.assertCurrent(); if (alive.current) { setBlocked(false); setNotice('Current settings reloaded. Draft selections and their expected versions remain unchanged. Rebase each changed category explicitly after reviewing its saved settings.'); } } catch (failure) { if (alive.current) setError(failure.message); } finally { pending.current = false; if (alive.current) setBusy(false); } }}>Reconcile settings (keep drafts)</Button>}
    <div className="divide-y">{choices.categories.map(category => {
      const saved = initial(category), draft = drafts[category], value = draft || saved;
      const stale = draft && draft.version !== saved.version;
      const unavailable = !!value.templateId && !choices.templates.some(item => item.id === value.templateId);
      return <details key={category} className="py-4"><summary className="cursor-pointer text-sm font-semibold">{messageLabel(category)} <span className="awards-help ml-2">{saved.enabled ? 'Enabled' : 'Disabled'} · saved version {saved.version}{draft ? ' · unsaved choice' : ''}</span></summary>
        <fieldset className="mt-4 space-y-3" disabled={busy || disabled || !ready || automaticUncertain}>
          <label className="block text-sm">Message source<select className="awards-select mt-1" value={value.templateId} onChange={e => edit(category, 'templateId', e.target.value)}><option value="">Safe built-in message</option>
            {unavailable && <option value={value.templateId} disabled>Saved/selected template {value.templateId} is not in the active catalog</option>}
            {choices.templates.map(item => <option value={item.id} key={item.id}>{item.subject || '(Untitled subject)'} · {item.id}</option>)}</select></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enabled} onChange={e => edit(category, 'enabled', e.target.checked)} />Enable message delivery for this category (separate from automatic creation)</label>
          {unavailable && <p className="awards-help">The saved template is not silently cleared. Choose an active template or explicitly choose the built-in message before saving.</p>}
          {stale && <div role="alert" className="space-y-2 text-sm"><p>Saved version changed from {draft.version} to {saved.version}. Your draft is unchanged.</p><Button type="button" size="sm" variant="outline" onClick={() => { if (window.confirm(`Keep your draft choices but use saved version ${saved.version} as the expected version?`)) setDrafts(old => ({ ...old, [category]: { ...old[category], version: saved.version } })); }}>Use current expected version</Button></div>}
          {category === 'judge_invitation' && <p className="awards-help">Configure its message here; sending/resending an invitation remains the appointment invitation action in Rounds. The scheduler never creates judge invitations.</p>}
          <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={(!draft && saved.version > 0) || blocked || stale || unavailable} onClick={() => save(category)}>{saved.version ? 'Save category settings' : 'Save initial category settings'}</Button>{draft && <Button type="button" size="sm" variant="outline" onClick={() => { if (window.confirm('Discard this unsaved category choice? Saved configuration is not changed.')) setDrafts(old => { const next = { ...old }; delete next[category]; return next; }); }}>Discard category draft</Button>}</div>
        </fieldset>
        {automaticMessageCategories.includes(category) ? <CommunicationAutomation tenant={tenant} awardId={awardId} category={category}
          configuration={choices.configurations.find(row => row.category === category)} ordinaryDirty={!!draft} ready={ready}
          disabled={disabled || settingsBusy || blocked || Object.entries(automaticBusy).some(([key, value]) => key !== category && value)
            || Object.entries(automaticBlocked).some(([key, value]) => key !== category && value)}
          reload={reload} onConfirmed={patchConfirmedConfiguration}
          onDirtyChange={value => flag(setAutomaticDirty, category, value)} onBusyChange={value => flag(setAutomaticBusy, category, value)}
          onUncertainChange={value => flag(setAutomaticBlocked, category, value)} />
          : <p className="awards-help mt-4">{category === 'judge_invitation' ? 'No automatic creation policy: invitations are explicitly queued/resend through Rounds.' : 'No automatic creation policy: this message remains subject to separate release authority and explicit manual scheduling.'}</p>}
      </details>;
    })}</div>
    <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-semibold">Supported Email Template placeholders</summary><ul className="mt-3 flex flex-wrap gap-2">{choices.placeholderKeys.map(key => <li className="rounded border px-2 py-1 text-xs" key={key}><code>{`{{${key}}}`}</code></li>)}</ul><p className="awards-help mt-3">Only these keys are supported. The existing Email Templates directory owns subject/body content; incompatible templates can fail the worker’s validation.</p></details>
  </section>;
}
