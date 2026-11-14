import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useExternalAwardApplicant } from '@/hooks/useExternalAwardApplicant';
import { usePageLayoutDecision } from '@/contexts/LayoutContext';
import { usePopupUnsavedChanges } from '@/hooks/usePopupUnsavedChanges';
import { downloadCertificate } from '@/lib/awardCertificatePdf';
import { applicantUuid } from '@/components/awards/useAwardApplications';
import { externalApplicantRequest } from '@/components/awards/externalApplicantRequest';
import ApplicantWithdrawalDialog from '@/components/awards/ApplicantWithdrawalDialog';
import ApplicantEvidence from '@/components/awards/ApplicantEvidence';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import '@/components/awards/awards.css';

export default function AwardApplication() {
  usePageLayoutDecision({ forcePublicLayout: true, publicChrome: 'both' });
  const location = useLocation();
  const params = new URLSearchParams(location.search), applicationId = params.get('applicationId');
  const authority = useExternalAwardApplicant(applicationId);
  return <main className="awards-workspace min-h-[100dvh] mx-auto max-w-3xl px-4 py-8 sm:py-12 space-y-6">
    <header className="awards-intro p-6 sm:p-8 space-y-3"><p className="awards-kicker">Secure applicant access</p><h1 className="text-2xl sm:text-3xl font-semibold">Your award application</h1><p className="text-sm leading-6">This private link authorises only its application. No member account or login session is created or used. Outcomes and certificates appear only when released to you.</p></header>
    {!applicantUuid.test(applicationId || '') || params.getAll('applicationId').length !== 1
      ? <p role="alert" className="rounded-lg border p-5">The application link is invalid. Ask the award administrator to resend an authorised link.</p>
      : authority.status !== 'ready' ? <p role="alert" className="rounded-lg border p-5 text-sm">{authority.error}</p>
        : <ApplicationStatus key={authority.scopeKey} authority={authority} />}
    <p className="awards-help">The secret fragment was removed before application requests and is held only in memory for this application and its evidence amendment. Leaving this scope or refreshing may require reopening your original link. There is no self-service link renewal.</p>
  </main>;
}

function ApplicationStatus({ authority }) {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['external-award-applicant-status', authority.scopeKey, authority.applicationId],
    queryFn: ({ signal }) => externalApplicantRequest(authority, authority.tenantSlug, { signal }),
    retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const [selected, setSelected] = useState(null), [reason, setReason] = useState(''), [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false), [reloading, setReloading] = useState(false), [blocked, setBlocked] = useState(false);
  const [failure, setFailure] = useState(null), [notice, setNotice] = useState(''), [destination, setDestination] = useState(null);
  const pending = useRef(false), alive = useRef(false), controllers = useRef(new Set());
  useEffect(() => { alive.current = true; return () => { alive.current = false; controllers.current.forEach(controller => controller.abort()); }; }, []);
  const ready = query.isSuccess && !query.isFetching && !query.isError && !!query.data;
  const row = ready ? query.data.applications[0] : null;
  const stale = !!selected && (!row || selected.version !== row.version || !row.canWithdraw);
  const dirty = !!selected || !!reason || busy || reloading;
  const guard = usePopupUnsavedChanges({ dirty, isDirty: () => pending.current || dirty });
  useEffect(() => {
    if (!destination || busy || reloading || selected) return;
    try { authority.assertCurrent(); navigate(destination); }
    catch (error) { setDestination(null); setFailure(error); }
  }, [destination, busy, reloading, selected, navigate, authority.scopeKey]);
  const reload = async () => {
    if (pending.current) return;
    pending.current = true; setReloading(true); setFailure(null); setAcknowledged(false);
    try {
      const result = await query.refetch(); authority.assertCurrent();
      if (result.error || !result.data) throw result.error || new Error('Current application authority could not be reloaded.');
      if (!alive.current) return;
      if (selected) setSelected({ ...result.data.applications[0] });
      setBlocked(false);
      setNotice('Current status/version reloaded. Your withdrawal reason is retained; a previous change may have committed. Review the current availability before a new confirmation.');
    } catch (error) { if (alive.current) { setFailure(error); setBlocked(true); } }
    finally { pending.current = false; if (alive.current) setReloading(false); }
  };
  const runReadAction = async task => {
    if (pending.current || !ready || selected) return;
    pending.current = true; setBusy(true); setFailure(null); setNotice('');
    const controller = new AbortController(); controllers.current.add(controller);
    try { await task(controller.signal); }
    catch (error) { if (alive.current) setFailure(error); }
    finally { controllers.current.delete(controller); pending.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="space-y-5">
    <div className="flex flex-wrap justify-between gap-3"><h2 className="font-semibold">Application status</h2><Button type="button" size="sm" variant="outline" disabled={busy || reloading || query.isFetching} onClick={reload}>Refresh current status</Button></div>
    {(query.isPending || query.isFetching) && <div role="status" aria-label="Checking secure applicant access" className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40 w-full" /></div>}
    {query.isError && <p role="alert" className="rounded-lg border p-5 text-sm">{query.error.message} No stale application or released evidence is displayed. Retry loading explicitly, or ask the award administrator to resend your link if access is unavailable.</p>}
    {row && <Card><CardHeader><div className="flex flex-wrap justify-between gap-3"><div className="space-y-2"><CardTitle className="text-lg break-words">{row.awardName}</CardTitle><p className="text-sm font-medium break-words">{row.reference}</p></div><span className="awards-status">{row.status}</span></div></CardHeader><CardContent className="space-y-5">
      <ApplicantEvidence session={authority} tenantSlug={authority.tenantSlug} applicationId={row.id} version={row.version} />
      <p className="awards-help">Submitted <time dateTime={row.submittedAt}>{new Date(row.submittedAt).toISOString()} (UTC)</time></p>
      {row.outcome !== null && <section className="rounded-lg border bg-[#edf4f4] p-4 space-y-2" aria-label="Released outcome"><h3 className="awards-kicker">Released outcome</h3><p className="text-sm whitespace-pre-wrap break-words">{row.outcome}</p></section>}
      {row.certificates.length > 0 && <section className="rounded-lg border p-4 space-y-3" aria-label="Released certificates"><h3 className="awards-kicker">Released certificates</h3><ul className="space-y-4">{row.certificates.map(certificate => <li key={certificate.id} className="space-y-1"><Button type="button" variant="outline" disabled={busy || reloading || !!selected} onClick={() => runReadAction(async signal => {
        const blob = await externalApplicantRequest(authority, authority.tenantSlug, { issueId: certificate.id, signal });
        authority.assertCurrent(); if (!alive.current) return;
        downloadCertificate(blob, `award-certificate-${row.reference}.pdf`);
        setNotice('The authenticated, released PDF was handed to your browser’s download manager. Nothing was emailed.');
      })}>Download {certificate.category || 'award'} certificate PDF</Button><p className="awards-help">Issued {new Date(certificate.issuedAt).toISOString()} (UTC)</p></li>)}</ul></section>}
      <div className="border-t pt-4 space-y-3"><p className="awards-help">Evidence-only amendments do not pay again, create/update member records or change judges’ assigned evidence. Explicit administrator adoption is required before reassessment.</p><div className="flex flex-wrap gap-3">
        {row.canAmend && <Button type="button" variant="outline" disabled={busy || reloading || !!selected} onClick={() => runReadAction(async signal => {
          const editor = await externalApplicantRequest(authority, authority.tenantSlug, { applicationId: row.id, edit: true, signal });
          authority.assertCurrent(); if (!alive.current) return;
          const params = new URLSearchParams({ slug: editor.formSlug, award_amendment: row.id, externalApplicant: '1' });
          if (authority.tenantSlug) params.set('tenant', authority.tenantSlug);
          setDestination(`/FormView?${params}`);
        })}>Amend evidence</Button>}
        {row.canWithdraw && <Button type="button" variant="outline" disabled={busy || reloading || !!selected || blocked} onClick={() => {
          authority.assertCurrent(); setSelected({ ...row }); setAcknowledged(false); setFailure(null);
        }}>Withdraw application</Button>}
      </div><p className="awards-help">{row.canAmend ? 'Evidence amendments are currently available.' : 'Evidence amendments are not currently available.'} {row.canWithdraw ? 'Withdrawal is currently available.' : 'Withdrawal is not currently available.'}</p></div>
    </CardContent></Card>}
    {busy && <div role="status" aria-label="Loading authorised application action"><Skeleton className="h-4 w-2/3" /><p className="awards-help mt-2">Checking current authority and reading the complete response. No automatic retries.</p></div>}
    {notice && <p role="status" className="rounded-lg border p-4 text-sm">{notice}</p>}
    {failure && !selected && <p role="alert" className="text-sm text-red-800">{failure.message}</p>}
    {selected && <ApplicantWithdrawalDialog application={selected} reason={reason} confirmed={acknowledged}
      onReasonChange={value => { setReason(value); setAcknowledged(false); }} onConfirmedChange={setAcknowledged}
      busy={busy} reloading={reloading} blocked={blocked} stale={stale} ready={ready} error={failure} notice={notice}
      onReload={reload} onClose={() => {
        if (pending.current || (reason && !window.confirm('Discard only this unsaved withdrawal reason and close? Any previously accepted withdrawal is not undone.'))) return;
        setSelected(null); setReason(''); setAcknowledged(false); setFailure(null);
      }} onSubmit={async event => {
        event.preventDefault();
        if (pending.current || blocked || stale || !ready || !selected.canWithdraw || !acknowledged || !reason.trim() || reason.length > 2000) return;
        pending.current = true; setBusy(true); setFailure(null);
        const controller = new AbortController(); controllers.current.add(controller);
        try {
          await externalApplicantRequest(authority, authority.tenantSlug, { signal: controller.signal,
            payload: { command: 'withdraw', applicationId: selected.id, version: selected.version, reason: reason.trim() } });
          authority.assertCurrent(); if (!alive.current) return;
          setSelected(null); setReason(''); setAcknowledged(false); setBlocked(false);
          setNotice('The server confirmed withdrawal. No replacement application was created.');
          await query.refetch();
        } catch (error) { if (alive.current) { setFailure(error); setBlocked(true); setAcknowledged(false); } }
        finally { controllers.current.delete(controller); pending.current = false; if (alive.current) setBusy(false); }
      }} />}
    <Dialog open={!!guard.pending} onOpenChange={open => { if (!open) guard.stay(); }}><DialogContent className="awards-workspace"><DialogHeader><DialogTitle>Leave secure application access?</DialogTitle><DialogDescription>{busy || reloading ? 'Wait for the current request before leaving so its confirmed result can be checked.' : 'Leaving discards the local withdrawal reason and may clear this in-memory access grant. It does not undo an accepted withdrawal. An unconfirmed result must be reconciled, not blindly retried.'}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={guard.stay}>Stay here</Button><Button variant="destructive" disabled={busy || reloading} onClick={guard.discard}>Discard local choices and leave</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
