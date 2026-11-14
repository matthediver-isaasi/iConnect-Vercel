import React, { useEffect, useRef, useState } from 'react';
import { usePopupUnsavedChanges } from '@/hooks/usePopupUnsavedChanges';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import ShortlistPanel from './ShortlistPanel';
import OutcomePanel from './OutcomePanel';
import PublicationPanel from './PublicationPanel';
import ShortlistPublicationPanel from './ShortlistPublicationPanel';
import { useDecisionRounds } from './useAwardDecisions';
import './awards.css';

export default function DecisionWorkspace(props) {
  return <Workspace key={`${props.tenant.scopeKey}:${props.award.id}`} {...props} />;
}

function Workspace({ award, tenant, canApprove, canPublish, canCommunicate, canEdit, onDirtyChange, onBusyChange }) {
  const rounds = useDecisionRounds(award.id, tenant);
  const tabs = [
    ...(canApprove ? [['shortlist', 'Shortlist']] : []),
    ...(canApprove || canEdit ? [['outcomes', 'Outcomes & categories']] : []),
    ...(canPublish || canCommunicate ? [['publication', 'Publication & release']] : []),
    ...(canPublish || canCommunicate ? [['shortlist-publication', 'Shortlist visibility & release']] : []),
  ];
  const [tab, setTab] = useState(() => tabs[0]?.[0] || '');
  const [roundId, setRoundId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [contextRevision, setContextRevision] = useState(0);
  const callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const guard = usePopupUnsavedChanges({ dirty: dirty || busy });
  useEffect(() => { callbacks.current.onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange?.(busy); }, [busy]);
  useEffect(() => () => { callbacks.current.onDirtyChange?.(false); callbacks.current.onBusyChange?.(false); }, []);
  const leave = () => !busy && (!dirty || window.confirm('Discard unsaved decision, publication or release inputs?'));
  const activeTab = tabs.some(([id]) => id === tab) ? tab : tabs[0]?.[0];
  const round = rounds.data?.find(item => item.id === roundId);
  if (!tabs.length) return null;
  return <Card className="mt-6 min-w-0 shadow-sm">
    <CardHeader className="border-b"><p className="awards-kicker mb-2">Reasoned decisions & release authority</p><CardTitle className="text-xl">Decisions workspace</CardTitle><p className="awards-help">Shortlist recommendations, confirmed selections, outcome approval, audience publication and recipient release are independent actions. There is no automatic hand-off.</p></CardHeader>
    <CardContent className="pt-5 space-y-5">
      {!['publication', 'shortlist-publication'].includes(activeTab) && <div className="rounded-lg border p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><Label htmlFor="award-decision-round">Decision round (shortlist & outcome decisions)</Label><Button size="sm" variant="outline" disabled={busy || rounds.isFetching} onClick={() => {
          if (!leave()) return;
          setRoundId(''); setContextRevision(value => value + 1); setDirty(false); rounds.refetch();
        }}>Reload round choices</Button></div>
        {rounds.isLoading ? <Skeleton className="h-10 w-full" /> : rounds.isError ? <p role="alert" className="text-sm text-red-800">{rounds.error.message} Retry using “Reload round choices”.</p>
          : <select id="award-decision-round" className="awards-select" value={roundId} disabled={busy} onChange={event => { if (leave()) { setRoundId(event.target.value); setDirty(false); } }}><option value="">Choose a round</option>{roundId && !round && <option value={roundId} disabled>Selected round is no longer available ({roundId})</option>}{rounds.data?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.state}</option>)}</select>}
        {rounds.isSuccess && !rounds.data?.length && <p className="awards-help">No assessment rounds have been configured. Categories and existing publication records remain accessible below.</p>}
        <p className="awards-help">Publication and recipient release use current approved outcomes across this award, not an inferred round selection.</p>
      </div>}
      <div className="flex flex-wrap gap-2 border-b pb-4" role="group" aria-label="Decision workspace sections">{tabs.map(([id, label]) => <Button key={id} variant={activeTab === id ? 'default' : 'outline'} size="sm" disabled={busy} aria-pressed={activeTab === id} onClick={() => { if (id !== activeTab && leave()) { setTab(id); setDirty(false); } }}>{label}</Button>)}</div>
      {activeTab === 'shortlist' && (round ? <ShortlistPanel key={`${award.id}:${roundId}:${contextRevision}`} awardId={award.id} roundId={roundId} rounds={rounds.data || []} roundsReady={rounds.isSuccess && !rounds.isFetching} canApprove={canApprove} tenant={tenant} onDirtyChange={setDirty} onBusyChange={setBusy} /> : <p className="awards-help rounded-lg border p-5">Select an available round to preview its current shortlist evidence.</p>)}
      {activeTab === 'outcomes' && <OutcomePanel key={`${award.id}:${roundId}:${contextRevision}`} awardId={award.id} roundId={round?.id || null} tenant={tenant} canApprove={canApprove} canEdit={canEdit} onDirtyChange={setDirty} onBusyChange={setBusy} />}
      {activeTab === 'publication' && <PublicationPanel awardId={award.id} tenant={tenant} canPublish={canPublish} canCommunicate={canCommunicate} onDirtyChange={setDirty} onBusyChange={setBusy} />}
      {activeTab === 'shortlist-publication' && <ShortlistPublicationPanel award={award} tenant={tenant} canPublish={canPublish} canCommunicate={canCommunicate} onDirtyChange={setDirty} onBusyChange={setBusy} />}
      <Dialog open={Boolean(guard.pending)} onOpenChange={open => { if (!open) guard.stay(); }}>
        <DialogContent className="awards-workspace"><DialogHeader><DialogTitle>{busy ? 'Decision request in progress' : 'Leave unsaved decision inputs?'}</DialogTitle><DialogDescription>{busy ? 'Wait for the server response before leaving. No further action is automatically triggered.' : 'Unsaved decision reasons, selections or publication text will be discarded. Stay here to review or record the action explicitly.'}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={guard.stay}>Stay here</Button><Button disabled={busy} onClick={guard.discard}>Discard and leave</Button></DialogFooter></DialogContent>
      </Dialog>
    </CardContent>
  </Card>;
}
