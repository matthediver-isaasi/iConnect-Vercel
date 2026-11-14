import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { getTenantSlugFromLocation } from '@/api/publicClient';
import { getActiveTenantId, subscribeToActiveTenantId } from '@/api/base44Client';
import { useLayoutContext } from '@/contexts/LayoutContext';
import { subscribeToViewerProtectedWork, getViewerProtectedWorkGeneration } from '@/lib/viewerProtectedWorkGate';
import { captureAwardCertificateAccess, clearAwardCertificateAccess } from '@/lib/awardCertificateAccess';
import { validatedPdf, downloadCertificate } from '@/lib/awardCertificatePdf';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import '@/components/awards/awards.css';

export default function AwardCertificate() {
  const location = useLocation(), { memberInfo } = useLayoutContext();
  const context = `${location.pathname}${location.search}`, captured = captureAwardCertificateAccess();
  return <CertificateDownload key={context} issueId={new URLSearchParams(location.search).get('issueId')} access={captured} memberId={memberInfo?.id || null} />;
}
function CertificateDownload({ issueId, access, memberId }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [downloaded, setDownloaded] = useState(false);
  const controller = useRef(null), pending = useRef(false), alive = useRef(true), generation = useRef(0);
  const credential = useRef(access);
  if ((access?.token || access?.invalid) && access.serial !== credential.current?.serial) credential.current = access;
  const credentialSerial = credential.current?.serial;
  const epoch = useSyncExternalStore(subscribeToViewerProtectedWork, getViewerProtectedWorkGeneration, () => 0);
  const tenantSlug = getTenantSlugFromLocation();
  const activeTenant = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  const validId = typeof issueId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issueId);
  useLayoutEffect(() => {
    alive.current = true; generation.current += 1; controller.current?.abort(); pending.current = false;
    setBusy(false); setDownloaded(false); setError('');
    return () => { alive.current = false; generation.current += 1; controller.current?.abort(); pending.current = false; };
  }, [issueId, tenantSlug, activeTenant, memberId, epoch, credentialSerial]);
  useEffect(() => {
    const cancel = () => { generation.current += 1; controller.current?.abort(); pending.current = false; if (alive.current) { setBusy(false); setDownloaded(false); setError('The organisation or access context changed. Check the current page before explicitly downloading again.'); } };
    const storage = event => { if (event.key === null || ['agcas_member', 'tenant_slug', 'activeTenantId'].includes(event.key)) cancel(); };
    window.addEventListener('storage', storage); window.addEventListener('tenant-context-changed', cancel);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('tenant-context-changed', cancel); clearAwardCertificateAccess(); };
  }, []);
  const download = async () => {
    if (pending.current || !validId || credential.current?.invalid) return;
    pending.current = true; setBusy(true); setError(''); setDownloaded(false);
    const currentGeneration = generation.current, abort = new AbortController(); controller.current = abort;
    const assertCurrent = () => {
      if (!alive.current || abort.signal.aborted || generation.current !== currentGeneration || credential.current?.serial !== credentialSerial || getTenantSlugFromLocation() !== tenantSlug || getActiveTenantId() !== activeTenant) throw new Error('Certificate access changed. Nothing was downloaded; request it again from the current context.');
    };
    try {
      assertCurrent();
      const url = new URL('/api/public/award-certificate', window.location.origin);
      url.searchParams.set('issueId', issueId); if (tenantSlug) url.searchParams.set('tenant', tenantSlug);
      const response = await fetch(`${url.pathname}${url.search}`, { credentials: 'include', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: abort.signal,
        headers: credential.current?.token ? { 'X-Awards-Certificate-Token': credential.current.token } : {} });
      assertCurrent();
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in as the recipient or reopen your original authorised certificate link.' : response.status === 403 || response.status === 404 ? 'This certificate is unavailable for the current access context.' : 'The certificate could not be downloaded. Please retry explicitly.');
      const blob = await validatedPdf(response); assertCurrent();
      downloadCertificate(blob); setDownloaded(true);
    } catch (failure) { if (alive.current && generation.current === currentGeneration && !abort.signal.aborted) setError(failure instanceof TypeError ? 'The certificate request failed. Check your connection and retry explicitly.' : failure.message); }
    finally { if (generation.current === currentGeneration) { pending.current = false; if (alive.current) setBusy(false); } }
  };
  return <section className="awards-workspace mx-auto max-w-2xl px-4 py-10 min-h-[60dvh]"><Card className="shadow-sm"><CardContent className="p-7 md:p-10 space-y-5">
    <div className="rounded-full bg-[#edf4f4] text-[#32717a] p-4 w-fit"><FileText className="h-7 w-7" aria-hidden="true" /></div>
    <p className="awards-kicker">Award certificate</p><h1 className="text-2xl font-semibold">Your certificate PDF</h1>
    <p className="awards-help">Download is checked against the current recipient release and your member session or original external certificate link. The PDF is not loaded until you ask for it.</p>
    {!validId ? <p role="alert" className="text-sm text-red-700">A valid certificate issue ID is required. Open the link from your released award application or original certificate message.</p> : credential.current?.invalid ? <p role="alert" className="text-sm text-red-700">The external certificate link is invalid. Reopen the original link; its secret fragment has been removed from this address.</p> : <Button type="button" disabled={busy} onClick={download}>{busy ? 'Preparing authenticated PDF…' : 'Download certificate PDF'}</Button>}
    {busy && <div role="status" aria-label="Loading certificate PDF"><Skeleton className="h-5 mb-2 w-3/4" /><Skeleton className="h-5 w-1/2" /></div>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {error && !credential.current?.token && validId && <a className="block text-sm underline underline-offset-4" href={`/login?returnTo=${encodeURIComponent(`/award-certificate?issueId=${encodeURIComponent(issueId)}${tenantSlug ? `&tenant=${encodeURIComponent(tenantSlug)}` : ''}`)}`}>Member recipient sign-in</a>}
    {downloaded && <p role="status" className="awards-help">The authenticated PDF was handed to your browser’s download manager. Nothing was emailed.</p>}
    <p className="awards-help">External access secrets are kept only in this page’s memory, never in a query string or browser storage. Refreshing an external visit may require reopening the original link.</p>
  </CardContent></Card></section>;
}
