import { useEffect, useRef, useState } from 'react';
import { usePopupUnsavedChanges } from '@/hooks/usePopupUnsavedChanges';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '@/components/ui/alert-dialog';
import CertificateTemplateEditor from './CertificateTemplateEditor';
import CertificateIssuance from './CertificateIssuance';
import CertificateLinkRevocation from './CertificateLinkRevocation';
import { certificateRequest, downloadCertificate, useAwardCertificateLibrary, useCertificateOutcomes } from './useAwardCertificates';

export default function CertificateAdmin({ tenant, award, onDirtyChange, onBusyChange, additionalNavigationDirty = false, additionalNavigationBusy = false }) {
  const library = useAwardCertificateLibrary(tenant, award.id), outcomes = useCertificateOutcomes(tenant, award.id);
  const [templateDirty, setTemplateDirty] = useState(false), [issueDirty, setIssueDirty] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false), [issueBusy, setIssueBusy] = useState(false);
  const [linksIssueId, setLinksIssueId] = useState(''), [linksDirty, setLinksDirty] = useState(false), [linksBusy, setLinksBusy] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false), [sourceError, setSourceError] = useState(''), [historyPage, setHistoryPage] = useState(1);
  const callbacks = useRef({ onDirtyChange, onBusyChange }), alive = useRef(true), sourcePending = useRef(false), controller = useRef(null);
  callbacks.current = { onDirtyChange, onBusyChange };
  const dirty = templateDirty || issueDirty || linksDirty, busy = templateBusy || issueBusy || sourceBusy || linksBusy;
  // Share the existing POP/navigation guard when communications is alongside
  // certificates; two simultaneously dirty history-restoration guards compete.
  const navigationBusy = busy || additionalNavigationBusy;
  const guard = usePopupUnsavedChanges({ dirty: dirty || navigationBusy || additionalNavigationDirty,
    isDirty: () => sourcePending.current || dirty || navigationBusy || additionalNavigationDirty });
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); }; }, []);
  const ready = library.isSuccess && !library.isFetching && !library.isError;
  const records = library.data || { templates: [], issues: [] }, latestMap = new Map();
  const linksIssue = records.issues.find(item => item.id === linksIssueId);
  for (const item of records.templates) if (!latestMap.has(item.series_id) || latestMap.get(item.series_id).revision < item.revision) latestMap.set(item.series_id, item);
  const latest = [...latestMap.values()];
  const reload = async () => {
    const result = await library.refetch();
    if (result.error || !result.data) throw result.error || new Error('The complete certificate library could not be loaded.');
    tenant.assertCurrent();
  };
  const reloadAll = async () => {
    const results = await Promise.all([library.refetch(), outcomes.refetch()]);
    for (const result of results) if (result.error || !result.data) throw result.error || new Error('Certificate or outcome records could not be refreshed completely.');
    tenant.assertCurrent();
  };
  const downloadSource = async id => {
    if (sourcePending.current || busy || !ready) return;
    sourcePending.current = true; setSourceBusy(true); setSourceError('');
    const abort = new AbortController(); controller.current = abort;
    try {
      const pdf = await certificateRequest(tenant, `/api/awards/certificates?templateId=${encodeURIComponent(id)}`, { pdf: true, signal: abort.signal });
      tenant.assertCurrent(); if (alive.current && !abort.signal.aborted) downloadCertificate(pdf, 'award-certificate-template.pdf');
    } catch (failure) { if (alive.current && !abort.signal.aborted) setSourceError(failure.message); }
    finally { sourcePending.current = false; if (alive.current) setSourceBusy(false); }
  };
  const historyPages = Math.max(1, Math.ceil(records.issues.length / 10));
  return <Card className="mt-6 shadow-sm min-w-0"><CardHeader className="border-b"><p className="awards-kicker">Award certificates</p><CardTitle className="text-xl">Artwork, preview & immutable issuance</CardTitle></CardHeader><CardContent className="p-6 space-y-6">
    <p className="awards-help">Award-specific certificate administration. No historic CPD certificate, points or attendance record is changed. Saving a template, previewing, generating and releasing a certificate are separate actions.</p>
    {library.isPending && <div role="status" aria-label="Loading complete certificate library"><Skeleton className="h-12 mb-3" /><Skeleton className="h-28" /></div>}
    {library.isError && <div role="alert" className="space-y-3"><p className="text-sm text-red-700">{library.error.message}</p><Button type="button" variant="outline" disabled={busy || library.isFetching} onClick={() => library.refetch()}>Retry complete certificate library</Button></div>}
    {library.data && <>
      <div className="flex gap-3 flex-wrap items-center"><p className="awards-help">{records.templates.length} immutable template versions · {records.issues.length} issues</p><Button type="button" size="sm" variant="outline" disabled={busy || library.isFetching} onClick={() => library.refetch()}>Reload complete records (keep drafts)</Button></div>
      {!records.templates.length && <div className="border border-dashed rounded-lg p-5 awards-help">No artwork has been saved. Start with a private PDF and add award text placements below.</div>}
      <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-semibold">Historical template versions ({records.templates.length})</summary>
        {sourceError && <p role="alert" className="mt-3 text-sm text-red-700">{sourceError}</p>}
        <ul className="divide-y mt-3">{records.templates.map(item => <li key={item.id} className="py-3 flex flex-wrap justify-between gap-3 text-sm"><span>{item.name} · version {item.revision}{latestMap.get(item.series_id)?.id === item.id ? ' · latest in series' : ' · historical'}</span><Button type="button" size="sm" variant="outline" disabled={busy || !ready} onClick={() => downloadSource(item.id)}>Download source PDF</Button></li>)}</ul>
      </details>
      <CertificateTemplateEditor tenant={tenant} templates={records.templates} latest={latest} ready={ready && !issueBusy && !sourceBusy && !linksBusy}
        onSaved={reload} onReload={reload} onDirtyChange={setTemplateDirty} onBusyChange={setTemplateBusy} />
      {outcomes.isPending && <div role="status" aria-label="Loading approved outcomes"><Skeleton className="h-24" /></div>}
      {outcomes.isError && <div role="alert" className="space-y-3"><p className="text-sm text-red-700">{outcomes.error.message}</p><Button type="button" variant="outline" disabled={busy || outcomes.isFetching} onClick={() => outcomes.refetch()}>Retry complete approved outcomes</Button></div>}
      <CertificateIssuance tenant={tenant} templates={latest} outcomes={outcomes.data || []} issues={records.issues}
        ready={ready && outcomes.isSuccess && !outcomes.isFetching && !outcomes.isError && !templateBusy && !sourceBusy && !linksBusy}
        onIssued={reloadAll} onDirtyChange={setIssueDirty} onBusyChange={setIssueBusy} />
      <section className="space-y-3 border-t pt-5"><h3 className="font-semibold">Immutable issue history</h3>
        {!records.issues.length ? <p className="awards-help">No certificates have been issued for this award.</p> : <ul className="divide-y">{records.issues.slice((historyPage - 1) * 10, historyPage * 10).map(item => {
          const template = records.templates.find(row => row.id === item.template_id);
          return <li className="py-3 text-sm space-y-1 break-words" key={item.id}><p>{template ? `${template.name} · template version ${template.revision}` : `Template ID: ${item.template_id}`}</p><p className="awards-help">Issue: {item.id}</p><p className="awards-help">Outcome revision ID: {item.outcome_revision_id}</p><p className="awards-help">Issued: {item.created_at}. Delivery and release are not inferred from issuance.</p><Button type="button" size="sm" variant="outline" disabled={busy || !ready || additionalNavigationBusy} aria-pressed={linksIssueId === item.id} onClick={() => {
            if (linksDirty && !window.confirm('Discard only the unsaved private-link revocation reason/confirmation before changing the selected issue? Template and issuance drafts are preserved. Any prior revocation request is not undone by changing this selection.')) return;
            setLinksIssueId(old => old === item.id ? '' : item.id);
          }}>{linksIssueId === item.id ? 'Close private-link controls' : 'Review / revoke private links…'}</Button></li>;
        })}</ul>}
        <nav aria-label="Certificate issue history pages" className="flex justify-between items-center gap-3"><Button type="button" size="sm" variant="outline" disabled={historyPage <= 1} onClick={() => setHistoryPage(value => value - 1)}>Previous</Button><span className="awards-help">Page {historyPage} of {historyPages} · display pagination only</span><Button type="button" size="sm" variant="outline" disabled={historyPage >= historyPages} onClick={() => setHistoryPage(value => value + 1)}>Next</Button></nav>
      </section>
      {linksIssue && <CertificateLinkRevocation tenant={tenant} awardId={award.id} issue={linksIssue} available={ready}
        disabled={templateBusy || issueBusy || sourceBusy || additionalNavigationBusy} onClose={() => setLinksIssueId('')}
        onDirtyChange={setLinksDirty} onBusyChange={setLinksBusy} />}
    </>}
    <AlertDialog open={!!guard.pending} onOpenChange={open => { if (!open) guard.stay(); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Leave award administration choices?</AlertDialogTitle><AlertDialogDescription>{navigationBusy ? 'A request is still running. Stay until its confirmed outcome is available.' : additionalNavigationDirty ? 'Leaving discards local certificate/communication choices, private-link revocation reasons/confirmations and in-memory retry identifiers. It does not undo saved templates, issued PDFs or revoked bearer access, or cancel a message that may already be queued. Reconcile unconfirmed requests before leaving.' : 'Leaving discards local source, placement, preview, recipient and private-link revocation choices. It does not undo saved templates, issued PDFs or revoked bearer access. Reconcile an unconfirmed revocation before leaving.'}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><Button type="button" variant="outline" onClick={guard.stay}>Stay here</Button><Button type="button" variant="destructive" disabled={navigationBusy} onClick={guard.discard}>Discard choices and leave</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </CardContent></Card>;
}
