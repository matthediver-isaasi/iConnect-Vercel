import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { roundAdminRequest } from './useRoundAdministration';

const roles = ['judge', 'chair', 'approver'];
const groups = [['proposers', 'Propose moderation', 'moderation_proposers', ['chair']], ['approvers', 'Approve / reopen moderation', 'moderation_approvers', ['approver']], ['discussion', 'Discuss / review panel evidence', 'moderation_discussion', ['chair', 'approver']]];
// Persisted rounds must carry their actual policy, not an invented default
// which could silently replace an existing grant. Defaults are for new data.
const policyOf = round => Object.fromEntries(groups.map(([key, , field, fallback]) => [key, round.id ? round[field] : round[field] ?? fallback]));
const signature = policy => JSON.stringify(Object.fromEntries(groups.map(([key]) => [key, [...policy[key]].sort()])));
const validPolicy = policy => groups.every(([key]) => Array.isArray(policy[key]) && policy[key].every(role => roles.includes(role)) && new Set(policy[key]).size === policy[key].length);

export default function RoundPanelPolicy({ round, tenant, disabled, onRoundChange, refreshRound, onDirtyChange, onBusyChange, onUncertainChange, onChanged }) {
  const [policy, setPolicy] = useState(() => policyOf(round));
  const [baseline, setBaseline] = useState(() => validPolicy(policyOf(round)) ? signature(policyOf(round)) : '');
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), alive = useRef(false), callbacks = useRef({});
  callbacks.current = { onRoundChange, refreshRound, onDirtyChange, onBusyChange, onUncertainChange, onChanged };
  const valid = validPolicy(policy), currentPolicy = policyOf(round);
  const currentValid = validPolicy(currentPolicy);
  const changed = valid && signature(policy) !== baseline;
  const external = !currentValid || signature(currentPolicy) !== baseline;
  const dirty = changed || !!reason || blocked;
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { callbacks.current.onUncertainChange(blocked); }, [blocked]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const reload = async () => {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const fresh = await callbacks.current.refreshRound(); tenant.assertCurrent();
      if (!validPolicy(policyOf(fresh))) throw new Error('The current server policy is unreadable. No role choices were overwritten.');
      if (!alive.current) return;
      setBaseline(signature(policyOf(fresh))); setBlocked(false);
      setNotice('Current round version/policy reloaded. Your checkbox choices and reason were retained. Compare them with saved roles below and explicitly confirm again.');
    } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="border-t mt-6 pt-5 space-y-4">
    <div className="flex flex-wrap justify-between gap-3"><div><p className="awards-kicker">Configure capability · draft round only</p><h3 className="font-semibold mt-1">Appointed panel policy</h3></div><Button type="button" variant="outline" size="sm" disabled={disabled || busy} onClick={reload}>Reload policy/version (keep choices)</Button></div>
    <p className="text-sm">These are explicit grants to accepted appointments, not administrator RBAC grants. Allowing judge discussion grants confidential panel review even when ordinary peer visibility is blind. Approvers may reopen moderation; separate-approver and self-approval checks remain server-enforced.</p>
    <p className="awards-help">Defaults: chair proposes; approver approves/reopens; chair and approver discuss. Role grants lock after judging starts. An empty group grants that action to no appointment role.</p>
    {!valid && <p role="alert" className="text-sm text-red-800">The policy contains unsupported role data. It cannot be saved.</p>}
    {round.state !== 'draft' && <p className="awards-help rounded-lg border p-4">Panel role policy is locked in {round.state}. Reopening a judging round does not unlock draft-only role changes.</p>}
    <form className="space-y-4" onSubmit={async event => {
      event.preventDefault();
      if (pending.current || disabled || round.state !== 'draft' || !valid || !changed || external || blocked || !reason.trim()) return;
      const payload = { roundId: round.id, version: round.version, ...policy, reason: reason.trim() };
      if (!window.confirm(`Save explicit panel grants at round version ${round.version}?\n${groups.map(([key, label]) => `${label}: ${policy[key].join(', ') || 'no appointment roles'}`).join('\n')}\nJudge discussion permits panel review independent of blind peer policy. Grants lock when judging starts.`)) return;
      pending.current = true; setBusy(true); setError(''); setNotice('');
      try {
        const result = await roundAdminRequest(tenant, '/api/awards/panel-policy', { body: payload });
        if (result.id !== round.id || result.state !== 'draft' || !Number.isSafeInteger(result.version) || result.version <= payload.version
          || !validPolicy(policyOf(result)) || signature(policyOf(result)) !== signature(policy)) throw new Error('The server did not confirm the exact panel policy/version. Reconcile before retrying.');
        if (!alive.current) return;
        callbacks.current.onRoundChange(result); callbacks.current.onChanged();
        setBaseline(signature(policy)); setReason(''); setBlocked(false); setNotice(`Panel policy confirmed at round version ${result.version}. No invitations, publications or messages were sent.`);
      } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
      finally { pending.current = false; if (alive.current) setBusy(false); }
    }}>
      <fieldset disabled={disabled || busy || round.state !== 'draft' || !valid} className="space-y-4">
        {groups.map(([key, label]) => <fieldset key={key} className="rounded-lg border p-4"><legend className="px-1 text-sm font-semibold">{label}</legend><div className="flex flex-wrap gap-5">{roles.map(role => <label key={role} className="flex gap-2 items-center text-sm"><input type="checkbox" checked={Array.isArray(policy[key]) && policy[key].includes(role)} onChange={event => setPolicy(old => ({ ...old, [key]: event.target.checked ? [...old[key], role] : old[key].filter(value => value !== role) }))} />{role}</label>)}</div><p className="awards-help mt-3">Current saved roles: {Array.isArray(currentPolicy[key]) ? currentPolicy[key].join(', ') || 'none' : 'unreadable'}</p></fieldset>)}
        <label className="block text-sm">Policy change reason (required)<Textarea required maxLength={20000} value={reason} onChange={event => setReason(event.target.value)} /></label>
      </fieldset>
      {(external || blocked) && <p role="alert" className="text-sm text-amber-900">Current policy/version needs reconciliation before saving. Reload metadata; your role choices and reason will remain. No automatic retry occurs.</p>}
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={disabled || busy || round.state !== 'draft' || !valid || !changed || external || blocked || !reason.trim()}>Confirm explicit panel grants…</Button><Button type="button" variant="outline" disabled={disabled || busy || blocked || !currentValid} onClick={() => { if (window.confirm('Discard unsaved panel role choices/reason and use the currently loaded server policy?')) { setPolicy(policyOf(round)); setBaseline(signature(policyOf(round))); setReason(''); setError(''); } }}>Use loaded server policy</Button></div>
    </form>
    {error && <p role="alert" className="text-sm text-red-800">{error} Unsaved choices and reason are retained.</p>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
  </section>;
}
