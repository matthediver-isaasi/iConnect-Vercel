import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { decisionRequest, decisionScore } from './useAwardDecisions';

const STATES = [['recommended', 'Record recommendations'], ['confirmed', 'Confirm recommended shortlist'], ['rejected', 'Reject existing selections'], ['reopened', 'Reopen existing selections']];
export default function ShortlistPanel({ awardId, roundId, rounds = [], roundsReady = false, canApprove = false, tenant, onDirtyChange, onBusyChange }) {
  const queryClient = useQueryClient();
  const epochKey = ['award-round-preview-epoch', tenant.scopeKey, roundId];
  const lifecycleEpoch = useQuery({ queryKey: epochKey, queryFn: () => 0, enabled: false, initialData: 0, staleTime: Infinity });
  const [mode, setMode] = useState('threshold');
  const [threshold, setThreshold] = useState('');
  const [limit, setLimit] = useState('');
  const [preview, setPreview] = useState(null);
  const [input, setInput] = useState(null);
  const [selected, setSelected] = useState([]);
  const [state, setState] = useState('recommended');
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [advanceSelections, setAdvanceSelections] = useState([]);
  const [advanceTarget, setAdvanceTarget] = useState('');
  const [advanceReason, setAdvanceReason] = useState('');
  const [advancePage, setAdvancePage] = useState(1);
  const pending = useRef(false), alive = useRef(true), callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const livePreview = useRef(preview);
  livePreview.current = preview;
  const dirty = Boolean(selected.length || reason || override || threshold || limit || mode !== 'threshold' || advanceSelections.length || advanceTarget || advanceReason);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  useEffect(() => {
    if (livePreview.current) { setStale(true); setNotice('The round lifecycle may have changed. Refresh the shortlist preview before recording or advancing. Your selections and reasons are retained.'); }
  }, [lifecycleEpoch.data]);
  const loadPreview = async parameters => {
    const expectedEpoch = queryClient.getQueryData(epochKey) || 0;
    const result = await decisionRequest(tenant, '/api/awards/shortlist', { command: 'preview', roundId, ...parameters });
    if ((queryClient.getQueryData(epochKey) || 0) !== expectedEpoch) throw new Error('The round lifecycle changed while the preview was loading. Generate a fresh preview; inputs are retained.');
    if (!Array.isArray(result.entries) || !result.fingerprints || !Array.isArray(result.recommendation?.recommended) || !Array.isArray(result.recommendation?.tied)) throw new Error('The server did not return a complete shortlist preview.');
    if (alive.current) { setPreview(result); setInput(parameters); setStale(false); }
    return result;
  };
  const refresh = async () => {
    if (pending.current || !input) return;
    pending.current = true; setBusy(true); setError('');
    try { await loadPreview(input); } catch (failure) { if (alive.current) { setError(failure.message); setStale(true); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const entries = preview?.entries || [];
  const chosen = entries.filter(entry => selected.includes(entry.id));
  const selectable = entry => entry.eligibility === 'eligible' && (!entry.moderationRequired || entry.moderationState === 'approved');
  const exceptional = chosen.some(entry => input?.mode === 'manual' || !entry.complete || !preview.recommendation.recommended.includes(entry.id));
  const validTransition = chosen.length === selected.length && chosen.every(entry => state === 'confirmed' ? entry.shortlist?.state === 'recommended'
    : state === 'recommended' ? !entry.shortlist || ['reopened', 'rejected'].includes(entry.shortlist.state) : Boolean(entry.shortlist));
  const pages = Math.max(1, Math.ceil(entries.length / 10));
  const roundReady = ['judging', 'moderation', 'closed'].includes(preview?.round?.state);
  const sourceRound = rounds.find(item => item.id === roundId && item.award_id === awardId);
  const orderedSource = roundsReady && Number.isSafeInteger(sourceRound?.position);
  const targets = orderedSource ? rounds.filter(item => item.award_id === awardId && item.state === 'draft' && Number.isSafeInteger(item.position) && item.position > sourceRound.position) : [];
  const targetRound = targets.find(item => item.id === advanceTarget);
  const confirmed = entries.filter(entry => entry.shortlist?.state === 'confirmed' && entry.shortlist.id);
  const advancePages = Math.max(1, Math.ceil(confirmed.length / 10));
  const validAdvanceSelection = advanceSelections.length > 0 && advanceSelections.length <= 500 && advanceSelections.every(selection => {
    const entry = entries.find(item => item.id === selection.applicationId);
    return entry?.eligibility === 'eligible' && entry.shortlist?.state === 'confirmed' && entry.shortlist.id === selection.shortlistDecisionId;
  });
  return <section className="space-y-5">
    <div><h3 className="font-semibold">Shortlist decisions</h3><p className="awards-help mt-2">A preview is evidence, not a decision. Record recommendations first, then explicitly confirm them from refreshed evidence. Ties are never resolved automatically.</p></div>
    <form className="rounded-lg border p-4 space-y-4" onSubmit={async event => {
      event.preventDefault(); if (pending.current) return;
      const cap = limit === '' ? null : Number(limit);
      if (cap !== null && (!Number.isSafeInteger(cap) || cap < 1)) { setError('Enter a positive whole-number limit or leave it blank.'); return; }
      if (mode === 'top_ranked' && cap === null) { setError('Top-ranked selection requires an explicit limit.'); return; }
      if (!/^\d{1,3}(?:\.\d{1,12})?$/.test(threshold) || Number(threshold) > 100) { setError('Enter an explicit threshold from 0 to 100, including 0 if no score cutoff applies.'); return; }
      pending.current = true; setBusy(true); setError(''); setNotice('');
      try { await loadPreview({ mode, threshold, limit: cap }); setPage(1); }
      catch (failure) { if (alive.current) setError(failure.message); }
      finally { pending.current = false; if (alive.current) setBusy(false); }
    }}>
      <fieldset disabled={busy || Boolean(preview)} className="space-y-4">
        <div className="awards-field"><Label htmlFor="shortlist-mode">Selection mode</Label><select id="shortlist-mode" className="awards-select" value={mode} onChange={event => setMode(event.target.value)}><option value="threshold">Score threshold</option><option value="top_ranked">Top ranked</option><option value="manual">Manual selection</option><option value="threshold_approval">Threshold with explicit approval</option></select></div>
        <div className="grid md:grid-cols-2 gap-4"><div className="awards-field"><Label htmlFor="shortlist-threshold">Threshold (0–100)</Label><Input id="shortlist-threshold" type="number" min="0" max="100" step="any" required value={threshold} onChange={event => setThreshold(event.target.value)} /></div><div className="awards-field"><Label htmlFor="shortlist-limit">Maximum entries {mode === 'top_ranked' ? '(required)' : '(optional)'}</Label><Input id="shortlist-limit" type="number" min="1" step="1" value={limit} onChange={event => setLimit(event.target.value)} /></div></div>
        <Button type="submit">Generate shortlist preview</Button>
      </fieldset>
      {preview && <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} onClick={refresh}>Refresh preview (keep inputs)</Button><Button type="button" variant="outline" disabled={busy} onClick={() => {
        if ((selected.length || reason || override || advanceSelections.length || advanceReason || advanceTarget) && !window.confirm('Discard unsaved shortlist and advancement choices and change preview parameters?')) return;
        setPreview(null); setInput(null); setSelected([]); setReason(''); setOverride(false); setError(''); setStale(false);
        setAdvanceSelections([]); setAdvanceTarget(''); setAdvanceReason(''); setAdvancePage(1);
      }}>Change preview parameters</Button></div>}
    </form>
    {preview && <>
      {stale && <p role="alert" className="text-sm text-amber-800">This preview is not confirmed current. Refresh it before recording another decision.</p>}
      {preview.recommendation.tied.length > 0 && <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{preview.recommendation.tied.length} entries are tied at a decision boundary. None is automatically selected; a reasoned authorised decision is required.</p>}
      {preview.recommendation.requiresDecision && <p className="awards-help">The server requires an explicit selection decision for this mode.</p>}
      {!roundReady && <p className="text-sm text-amber-800">This round is {preview.round?.state || 'unavailable'}. Shortlist writes require a judging, moderation or closed round.</p>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy || stale || preview.recommendation.recommended.length > 500} onClick={() => setSelected([...preview.recommendation.recommended])}>Select server recommendations ({preview.recommendation.recommended.length})</Button><Button variant="outline" size="sm" disabled={busy || !selected.length} onClick={() => { setSelected([]); setOverride(false); }}>Clear selected entries</Button></div>
      {entries.length ? <ul className="divide-y rounded-lg border">{entries.slice((Math.min(page, pages) - 1) * 10, Math.min(page, pages) * 10).map(entry => <li key={entry.id} className="p-4">
        <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" disabled={busy || stale || !selectable(entry) || (selected.length >= 500 && !selected.includes(entry.id))} checked={selected.includes(entry.id)} onChange={event => { const checked = event.target.checked; setSelected(old => checked ? [...old, entry.id] : old.filter(id => id !== entry.id)); }} />
          <span className="min-w-0"><span className="font-medium text-sm break-words block">{entry.reference || entry.id} · {decisionScore(entry.officialScore)}</span><span className="awards-help block mt-1">{entry.eligibility} · {entry.complete ? 'Complete' : 'Incomplete'} · {entry.completed} / {entry.required} assessments</span>
            {entry.discrepancy && <span className="block text-sm text-amber-800">Score discrepancy flagged</span>}{preview.recommendation.tied.includes(entry.id) && <span className="block text-sm text-amber-800">Tied — explicit decision required</span>}
            {entry.moderationRequired && entry.moderationState !== 'approved' && <span className="block awards-help">Required moderation is not approved; selection is unavailable.</span>}
            {entry.shortlist && <span className="block awards-help mt-1">Recorded shortlist: {entry.shortlist.state} · revision {entry.shortlist.revision} · {entry.shortlist.reason}</span>}
          </span></label>
      </li>)}</ul> : <p className="rounded-lg border p-5 awards-help">No applications were returned for this round.</p>}
      {pages > 1 && <div className="flex justify-between items-center gap-2"><Button size="sm" variant="outline" disabled={busy || page <= 1} onClick={() => setPage(value => value - 1)}>Previous entries</Button><span className="awards-help">{Math.min(page, pages)} / {pages}</span><Button size="sm" variant="outline" disabled={busy || page >= pages} onClick={() => setPage(value => value + 1)}>Next entries</Button></div>}
      <form className="space-y-4 border-t pt-5" onSubmit={async event => {
        event.preventDefault();
        if (pending.current || stale || !roundReady || !selected.length || !validTransition || !reason.trim() || (['recommended', 'confirmed'].includes(state) && exceptional && !override)) return;
        if (!window.confirm(`${STATES.find(item => item[0] === state)[1]} for ${selected.length} explicitly selected applications? This records a shortlist revision only; no outcome, publication or delivery follows automatically.`)) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        try {
          const result = await decisionRequest(tenant, '/api/awards/shortlist', { command: 'record', roundId, ...input, applicationIds: [...selected], state, override, reason: reason.trim(), fingerprints: preview.fingerprints });
          if (!Array.isArray(result.decision_ids) || result.decision_ids.length !== selected.length || new Set(result.decision_ids).size !== selected.length) throw new Error('The server did not confirm all requested shortlist revisions. Refresh before retrying.');
          if (!alive.current) return;
          setSelected([]); setReason(''); setOverride(false); setNotice('Shortlist decision recorded. Refreshing evidence; no further decision has been made.');
          setStale(true); await loadPreview(input);
        } catch (failure) { if (alive.current) { setError(failure.message); setStale(true); } }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      }}>
        <fieldset disabled={busy || stale || !roundReady} className="space-y-4">
          <p className="awards-help">{selected.length} selected (maximum 500).</p>
          <div className="awards-field"><Label htmlFor="shortlist-state">Separate decision action</Label><select id="shortlist-state" className="awards-select" value={state} onChange={event => setState(event.target.value)}>{STATES.map(([value, title]) => <option value={value} key={value}>{title}</option>)}</select></div>
          {!validTransition && selected.length > 0 && <p className="text-sm text-amber-800">Selected entries do not all permit this transition. Recommend before confirming; reopen recorded selections before recommending replacements.</p>}
          {exceptional && ['recommended', 'confirmed'].includes(state) && <p className="awards-help">Manual, tied, incomplete or non-recommended selections require an explicit override and a reason. A missing score is never treated as zero.</p>}
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={override} onChange={event => setOverride(event.target.checked)} /><span>I explicitly authorise a reasoned selection override.</span></label>
          <div className="awards-field"><Label htmlFor="shortlist-reason">Decision reason (required)</Label><Textarea id="shortlist-reason" required maxLength={20000} rows={4} value={reason} onChange={event => setReason(event.target.value)} /></div>
          <Button type="submit" disabled={!selected.length || !validTransition || !reason.trim() || (['recommended', 'confirmed'].includes(state) && exceptional && !override)}>{STATES.find(item => item[0] === state)[1]}…</Button>
        </fieldset>
      </form>
      {canApprove && <form className="rounded-lg border p-4 space-y-4" onSubmit={async event => {
        event.preventDefault();
        if (pending.current || stale || !orderedSource || !targetRound || !validAdvanceSelection || !advanceReason.trim()) return;
        if (!window.confirm(`Advance ${advanceSelections.length} explicitly selected confirmed applications from ${sourceRound.name} to ${targetRound.name}? This records target-round entries only. It does not allocate judges, start judging or change the selected source round.`)) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        try {
          const result = await decisionRequest(tenant, '/api/awards/advance', {
            sourceRoundId: roundId, targetRoundId: targetRound.id,
            selections: advanceSelections.map(selection => ({ ...selection })), reason: advanceReason.trim(),
          });
          if (!Array.isArray(result.entry_ids) || result.entry_ids.some(id => typeof id !== 'string' || !id) || result.entry_ids.length !== advanceSelections.length || new Set(result.entry_ids).size !== result.entry_ids.length) throw new Error('The server did not confirm all target-round entries. Refresh the source preview before retrying.');
          if (!alive.current) return;
          const count = result.entry_ids.length;
          setAdvanceSelections([]); setAdvanceTarget(''); setAdvanceReason('');
          setNotice(`Backend confirmed ${count} target-round ${count === 1 ? 'entry' : 'entries'} in ${targetRound.name}. This count can include entries already advanced from the same confirmed decision. The source round remains selected.`);
          setStale(true); await loadPreview(input);
        } catch (failure) { if (alive.current) { setError(failure.message); setStale(true); } }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      }}>
        <div><h3 className="font-semibold">Advance confirmed selections</h3><p className="awards-help mt-2">Select current confirmed shortlist decisions explicitly. Only later draft rounds in this award are offered; advancement does not allocate judges or start judging.</p></div>
        {!orderedSource && <p role="alert" className="text-sm text-amber-800">The complete round list and source position must be available before advancement. Reload round choices above if needed.</p>}
        {orderedSource && !targets.length && <p className="awards-help">There are no later draft rounds in this award.</p>}
        <fieldset disabled={busy || stale || !orderedSource} className="space-y-4">
          <div className="awards-field"><Label htmlFor="advance-target-round">Later draft round</Label><select id="advance-target-round" className="awards-select" value={advanceTarget} onChange={event => setAdvanceTarget(event.target.value)}><option value="">Choose a later draft round</option>{advanceTarget && !targetRound && <option value={advanceTarget} disabled>Selected round is no longer a later draft ({advanceTarget})</option>}{targets.map(item => <option value={item.id} key={item.id}>{item.name} · position {item.position}</option>)}</select></div>
          {confirmed.length ? <ul className="divide-y rounded-lg border">{confirmed.slice((Math.min(advancePage, advancePages) - 1) * 10, Math.min(advancePage, advancePages) * 10).map(entry => {
            const selectedEvidence = advanceSelections.find(selection => selection.applicationId === entry.id);
            return <li key={entry.id} className="p-3"><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1"
              checked={Boolean(selectedEvidence)} disabled={entry.eligibility !== 'eligible' || (!selectedEvidence && advanceSelections.length >= 500)}
              onChange={event => { const checked = event.target.checked; setAdvanceSelections(old => checked ? [...old, { applicationId: entry.id, shortlistDecisionId: entry.shortlist.id }] : old.filter(selection => selection.applicationId !== entry.id)); }} />
              <span className="min-w-0"><span className="font-medium break-words">{entry.reference || entry.id}</span><span className="block awards-help">Confirmed shortlist revision {entry.shortlist.revision}{entry.eligibility !== 'eligible' ? ` · ${entry.eligibility} — cannot advance` : ''}</span>{selectedEvidence && selectedEvidence.shortlistDecisionId !== entry.shortlist.id && <span className="block text-amber-800">Selected evidence changed. Clear this selection and explicitly select the current confirmed decision.</span>}</span>
            </label></li>;
          })}</ul> : <p className="awards-help">No confirmed shortlist decisions are available in this preview. Recommendations must be confirmed separately before advancement.</p>}
          {advancePages > 1 && <div className="flex items-center justify-between gap-2"><Button type="button" variant="outline" size="sm" disabled={advancePage <= 1} onClick={() => setAdvancePage(value => value - 1)}>Previous confirmed entries</Button><span className="awards-help">{Math.min(advancePage, advancePages)} / {advancePages}</span><Button type="button" variant="outline" size="sm" disabled={advancePage >= advancePages} onClick={() => setAdvancePage(value => value + 1)}>Next confirmed entries</Button></div>}
          <div className="flex flex-wrap items-center gap-3"><span className="awards-help">{advanceSelections.length} selected (maximum 500).</span><Button type="button" size="sm" variant="outline" disabled={!advanceSelections.length} onClick={() => setAdvanceSelections([])}>Clear advancement selections</Button></div>
          {advanceSelections.length > 0 && !validAdvanceSelection && <p role="alert" className="text-sm text-amber-800">Some selected decisions are no longer current confirmed eligible selections. Clear them and explicitly select current evidence; decision IDs are never silently replaced.</p>}
          <div className="awards-field"><Label htmlFor="advance-round-reason">Advancement reason (required)</Label><Textarea id="advance-round-reason" required maxLength={20000} rows={3} value={advanceReason} onChange={event => setAdvanceReason(event.target.value)} /></div>
          <Button type="submit" disabled={!targetRound || !validAdvanceSelection || !advanceReason.trim()}>Confirm advancement…</Button>
        </fieldset>
      </form>}
    </>}
    {busy && <p role="status" className="awards-help">Processing shortlist evidence…</p>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {error && <div role="alert" className="text-sm text-red-800">{error}<p className="mt-1">Unsaved inputs are retained. A failed or ambiguous write is never automatically repeated.</p></div>}
  </section>;
}
