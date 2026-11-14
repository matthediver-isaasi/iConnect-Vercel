import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePopupUnsavedChanges } from '@/hooks/usePopupUnsavedChanges';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '@/components/ui/alert-dialog';
import { useOutcomeHistory } from './useAwardDecisions';
import { communicationKey, useCommunicationChoices, useCommunicationShortlists } from './useAwardCommunications';
import CommunicationSettings from './CommunicationSettings';
import CommunicationScheduler from './CommunicationScheduler';
import CommunicationHistory from './CommunicationHistory';

export default function CommunicationsPanel({ tenant, award, onDirtyChange, onBusyChange, navigationManaged = false }) {
  const queryClient = useQueryClient();
  const choicesQuery = useCommunicationChoices(tenant, award.id), outcomesQuery = useOutcomeHistory(award.id, tenant), shortlistsQuery = useCommunicationShortlists(tenant, award.id);
  const [settingsDirty, setSettingsDirty] = useState(false), [scheduleDirty, setScheduleDirty] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false), [scheduleBusy, setScheduleBusy] = useState(false);
  const [deliveryDirty, setDeliveryDirty] = useState(false), [deliveryBusy, setDeliveryBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const callbacks = useRef({ onDirtyChange, onBusyChange }), alive = useRef(true);
  callbacks.current = { onDirtyChange, onBusyChange };
  const dirty = settingsDirty || scheduleDirty || deliveryDirty, busy = settingsBusy || scheduleBusy || deliveryBusy;
  const guard = usePopupUnsavedChanges({ dirty: !navigationManaged && (dirty || busy), isDirty: () => !navigationManaged && (dirty || busy) });
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const ready = query => query.isSuccess && !query.isFetching && !query.isError;
  const audit = () => queryClient.invalidateQueries({ queryKey: ['award-audit-history', tenant.scopeKey, award.id] });
  const reloadSettings = async () => {
    const result = await choicesQuery.refetch();
    tenant.assertCurrent();
    if (result.error || !result.data) throw result.error || new Error('The complete communication choices could not be reloaded.');
    audit();
    return result.data;
  };
  const reconcile = async () => {
    const results = await Promise.all([choicesQuery.refetch(), outcomesQuery.refetch(), shortlistsQuery.refetch()]);
    tenant.assertCurrent();
    for (const result of results) if (result.error || !result.data) throw result.error || new Error('Communication authority choices could not be reloaded completely.');
    // Refresh active history and mark other cached pages stale. One page never
    // proves that an unconfirmed request was absent.
    await queryClient.invalidateQueries({ queryKey: [...communicationKey(tenant, award.id), 'history'] }, { throwOnError: true });
    tenant.assertCurrent();
    if (alive.current) setRefreshVersion(value => value + 1);
    audit();
  };
  return <Card className="mt-6 min-w-0 shadow-sm"><CardHeader className="border-b"><p className="awards-kicker">Communications</p><CardTitle className="text-xl">Authorised messages & delivery records</CardTitle></CardHeader><CardContent className="p-6 space-y-6">
    <p className="awards-help">Choose from the existing tenant Email Templates. Configuration, recipient release, scheduling and confirmed delivery are separate. No message body editor or second template directory is introduced here.</p>
    {choicesQuery.isPending && <div role="status" aria-label="Loading complete message choices"><Skeleton className="h-12 mb-3" /><Skeleton className="h-28" /></div>}
    {choicesQuery.isError && <div role="alert" className="space-y-3"><p className="text-sm text-red-700">{choicesQuery.error.message}</p><Button type="button" variant="outline" disabled={busy || choicesQuery.isFetching} onClick={() => choicesQuery.refetch()}>Retry complete message choices</Button></div>}
    {choicesQuery.data && <>
      <div className="flex flex-wrap items-center gap-3"><p className="awards-help">{choicesQuery.data.templates.length} active email templates · {choicesQuery.data.applications.length} application references · {choicesQuery.data.appointments.length} appointments · {choicesQuery.data.certificates.length} certificate issues</p><Button type="button" size="sm" variant="outline" disabled={busy || choicesQuery.isFetching} onClick={() => choicesQuery.refetch()}>Reload choices (keep drafts)</Button></div>
      <CommunicationSettings tenant={tenant} awardId={award.id} choices={choicesQuery.data} ready={ready(choicesQuery)} disabled={scheduleBusy || deliveryBusy}
        reload={reloadSettings} onDirtyChange={setSettingsDirty} onBusyChange={setSettingsBusy} />
      {outcomesQuery.isPending && <div role="status" aria-label="Loading approved outcome choices"><Skeleton className="h-12" /></div>}
      {outcomesQuery.isError && <div role="alert" className="space-y-2"><p className="text-sm text-red-700">Outcome-message choices are unavailable: {outcomesQuery.error.message}</p><Button type="button" size="sm" variant="outline" disabled={busy || outcomesQuery.isFetching} onClick={() => outcomesQuery.refetch()}>Retry complete outcome history</Button></div>}
      {shortlistsQuery.isPending && <div role="status" aria-label="Loading confirmed shortlist choices"><Skeleton className="h-12" /></div>}
      {shortlistsQuery.isError && <div role="alert" className="space-y-2"><p className="text-sm text-red-700">Shortlist-message choices are unavailable: {shortlistsQuery.error.message}</p><Button type="button" size="sm" variant="outline" disabled={busy || shortlistsQuery.isFetching} onClick={() => shortlistsQuery.refetch()}>Retry complete confirmed shortlist catalog</Button></div>}
      <CommunicationScheduler tenant={tenant} award={award} choices={choicesQuery.data} outcomes={outcomesQuery.data?.outcomes || []} shortlists={shortlistsQuery.data || []}
        ready={ready(choicesQuery)} outcomesReady={ready(outcomesQuery)} shortlistsReady={ready(shortlistsQuery)} disabled={settingsBusy || deliveryBusy}
        reconcile={reconcile} onScheduled={reconcile} onDirtyChange={setScheduleDirty} onBusyChange={setScheduleBusy} />
    </>}
    <CommunicationHistory refreshVersion={refreshVersion} tenant={tenant} award={award} choices={choicesQuery.data || { applications: [], appointments: [] }}
      disabled={settingsBusy || scheduleBusy} onDirtyChange={setDeliveryDirty} onBusyChange={setDeliveryBusy} />
    <AlertDialog open={!!guard.pending} onOpenChange={open => { if (!open) guard.stay(); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Leave communication choices?</AlertDialogTitle><AlertDialogDescription>{busy ? 'A request is still running. Stay until its confirmed outcome is available.' : 'Leaving discards local settings, automatic-policy choices, delivery-recovery actions/reasons, scheduling choices and in-memory retry identifiers. It does not undo saved configuration or an accepted delivery-control command, or cancel a message that may already be queued. Reconcile unconfirmed scheduling/control attempts before leaving.'}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><Button type="button" variant="outline" onClick={guard.stay}>Stay here</Button><Button type="button" variant="destructive" disabled={busy} onClick={guard.discard}>Discard local choices and leave</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </CardContent></Card>;
}
