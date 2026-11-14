import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { getTenantSlugFromLocation } from '@/api/publicClient';
import { useLayoutContext } from '@/contexts/LayoutContext';
import { useMemberChangeSession as useVerifiedMemberSession } from '@/hooks/useMemberChangeSession';
import { usePopupUnsavedChanges } from '@/hooks/usePopupUnsavedChanges';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '@/components/ui/alert-dialog';
import ApplicantWithdrawalDialog from '@/components/awards/ApplicantWithdrawalDialog';
import ApplicantEvidence from '@/components/awards/ApplicantEvidence';
import { applicantUuid, applicantApplicationsKey, applicantRequest, useAwardApplications } from '@/components/awards/useAwardApplications';
import '@/components/awards/awards.css';

function LoadingApplications() {
  return <div role="status" aria-label="Loading your award applications" className="space-y-4">
    {[0, 1, 2].map(index => <Card key={index}><CardContent className="space-y-4 p-6">
      <Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-1/3" /><Skeleton className="h-4 w-1/2" />
    </CardContent></Card>)}
    <span className="sr-only">Loading your award applications</span>
  </div>;
}

function submittedText(value) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value));
}

export default function AwardApplications() {
  // This existing hook verifies the normal member/tenant/session epoch only;
  // it does not require a membership-change or awards-management capability.
  const session = useVerifiedMemberSession();
  const { memberInfo } = useLayoutContext();
  const location = useLocation();
  const applicationId = new URLSearchParams(location.search).get('applicationId');
  const validFilter = applicationId === null || applicantUuid.test(applicationId);
  let tenantSlug = null;
  let tenantError = '';
  try { tenantSlug = getTenantSlugFromLocation(); }
  catch { tenantError = 'Your organisation context could not be read. Restore access to browser storage and reload this page.'; }
  const returnTo = `/award-applications${validFilter && applicationId ? `?applicationId=${encodeURIComponent(applicationId)}` : ''}`;
  const loginHref = `/login?returnTo=${encodeURIComponent(returnTo)}`;
  return <main className="awards-workspace mx-auto min-h-[100dvh] max-w-4xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
    <header className="awards-intro space-y-3 p-6 sm:p-8">
      <p className="awards-kicker flex items-center gap-2"><FileText className="h-4 w-4" aria-hidden="true" />Member applications</p>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">My award applications</h1>
      <p className="max-w-2xl text-sm leading-6">Check your applications, correct evidence or withdraw where available. Evidence amendments do not take another payment or automatically change judges’ assigned evidence. Outcomes appear only when released to you.</p>
    </header>
    {session.status === 'loading' ? <LoadingApplications />
      : session.status !== 'ready' ? <Card><CardHeader><CardTitle className="text-lg">Member sign-in required</CardTitle></CardHeader><CardContent className="space-y-4">
        <p className="text-sm">{memberInfo ? 'Your current member session could not be verified. Reload to verify your access or sign in again.' : 'Sign in with your normal member account to view your applications.'}</p>
        <div className="flex flex-wrap items-center gap-4"><a className="text-sm underline underline-offset-4" href={loginHref}>Member sign-in</a><Button type="button" variant="outline" onClick={() => window.location.reload()}>Reload access</Button></div>
      </CardContent></Card>
        : tenantError ? <div className="space-y-4 rounded-lg border p-5"><p role="alert" className="text-sm">{tenantError}</p><Button type="button" variant="outline" onClick={() => window.location.reload()}>Reload organisation context</Button></div>
          : !validFilter ? <Card><CardContent className="space-y-4 p-6"><p role="alert" className="text-sm">This application link is invalid. No application has been loaded.</p><a className="text-sm underline underline-offset-4" href="/award-applications">View all my applications</a></CardContent></Card>
            : <ApplicantWorkspace key={JSON.stringify([session.scopeKey, tenantSlug, applicationId])}
              session={session} tenantSlug={tenantSlug} applicationId={applicationId} loginHref={loginHref} />}
  </main>;
}

function ApplicantWorkspace({ session, tenantSlug, applicationId, loginHref }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [amending, setAmending] = useState(null);
  const [amendError, setAmendError] = useState('');
  const [reloading, setReloading] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [failure, setFailure] = useState(null);
  const [dialogNotice, setDialogNotice] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const query = useAwardApplications(session, tenantSlug, page, applicationId);
  const guard = usePopupUnsavedChanges({ dirty: !!selected || busy || reloading, isDirty: () => lock.current || !!selected });
  const amend = async row => {
    if (lock.current || !ready || row.canAmend !== true || selected) return;
    lock.current = true; setAmending(row.id); setAmendError('');
    try {
      const authority = await applicantRequest(session, tenantSlug, { applicationId: row.id, edit: true });
      session.assertCurrent();
      if (!alive.current) return;
      // FormView independently reloads this authority; answers never go in
      // navigation state, local storage, query strings or cache keys.
      lock.current = false; setAmending(null);
      const params = new URLSearchParams({ slug: authority.formSlug, award_amendment: authority.applicationId });
      if (tenantSlug) params.set('tenant', tenantSlug);
      navigate(`/FormView?${params}`);
    } catch (error) { if (alive.current) setAmendError(error.message); }
    finally { lock.current = false; if (alive.current) setAmending(null); }
  };
  const data = query.data;
  const pages = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || 1)));
  const ready = query.isSuccess && !query.isFetching;
  const currentListRow = selected && data?.applications.find(row => row.id === selected.id);
  const stale = !!(currentListRow && currentListRow.version !== selected.version);
  const close = () => {
    if (lock.current || ((reason || confirmed) && !window.confirm('Discard your unsaved withdrawal reason and confirmation? This does not withdraw the application.'))) return;
    setSelected(null); setReason(''); setConfirmed(false); setFailure(null); setDialogNotice(''); setBlocked(false);
  };
  const open = row => {
    if (lock.current || !ready || !row.canWithdraw) return;
    setSelected({ ...row }); setReason(''); setConfirmed(false); setFailure(null); setDialogNotice(''); setNotice(''); setBlocked(false);
  };
  const reloadSelected = async () => {
    if (lock.current || !selected) return;
    lock.current = true; setReloading(true);
    try {
      const detail = await applicantRequest(session, tenantSlug, { applicationId: selected.id });
      const refreshed = await query.refetch();
      session.assertCurrent();
      if (!alive.current) return;
      if (refreshed.error) throw refreshed.error;
      const current = detail.applications.find(row => row.id === selected.id);
      if (!current) throw new Error('This application is not available to your current member account. Your reason has been retained, but no further withdrawal can be submitted.');
      setSelected(current); setConfirmed(false); setFailure(null); setBlocked(!current.canWithdraw);
      setDialogNotice(current.canWithdraw
        ? `Current server version ${current.version} loaded. Your reason was kept; review it and confirm again before withdrawing.`
        : `The server reports “${current.status}”. Withdrawal is not available. Your reason was kept and was not resubmitted.`);
    } catch (error) {
      if (alive.current) { setFailure(error); setBlocked(true); }
    } finally {
      lock.current = false;
      if (alive.current) setReloading(false);
    }
  };
  const withdraw = async event => {
    event.preventDefault();
    if (lock.current || !selected || !ready || blocked || stale || !selected.canWithdraw || !confirmed || !reason.trim() || reason.length > 2000) return;
    lock.current = true; setBusy(true); setFailure(null); setDialogNotice('');
    try {
      const result = await applicantRequest(session, tenantSlug, { payload: {
        command: 'withdraw', applicationId: selected.id, version: selected.version, reason: reason.trim(),
      } });
      session.assertCurrent();
      if (!alive.current) return;
      queryClient.setQueriesData({ queryKey: applicantApplicationsKey(session, tenantSlug) }, old => old ? {
        ...old, applications: old.applications.map(row => row.id === result.id
          ? { ...row, version: result.version, status: result.status, canWithdraw: false } : row),
      } : old);
      setNotice(`Withdrawal confirmed for ${selected.reference}.`);
      setSelected(null); setReason(''); setConfirmed(false); setBlocked(false);
      // The POST is already confirmed. A later read failure must never be
      // presented as a failed withdrawal or trigger another POST.
      await query.refetch();
    } catch (error) {
      if (alive.current) { setFailure(error); setBlocked(true); }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const changePage = next => {
    if (lock.current || next < 1 || next > pages) return;
    guard.request(() => {
      setSelected(null); setReason(''); setConfirmed(false); setFailure(null); setBlocked(false);
      setPage(next); setNotice('');
    });
  };
  return <section className="space-y-5" aria-label="Your award application records">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold">{applicationId ? 'Selected application' : 'Your applications'}</h2>
        <p className="awards-help">{data ? `${data.total} application${data.total === 1 ? '' : 's'} · page ${page} of ${pages}` : query.isError ? 'Applications unavailable' : 'Loading your records'}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {applicationId && <Button type="button" variant="outline" disabled={busy || reloading} onClick={() => navigate('/award-applications')}>All my applications</Button>}
        <Button type="button" variant="outline" disabled={query.isFetching || busy || reloading} onClick={() => query.refetch()}>{query.isFetching ? 'Refreshing…' : 'Refresh status'}</Button>
      </div>
    </div>
    {notice && <p role="status" className="rounded-lg border p-4 text-sm font-medium">{notice}</p>}
    {amending && <div role="status" className="space-y-2"><Skeleton className="h-3 w-full" /><p className="awards-help">Checking your member-private amendment authority…</p></div>}
    {amendError && <p role="alert" className="rounded-lg border p-4 text-sm text-red-800">{amendError} No new form submission or payment was started.</p>}
    {query.isPending && <LoadingApplications />}
    {query.isError && <Card><CardContent className="space-y-4 p-6">
      <div role="alert" className="space-y-2"><h3 className="font-semibold">{query.error.status === 401 ? 'Please sign in again' : 'Your applications could not be loaded'}</h3><p className="text-sm">{query.error.message}</p>{notice && <p className="text-sm">The withdrawal above is confirmed. Only refreshing this list failed; do not submit another withdrawal for it.</p>}</div>
      <div className="flex flex-wrap items-center gap-4"><Button type="button" variant="outline" disabled={query.isFetching || busy || reloading} onClick={() => query.refetch()}>Retry loading applications</Button>{query.error.status === 401 && <a className="text-sm underline underline-offset-4" href={loginHref}>Member sign-in</a>}</div>
    </CardContent></Card>}
    {query.isSuccess && data.applications.length === 0 && <Card><CardContent className="py-12 text-center">
      <FileText className="mx-auto mb-4 h-7 w-7 text-muted-foreground" aria-hidden="true" />
      <h3 className="text-lg font-semibold">{applicationId ? 'Application not available' : data.total ? 'No applications on this page' : 'No applications linked to your account'}</h3>
      <p className="awards-help mx-auto mt-2 max-w-md">{applicationId
        ? 'This application was not returned for your current member account. Check that you signed in to the correct organisation and account.'
        : data.total ? 'Use the page controls to return to your earlier records.' : 'Applications linked to your signed-in member account will appear here after submission.'}</p>
    </CardContent></Card>}
    {query.isSuccess && data.applications.map(row => <Card key={row.id}>
      <CardHeader className="pb-4"><div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div className="min-w-0 space-y-1"><CardTitle className="break-words text-lg">{row.awardName}</CardTitle><p className="break-words text-sm font-medium">{row.reference}</p></div>
        <span className="awards-status">{row.status}</span>
      </div></CardHeader>
      <CardContent className="space-y-5">
        <p className="awards-help">Submitted <time dateTime={row.submittedAt}>{submittedText(row.submittedAt)} UTC</time></p>
        <ApplicantEvidence session={session} tenantSlug={tenantSlug} applicationId={row.id} version={row.version} enabled={ready} />
        {row.outcome !== null && <div className="rounded-lg border border-[#d3e3e4] bg-[#edf4f4] p-4"><h3 className="awards-kicker mb-2">Released outcome</h3><p className="whitespace-pre-wrap break-words text-sm">{row.outcome}</p></div>}
        {Array.isArray(row.certificates) && row.certificates.length > 0 && <section className="rounded-lg border border-[#d3e3e4] p-4 space-y-3" aria-label="Released award certificates">
          <h3 className="awards-kicker">Your released certificates</h3>
          <ul className="space-y-3">{row.certificates.filter(certificate => applicantUuid.test(certificate.id || '')).map(certificate => <li key={certificate.id} className="text-sm">
            <Link className="font-medium underline underline-offset-4" to={`/award-certificate?issueId=${encodeURIComponent(certificate.id)}${tenantSlug ? `&tenant=${encodeURIComponent(tenantSlug)}` : ''}`}>Download {certificate.category || 'award'} certificate</Link>
            {certificate.issuedAt && Number.isFinite(Date.parse(certificate.issuedAt)) && <p className="awards-help mt-1">Issued {submittedText(certificate.issuedAt)} UTC</p>}
          </li>)}</ul>
        </section>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="awards-help">{row.canWithdraw ? 'Withdrawal is currently available.' : 'Withdrawal is not currently available.'}</p>
          {row.canWithdraw && <Button type="button" variant="outline" disabled={!ready || busy || reloading} onClick={() => open(row)}>Withdraw application</Button>}
          {row.canAmend === true && <Button type="button" variant="outline" disabled={!ready || busy || reloading || !!amending || !!selected} onClick={() => amend(row)}>Amend evidence</Button>}
        </div>
      </CardContent>
    </Card>)}
    {data && <nav aria-label="Application pages" className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
      <p className="awards-help">Page {page} of {pages} · up to {data.pageSize} applications per page</p>
      <div className="flex gap-2"><Button type="button" variant="outline" disabled={page <= 1 || query.isFetching || busy || reloading} onClick={() => changePage(page - 1)}>Previous</Button><Button type="button" variant="outline" disabled={page >= pages || page >= 10000 || query.isFetching || busy || reloading} onClick={() => changePage(page + 1)}>Next</Button></div>
    </nav>}
    {selected && <ApplicantWithdrawalDialog application={selected} reason={reason}
      onReasonChange={value => { setReason(value); setConfirmed(false); }} confirmed={confirmed} onConfirmedChange={setConfirmed}
      busy={busy} reloading={reloading} blocked={blocked} stale={stale} ready={ready}
      error={failure} notice={dialogNotice} loginHref={loginHref} onClose={close} onReload={reloadSelected} onSubmit={withdraw} />}
    <AlertDialog open={!!guard.pending} onOpenChange={open => { if (!open) guard.stay(); }}>
      <AlertDialogContent className="awards-workspace">
        <AlertDialogHeader><AlertDialogTitle>{amending ? 'Wait for member amendment authority?' : 'Leave this withdrawal choice?'}</AlertDialogTitle><AlertDialogDescription>{busy || reloading || amending
          ? 'A request is still in progress. Stay here until it finishes so you can check its confirmed outcome.'
          : 'Leaving discards your unsaved withdrawal choice and reason. It does not withdraw the application.'}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><Button type="button" variant="outline" onClick={guard.stay}>Stay here</Button><Button type="button" variant="destructive" disabled={busy || reloading || !!amending} onClick={guard.discard}>Discard choice and leave</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
