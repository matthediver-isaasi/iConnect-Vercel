import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminFetch } from '@/lib/adminFetch';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const expiry = value => `${new Date(value).toISOString()} (UTC)`;

async function accessRequest(tenant, applicationId, { page = 1, body, signal } = {}) {
  tenant.assertCurrent();
  const response = await adminFetch(`/api/awards/applicant-access${body ? '' : `?applicationId=${encodeURIComponent(applicationId)}&page=${page}`}`, {
    method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal,
    ...(body ? { headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' }, body: JSON.stringify(body) } : {}),
  }, tenant.tenantId);
  tenant.assertCurrent();
  let result;
  try { result = await response.json(); }
  catch { throw new Error(body ? 'The revocation response was unreadable. Its outcome is not confirmed; reconcile before another confirmation.' : 'Applicant grant metadata could not be read. No write is authorised.'); }
  tenant.assertCurrent();
  if (!response.ok) throw new Error(result?.error || 'Applicant access could not be read or changed.');
  return result;
}

export default function ApplicantAccessRevocation(props) {
  return <AccessWorkspace key={`${props.tenant.scopeKey}:${props.awardId}:${props.application.id}`} {...props} />;
}

function AccessWorkspace({ tenant, awardId, application, available, disabled, onClose, onDirtyChange, onBusyChange }) {
  const reference = application.reference || application.id;
  const [page, setPage] = useState(1), [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState(null), [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [confirmed, setConfirmed] = useState(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [clock, setClock] = useState(Date.now);
  const pending = useRef(false), alive = useRef(false), attempted = useRef(false), callbacks = useRef({});
  callbacks.current = { onClose, onDirtyChange, onBusyChange };
  const queryClient = useQueryClient();
  const scope = ['award-applicant-access', tenant.scopeKey, awardId, application.id];
  const query = useQuery({
    queryKey: [...scope, page], enabled: available,
    queryFn: async ({ signal }) => {
      try {
        const data = await accessRequest(tenant, application.id, { page, signal });
        if (!Array.isArray(data?.links) || !Number.isSafeInteger(data.total) || data.total < 0 || data.page !== page || data.pageSize !== 50
          || typeof data.memberOwned !== 'boolean' || typeof data.version !== 'string' || !/^[a-f0-9]{32}$/.test(data.version)
          || data.links.length !== Math.min(50, Math.max(0, data.total - (page - 1) * 50))
          || new Set(data.links.map(link => link?.id)).size !== data.links.length
          || data.links.some(link => !uuid.test(link?.id || '') || typeof link.expiresAt !== 'string'
            || !/(Z|[+-]\d{2}:\d{2})$/.test(link.expiresAt) || !Number.isFinite(Date.parse(link.expiresAt)))) {
          throw new Error('The application grant catalog/full-set version could not be verified. No partial read authorises revocation.');
        }
        return data;
      } catch (failure) {
        if (!signal.aborted) {
          queryClient.setQueriesData({ queryKey: scope }, () => null);
          if (alive.current) { setBlocked(true); setConfirmation(null); setAcknowledged(false); }
        }
        throw failure;
      }
    },
    gcTime: 0, staleTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const ready = available && query.isSuccess && !query.isFetching && !query.isError && !!query.data;
  const data = ready ? query.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;
  const dirty = (!confirmed && !!(reason || confirmation)) || (blocked && attempted.current);
  const canReview = !!data && !data.memberOwned && data.total > 0 && page <= pages && !blocked && !confirmed && !disabled && !busy && !!reason.trim() && reason.length <= 2000;
  const unchanged = !!confirmation && !!data && !data.memberOwned && data.version === confirmation.version && data.total === confirmation.total;
  useEffect(() => { callbacks.current.onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange?.(busy); }, [busy]);
  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { alive.current = false; window.clearInterval(timer); callbacks.current.onDirtyChange?.(false); callbacks.current.onBusyChange?.(false); };
  }, []);
  const reconcile = async () => {
    if (pending.current || disabled || !available) return;
    pending.current = true; setBusy(true); setError(''); setConfirmation(null); setAcknowledged(false);
    try {
      const result = await query.refetch(); tenant.assertCurrent();
      if (result.error || !result.data) throw result.error || new Error('Current applicant grants could not be loaded.');
      if (!alive.current) return;
      setBlocked(false); setClock(Date.now());
      setNotice(confirmed
        ? 'The confirmed revocation has not been repeated. This is the current grant set; grants created afterward are a separate operation.'
        : 'Current ownership, full-set version and total reloaded. Your reason is retained. A prior request may have committed; zero remaining grants does not prove that your reason was recorded. Any further operation requires a fresh explicit confirmation.');
    } catch (failure) { if (alive.current) { setBlocked(true); setError(failure.message); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const close = () => {
    if (pending.current || disabled) return;
    if (dirty && !window.confirm(`${attempted.current && blocked && !confirmed ? 'The previous request may have committed. ' : ''}Discard only this local applicant-access reason/confirmation and close? Application decisions and moderation drafts are unchanged. No command is retried.`)) return;
    callbacks.current.onClose?.();
  };
  return <section className="rounded-lg border mt-5 p-4 space-y-4" aria-label="External applicant link access">
    <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-semibold">External application link access</h3><p className="awards-help break-words mt-2">Application {reference}</p></div><Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={close}>Close access controls</Button></div>
    <p className="text-sm">Revocation disables all currently unrevoked external grants for this application, including expired links. Those grants can no longer access status, amendments, withdrawal or released certificates. Original submissions and amendments are preserved, as are ordinary member login and separately issued certificate links. Previously delivered mail cannot be recalled. No raw URLs or tokens are displayed.</p>
    <p className="awards-help">If a new link is needed, an administrator with communicate permission can use the existing configured application message in Communications. This panel does not send mail or provide a separate resend action.</p>
    <Button type="button" size="sm" variant="outline" disabled={busy || disabled || !available || query.isFetching} onClick={reconcile}>Reconcile current grants (keep reason)</Button>
    {!available ? <p role="alert" className="awards-help">Reload the application list before reviewing or changing access. Local revocation inputs are retained.</p>
      : query.isFetching || query.isPending ? <div role="status" aria-label="Loading applicant grant metadata"><Skeleton className="h-24 w-full" /></div>
        : query.isError ? <p role="alert" className="text-sm text-red-800">{query.error.message} Stale grant metadata was cleared. Reconcile before another confirmation.</p>
          : data?.memberOwned ? <div className="rounded-lg border p-4 text-sm">This application is member-owned. Ordinary member login applies; no external application grant action is available here. Member access is not revoked by these controls.</div>
            : data && <>
              <p className="text-sm font-medium">{data.total} unrevoked grants in the complete server set, including expired links—not just this page.</p>
              <p className="awards-help">Expiry labels use the browser clock; unexpired means usable by date only. The server still checks current application/grant authority.</p>
              {!data.total ? <div className="rounded-lg border border-dashed p-4 awards-help">No unrevoked external grants remain in the current set. No revocation request is available.</div>
                : page > pages ? <div className="space-y-2"><p className="awards-help">This page is no longer in range. No stale rows are shown.</p><Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => setPage(1)}>Load first grant page</Button></div>
                  : <ul className="divide-y">{data.links.map(link => <li key={link.id} className="py-3 space-y-1 text-sm"><p className="awards-help break-words">Grant record: {link.id}</p><p>{Date.parse(link.expiresAt) <= clock ? 'Expired' : 'Unexpired — usable by date'} · expires {expiry(link.expiresAt)}</p></li>)}</ul>}
              {data.total > 0 && <nav aria-label="Applicant access grant pages" className="flex flex-wrap justify-between items-center gap-3"><Button type="button" size="sm" variant="outline" disabled={page <= 1 || busy || disabled || !!confirmation} onClick={() => setPage(value => value - 1)}>Previous grant page</Button><span className="awards-help">Requested page {page} · {pages} pages · up to 50 records per page</span><Button type="button" size="sm" variant="outline" disabled={page >= pages || page >= 10000 || busy || disabled || !!confirmation} onClick={() => setPage(value => value + 1)}>Next grant page</Button></nav>}
              {pages > 10000 && <p className="awards-help">The server permits browsing up to 10,000 pages. The full-set version/total cover all grants, including those outside browsable pages.</p>}
            </>}
    {(!data?.memberOwned || reason) && <div className="awards-field"><Label htmlFor="applicant-access-reason">Applicant link revocation reason (required)</Label><Textarea id="applicant-access-reason" rows={4} maxLength={2000} disabled={busy || disabled || !!confirmation} readOnly={!!confirmed || !!data?.memberOwned} value={reason} onChange={event => setReason(event.target.value)} /></div>}
    {!confirmed && !data?.memberOwned && <Button type="button" variant="outline" disabled={!canReview} onClick={() => {
      if (!canReview) return;
      tenant.assertCurrent(); setError(''); setAcknowledged(false);
      setConfirmation({ applicationId: application.id, reference, version: data.version, total: data.total, reason: reason.trim() });
    }}>Review revocation of all external grants…</Button>}
    {confirmed && <p role="status" className="text-sm">Server confirmed {confirmed.revokedCount} external application grants revoked. Submissions, amendments, separately issued certificate links and member login were not revoked. This describes that operation, not any new grants created later. Close and reopen to authorise another separate operation.</p>}
    {blocked && <p role="alert" className="text-sm text-amber-900">Writes are blocked until explicit reconciliation. Failed/ambiguous requests are never automatically retried; your reason is retained.</p>}
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}{notice && <p role="status" className="awards-help">{notice}</p>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !pending.current) { setConfirmation(null); setAcknowledged(false); } }}><DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Revoke every external grant for this application?</DialogTitle><DialogDescription>This revokes the exact server-versioned set, not a visible-page subset. No mail is recalled or sent.</DialogDescription></DialogHeader>
      {confirmation && <div className="space-y-4"><p className="text-sm font-semibold">Application {confirmation.reference}: all {confirmation.total} unrevoked grants, including expired links and other pages.</p><p className="text-sm">These grants will lose status, amendment, withdrawal and certificate access. Original evidence/history, ordinary member login and separately issued certificate links remain intact.</p><p className="text-sm whitespace-pre-wrap break-words">Reason: {confirmation.reason}</p>
        <label className="flex gap-3 items-start text-sm"><input type="checkbox" checked={acknowledged} disabled={busy || disabled} onChange={event => setAcknowledged(event.target.checked)} /><span>I explicitly confirm revoking the complete set of {confirmation.total} grants for {confirmation.reference}, not just the currently visible page.</span></label>
        {(!ready || !unchanged) && <p role="alert" className="text-sm text-red-800">The frozen full-set version/total is no longer backed by the current read. Return to retained inputs and reconcile.</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { setConfirmation(null); setAcknowledged(false); }}>Return (keep reason)</Button><Button type="button" variant="destructive" disabled={busy || disabled || blocked || !!confirmed || !ready || !unchanged || !acknowledged || !confirmation.total} onClick={async () => {
          if (pending.current || disabled || blocked || confirmed || !ready || !unchanged || !acknowledged || !confirmation.total) return;
          pending.current = true; attempted.current = true; setBusy(true); setError(''); setNotice('');
          let saved = null;
          try {
            const result = await accessRequest(tenant, application.id, { body: { applicationId: confirmation.applicationId, version: confirmation.version, reason: confirmation.reason } });
            if (result?.revoked !== true || !Number.isSafeInteger(result.revokedCount) || result.revokedCount !== confirmation.total) throw new Error('The server did not confirm revocation of the exact complete set. Reconcile before another operation.');
            saved = result; tenant.assertCurrent(); if (!alive.current) return;
            setConfirmed(result); setBlocked(true); setConfirmation(null); setAcknowledged(false);
            queryClient.setQueriesData({ queryKey: scope }, () => null);
            queryClient.invalidateQueries({ queryKey: scope, refetchType: 'none' });
            queryClient.invalidateQueries({ queryKey: ['award-audit-history', tenant.scopeKey, awardId] });
            const refreshed = await query.refetch(); tenant.assertCurrent();
            if (refreshed.error || !refreshed.data) throw refreshed.error || new Error('Current applicant grant metadata could not be refreshed.');
            if (alive.current) { setBlocked(false); setNotice('Revocation confirmed and current metadata refreshed. Nothing was emailed or recalled; no application evidence was changed.'); }
          } catch (failure) {
            if (alive.current) {
              queryClient.setQueriesData({ queryKey: scope }, () => null);
              setBlocked(true); setConfirmation(null); setAcknowledged(false);
              setError(saved ? `Revocation of ${saved.revokedCount} grants was confirmed, but reconciliation failed: ${failure.message}. Do not repeat the write.`
                : `${failure.message} The operation may have committed. Your reason is retained; reconcile the current set before any new explicit confirmation.`);
            }
          } finally { pending.current = false; if (alive.current) setBusy(false); }
        }}>{busy ? 'Awaiting revocation confirmation…' : `Revoke all ${confirmation.total} grants`}</Button></DialogFooter>
      </div>}
    </DialogContent></Dialog>
  </section>;
}
