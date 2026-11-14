import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Copy, Plus, ShieldCheck, Trophy } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useMemberAccess } from '@/hooks/useMemberAccess';
import { useFormAlertTenant } from '@/hooks/useFormAlerts';
import { listAwards, awardCommand } from '@/lib/awardsApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import AwardEditor from './AwardEditor';
import AwardReviewReopening from './AwardReviewReopening';
import RoundConfiguration from './RoundConfiguration';
import ApplicationReview from './ApplicationReview';
import ProgrammeManager from './ProgrammeManager';
import { useAwardProgrammes } from './useAwardProgrammes';
import DecisionWorkspace from './DecisionWorkspace';
import ReportingPanel from './ReportingPanel';
import AuditHistory from './AuditHistory';
import CertificateAdmin from './CertificateAdmin';
import CommunicationsPanel from './CommunicationsPanel';
import './awards.css';

export default function Awards() {
  const access = useMemberAccess();
  const tenant = useFormAlertTenant('awards.management');
  if (!access.isAccessReady || tenant.status === 'loading') return <div className="p-6 space-y-4" aria-label="Checking awards access"><Skeleton className="h-20 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (access.isFeatureExcluded('awards.management')) return <div className="p-6"><Card><CardContent className="p-8"><h1 className="text-xl font-semibold">Awards management is not available</h1><p className="text-sm text-slate-600 mt-2">Your role does not include access to competition configuration.</p></CardContent></Card></div>;
  if (tenant.status !== 'ready') return <div role="alert" className="p-6"><Card><CardContent className="p-8"><h1 className="text-xl font-semibold">Unable to verify your session</h1><p className="mt-2 text-sm text-slate-600">{tenant.error}</p><Button className="mt-4" variant="outline" onClick={() => window.location.reload()}>Reload page</Button></CardContent></Card></div>;
  return <AwardsWorkspace key={tenant.scopeKey} tenant={tenant} canEdit={!access.isFeatureExcluded('awards.management.configure')} canAssign={!access.isFeatureExcluded('awards.management.assign')} canReviewApplications={!access.isFeatureExcluded('awards.management.applications')} canModerate={!access.isFeatureExcluded('awards.management.moderate')} canApprove={!access.isFeatureExcluded('awards.management.approve')} canPublish={!access.isFeatureExcluded('awards.management.publish')} canCommunicate={!access.isFeatureExcluded('awards.management.communicate')} canReport={!access.isFeatureExcluded('awards.management.report')} canCertificates={!access.isFeatureExcluded('awards.management.certificates')} />;
}

function AwardsWorkspace({ tenant, canEdit, canAssign, canReviewApplications, canModerate, canApprove, canPublish, canCommunicate, canReport, canCertificates }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [roundDirty, setRoundDirty] = useState(false);
  const [roundBusy, setRoundBusy] = useState(false);
  const [applicationDirty, setApplicationDirty] = useState(false);
  const [applicationBusy, setApplicationBusy] = useState(false);
  const [programmeDirty, setProgrammeDirty] = useState(false);
  const [programmeBusy, setProgrammeBusy] = useState(false);
  const [decisionDirty, setDecisionDirty] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [certificateDirty, setCertificateDirty] = useState(false);
  const [certificateBusy, setCertificateBusy] = useState(false);
  const [communicationDirty, setCommunicationDirty] = useState(false);
  const [communicationBusy, setCommunicationBusy] = useState(false);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [duplicateSource, setDuplicateSource] = useState(null);
  const [duplicateName, setDuplicateName] = useState('');
  const [duplicateError, setDuplicateError] = useState('');
  const [editorRevision, setEditorRevision] = useState(0);
  const [reloadError, setReloadError] = useState('');
  const pending = useRef(false);
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const workspaceBusy = busy || reviewBusy;
  const programmesQuery = useAwardProgrammes(tenant);
  useEffect(() => {
    if (!duplicateSource || !duplicateName) return undefined;
    const unload = event => { event.preventDefault(); event.returnValue = ''; };
    const links = event => {
      if (event.target.closest?.('a[href]') && !window.confirm('Discard the unsaved duplicate name?')) event.preventDefault();
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', links, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', links, true); };
  }, [duplicateSource, duplicateName]);
  const queryKey = ['awards-configuration', tenant.scopeKey, page];
  const awardsQuery = useQuery({
    queryKey,
    queryFn: async () => { tenant.assertCurrent(); const result = await listAwards(page); tenant.assertCurrent(); return result; },
    refetchOnWindowFocus: false,
  });
  const formsQuery = useQuery({
    queryKey: ['awards-configuration-forms', tenant.scopeKey],
    enabled: canEdit && !creating && selection?.state === 'draft',
    queryFn: async () => { tenant.assertCurrent(); const result = await base44.entities.Form.listAll(); tenant.assertCurrent(); return result; },
    refetchOnWindowFocus: false,
  });
  const confirmLeave = () => !(reviewBusy || roundBusy || applicationBusy || programmeBusy || decisionBusy || certificateBusy || communicationBusy) && (!(dirty || reviewDirty || roundDirty || applicationDirty || programmeDirty || decisionDirty || certificateDirty || communicationDirty) || window.confirm('Discard unsaved competition, review-reopening, round, application, programme, decision, certificate or communication changes? Unconfirmed writes may have committed; leaving does not undo them or cancel queued mail.'));
  const reloadSelection = async () => {
    if (workspaceBusy || roundBusy || (dirty && !window.confirm('Discard unsaved competition changes? Round edits will be retained.'))) return;
    setReloadError('');
    setBusy(true);
    try {
      tenant.assertCurrent();
      const result = await awardsQuery.refetch();
      tenant.assertCurrent();
      if (result.error) throw result.error;
      const fresh = result.data?.awards.find(item => item.id === selection?.id);
      if (!fresh) throw new Error('This competition is not on the current page. Select it again from the directory.');
      setSelection(fresh); setDirty(false); setEditorRevision(value => value + 1);
    } catch (error) { setReloadError(error.message); }
    finally { setBusy(false); }
  };
  const acceptReviewMetadata = fresh => {
    tenant.assertCurrent();
    const current = selectionRef.current;
    if (!current || fresh?.id !== current.id || fresh.tenant_id !== tenant.tenantId || typeof fresh.name !== 'string'
      || !Number.isSafeInteger(fresh.version) || fresh.version < current.version || typeof fresh.state !== 'string') {
      throw new Error('Current award metadata could not be verified, changed scope, or is older than the last confirmed version.');
    }
    // Lifecycle SQL returns the award row, whereas the list also projects the
    // active immutable form binding. Do not erase those derived saved fields.
    const bindingProjected = Object.hasOwn(fresh, 'form_id') && Array.isArray(fresh.review_field_ids);
    const next = { ...current, ...fresh,
      form_id: bindingProjected ? fresh.form_id : current.form_id,
      review_field_ids: bindingProjected ? fresh.review_field_ids : current.review_field_ids };
    queryClient.setQueriesData({ queryKey: ['awards-configuration', tenant.scopeKey] }, old => old ? {
      ...old, awards: old.awards.map(item => item.id === next.id ? { ...item, ...next } : item),
    } : old);
    setSelection(next);
    // Do NOT change editorRevision, dirty flags, form choices, or any sibling
    // workspace keys: metadata reconciliation is not a draft reload.
    return next;
  };
  const refreshReviewMetadata = async () => {
    if (!canEdit || pending.current || !selectionRef.current) throw new Error('Wait for other award writes before reconciling review metadata.');
    const id = selectionRef.current.id, seen = new Set();
    let total;
    for (let nextPage = 1; nextPage <= 100000; nextPage += 1) {
      tenant.assertCurrent();
      const result = await listAwards(nextPage); tenant.assertCurrent();
      if (selectionRef.current?.id !== id) throw new Error('The selected award changed. Nothing was applied to another competition.');
      if (!Array.isArray(result.awards) || result.page !== nextPage || result.pageSize !== 50 || !Number.isSafeInteger(result.total) || result.total < 0
        || (total !== undefined && total !== result.total)
        || result.awards.length !== Math.min(50, Math.max(0, result.total - (nextPage - 1) * 50))) throw new Error('The directory changed while locating current award metadata. Re-read explicitly; local drafts are retained.');
      total = result.total;
      for (const row of result.awards) {
        if (!row?.id || seen.has(row.id)) throw new Error('Duplicate or incomplete directory metadata. Re-read before any further confirmation.');
        seen.add(row.id);
      }
      const fresh = result.awards.find(row => row.id === id);
      if (fresh) return acceptReviewMetadata(fresh);
      if (seen.size >= total) break;
    }
    throw new Error('The selected award is no longer available in the authorised directory. No metadata or drafts were replaced.');
  };
  const command = async (name, award, payload) => {
    if (pending.current || reviewBusy) throw new Error('An award write or review reconciliation is already in progress.');
    if (!canEdit) throw new Error('Your role cannot configure competitions.');
    tenant.assertCurrent();
    pending.current = true; setBusy(true);
    try {
      const result = await awardCommand(name, award, payload);
      tenant.assertCurrent();
      queryClient.setQueriesData({ queryKey: ['awards-configuration', tenant.scopeKey] }, old => old ? {
        ...old, awards: old.awards.map(item => item.id === result.id ? result : item),
      } : old);
      setSelection(result); setCreating(false);
      if (name === 'create' || name === 'configure' || name === 'duplicate') setDirty(false);
      if (name === 'duplicate') { setPage(1); setRoundDirty(false); setApplicationDirty(false); }
      if (name === 'create' || name === 'duplicate') {
        queryClient.invalidateQueries({ queryKey: ['awards-configuration', tenant.scopeKey] });
      }
      return result;
    } finally { pending.current = false; setBusy(false); }
  };
  const awards = awardsQuery.data?.awards || [];
  const { total = 0, pageSize = 1 } = awardsQuery.data || {};
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const changePage = next => { if (!workspaceBusy && confirmLeave()) { setDirty(false); setSelection(null); setCreating(false); setPage(next); setReloadError(''); } };
  return <div className="awards-workspace min-h-[100dvh] p-4 md:p-8">
    <div className="max-w-7xl mx-auto space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="awards-kicker mb-2">Awards administration</p><h1 className="text-3xl font-bold tracking-tight">Competitions</h1><p className="text-sm text-slate-600 mt-2 max-w-xl">Configure each award’s intake, application window and evidence retention.</p></div>
        {canEdit && <Button disabled={workspaceBusy || certificateBusy || communicationBusy} onClick={() => { if (creating || !confirmLeave()) return; setDirty(false); setSelection(null); setCreating(true); setReloadError(''); }}><Plus className="h-4 w-4 mr-2" />New competition</Button>}
      </header>
      <div className="awards-intro px-5 py-4 flex items-start gap-3">
        <ShieldCheck className="h-5 w-5 shrink-0 mt-0.5" /><div><h2 className="text-sm font-semibold">Separate competitions. Preserved evidence.</h2><p className="awards-help mt-1">Configure in draft, then explicitly open applications. These competitions are separate from member award badges.</p></div>
      </div>
      <ProgrammeManager tenant={tenant} canEdit={canEdit} programmesQuery={programmesQuery} onDirtyChange={setProgrammeDirty} onBusyChange={setProgrammeBusy} />
      <div className="grid md:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.8fr)] gap-6 items-start">
        <Card className="overflow-hidden shadow-sm">
          <div className="px-5 py-4 border-b flex justify-between gap-2 items-center"><h2 className="font-semibold text-sm">Competition directory</h2>{awardsQuery.data && <span className="text-xs text-slate-500">{total} total</span>}</div>
          {awardsQuery.isLoading ? <div className="p-5 space-y-5" aria-label="Loading competitions">{[1, 2, 3, 4].map(item => <div key={item} className="space-y-2"><Skeleton className="h-5 w-3/4" /><Skeleton className="h-3 w-1/2" /></div>)}</div>
            : awardsQuery.isError ? <div role="alert" className="p-5"><p className="font-medium text-sm">Unable to load competitions</p><p className="text-sm text-red-700 mt-2">{awardsQuery.error.message}</p><Button variant="outline" className="mt-4" onClick={() => awardsQuery.refetch()}>Try again</Button></div>
              : !awards.length ? <div className="p-8 text-center"><Trophy className="h-7 w-7 mx-auto mb-4 text-slate-400" /><h3 className="font-semibold text-sm">{page === 1 ? 'No competitions yet' : 'No competitions on this page'}</h3><p className="awards-help mt-2">{page === 1 ? canEdit ? 'Create a draft to begin configuring your first competition.' : 'Competitions will appear here when an administrator creates one.' : 'Return to the previous page to browse competitions.'}</p></div>
                : <nav aria-label="Competitions">{awards.map(award => <button type="button" key={award.id} disabled={workspaceBusy} className="awards-choice disabled:opacity-60" aria-pressed={selection?.id === award.id && !creating} onClick={() => { if (selection?.id === award.id && !creating) return; if (confirmLeave()) { setDirty(false); setSelection(award); setCreating(false); setReloadError(''); } }}>
                  <span className="flex items-start justify-between gap-3"><span className="font-medium text-sm break-words min-w-0">{award.name}</span><span className="awards-status" data-state={award.state}>{award.state.replaceAll('_', ' ')}</span></span>
                  <span className="block text-xs text-slate-500 mt-2">{award.cycle || 'No cycle specified'} · {award.timezone}</span>
                </button>)}</nav>}
          {awardsQuery.data && <div className="p-4 flex justify-between gap-2 items-center"><Button size="icon" variant="outline" aria-label="Previous page" disabled={workspaceBusy || page <= 1} onClick={() => changePage(page - 1)}><ChevronLeft className="w-4 h-4" /></Button><span className="text-xs text-slate-500">Page {page} of {pages}</span><Button size="icon" variant="outline" aria-label="Next page" disabled={workspaceBusy || page >= pages} onClick={() => changePage(page + 1)}><ChevronRight className="w-4 h-4" /></Button></div>}
        </Card>
        <div className="min-w-0">
          {selection && !creating && <div className="flex flex-wrap justify-end gap-2 mb-2">{canEdit && <Button size="sm" variant="outline" disabled={workspaceBusy || roundBusy || applicationBusy || programmeBusy || decisionBusy || certificateBusy || communicationBusy} onClick={() => {
            if (!confirmLeave()) return;
            setDuplicateSource(selection); setDuplicateName(''); setDuplicateError('');
          }}><Copy className="h-4 w-4 mr-2" />Duplicate configuration</Button>}<Button size="sm" variant="outline" disabled={workspaceBusy} onClick={reloadSelection}>Reload competition</Button></div>}
          {reloadError && <p role="alert" className="text-sm text-red-700 mb-3">{reloadError}</p>}
          {creating || selection ? <AwardEditor key={creating ? 'new' : `${selection.id}-${editorRevision}`} award={selection} creating={creating} canEdit={canEdit} busy={workspaceBusy} onCommand={command} formsQuery={formsQuery} programmesQuery={programmesQuery} onDirtyChange={setDirty} onCancel={() => { setDirty(false); setCreating(false); }} />
            : <Card className="shadow-sm"><CardContent className="py-20 px-8 text-center"><div className="rounded-full bg-slate-50 w-14 h-14 flex items-center justify-center mx-auto mb-5"><Trophy className="h-6 w-6 text-slate-500" /></div><h2 className="text-lg font-semibold">Choose a competition</h2><p className="awards-help max-w-sm mx-auto mt-2">Select an award to review its saved configuration{canEdit ? ', or create a new competition to set up an application window.' : '.'}</p></CardContent></Card>}
          {selection && !creating && canEdit && <AwardReviewReopening award={selection} tenant={tenant} canEdit={canEdit}
            disabled={busy || roundBusy || applicationBusy || programmeBusy || decisionBusy || certificateBusy || communicationBusy}
            onMetadataChanged={acceptReviewMetadata} refreshMetadata={refreshReviewMetadata} onDirtyChange={setReviewDirty} onBusyChange={setReviewBusy} />}
          {selection && !creating && (canEdit || canAssign || canReviewApplications || canModerate || canApprove || canPublish || canCommunicate || canReport) && <RoundConfiguration key={selection.id} award={selection} tenant={tenant} canEdit={canEdit} canAssign={canAssign} onDirtyChange={setRoundDirty} onBusyChange={setRoundBusy} />}
          {selection && !creating && (canReviewApplications || canModerate || canApprove) && <ApplicationReview key={selection.id} award={selection} tenant={tenant} canManageApplications={canReviewApplications} canModerate={canModerate} canApprove={canApprove} onDirtyChange={setApplicationDirty} onBusyChange={setApplicationBusy} />}
          {selection && !creating && (canApprove || canPublish || canCommunicate || canEdit) && <DecisionWorkspace key={selection.id} award={selection} tenant={tenant} canApprove={canApprove} canPublish={canPublish} canCommunicate={canCommunicate} canEdit={canEdit} onDirtyChange={setDecisionDirty} onBusyChange={setDecisionBusy} />}
          {selection && !creating && canReport && <ReportingPanel key={selection.id} award={selection} tenant={tenant} canReport={canReport} />}
          {selection && !creating && canReport && <AuditHistory key={selection.id} award={selection} tenant={tenant} canReport={canReport} />}
          {selection && !creating && canCertificates && <CertificateAdmin key={selection.id} award={selection} tenant={tenant} onDirtyChange={setCertificateDirty} onBusyChange={setCertificateBusy} additionalNavigationDirty={communicationDirty} additionalNavigationBusy={communicationBusy} />}
          {selection && !creating && canCommunicate && <CommunicationsPanel key={selection.id} award={selection} tenant={tenant} onDirtyChange={setCommunicationDirty} onBusyChange={setCommunicationBusy} navigationManaged={canCertificates} />}
        </div>
      </div>
      <Dialog open={Boolean(duplicateSource)} onOpenChange={open => {
        if (!open && !busy && (!duplicateName || window.confirm('Discard the unsaved duplicate name?'))) { setDuplicateSource(null); setDuplicateName(''); setDuplicateError(''); }
      }}>
        <DialogContent className="awards-workspace"><DialogHeader><DialogTitle>Duplicate saved configuration</DialogTitle><DialogDescription>Copy “{duplicateSource?.name}” into a new draft. Unsaved edits are not copied.</DialogDescription></DialogHeader>
          <div className="rounded-lg border bg-slate-50 p-4 text-sm space-y-2"><p>Copies configuration, the bound form and review-field allowlist, and each round’s latest criteria.</p><p>Does not copy applicants, judges, assessments, results or publications. Programme, dates and cycle are not carried over.</p></div>
          <form className="space-y-4" onSubmit={async event => {
            event.preventDefault(); if (busy || !duplicateSource || !duplicateName.trim()) return;
            setDuplicateError('');
            try {
              await command('duplicate', duplicateSource, { name: duplicateName.trim() });
              setDuplicateSource(null); setDuplicateName('');
            } catch (error) { setDuplicateError(error.message || 'Unable to duplicate configuration.'); }
          }}>
            <div className="awards-field"><Label htmlFor="award-duplicate-name">New competition name (required)</Label><Input id="award-duplicate-name" required value={duplicateName} disabled={busy || !canEdit} onChange={event => setDuplicateName(event.target.value)} /></div>
            {duplicateError && <p role="alert" className="text-sm text-red-800">{duplicateError} The name is retained. If the connection failed, check the competition directory before retrying to avoid creating another copy.</p>}
            <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { if (!duplicateName || window.confirm('Discard the unsaved duplicate name?')) { setDuplicateSource(null); setDuplicateName(''); setDuplicateError(''); } }}>Cancel</Button><Button type="submit" disabled={busy || !canEdit || !duplicateName.trim()}>{busy ? 'Creating copy…' : 'Create draft copy'}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  </div>;
}
