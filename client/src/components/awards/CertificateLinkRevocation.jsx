import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { certificateRequest } from './useAwardCertificates';

const expiryFormatter = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' });
const dateLabel = value => `${expiryFormatter.format(new Date(value))} UTC`;

export default function CertificateLinkRevocation(props) {
  return <LinkWorkspace key={`${props.tenant.scopeKey}:${props.awardId}:${props.issue.id}`} {...props} />;
}

function LinkWorkspace({ tenant, awardId, issue, available, disabled, onClose, onDirtyChange, onBusyChange }) {
  const [page, setPage] = useState(1), [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState(null), [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [confirmed, setConfirmed] = useState(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [clock, setClock] = useState(Date.now);
  const pending = useRef(false), alive = useRef(false), attempted = useRef(false), callbacks = useRef({});
  callbacks.current = { onDirtyChange, onBusyChange, onClose };
  const queryClient = useQueryClient();
  const scope = ['award-certificate-links', tenant.scopeKey, awardId, issue.id];
  const query = useQuery({
    queryKey: [...scope, page], enabled: available,
    queryFn: async ({ signal }) => {
      try {
        const data = await certificateRequest(tenant, `/api/awards/certificates?scope=links&issueId=${encodeURIComponent(issue.id)}&page=${page}`, { signal });
        if (!Array.isArray(data.links) || !Number.isSafeInteger(data.total) || data.total < 0 || data.page !== page || data.pageSize !== 50
          || typeof data.version !== 'string' || !/^[a-f0-9]{32}$/.test(data.version)
          || data.links.length !== Math.min(50, Math.max(0, data.total - (page - 1) * 50))
          || new Set(data.links.map(row => row?.id)).size !== data.links.length
          || data.links.some(row => !row || typeof row.id !== 'string' || !row.id || typeof row.expiresAt !== 'string'
            || !/(Z|[+-]\d{2}:\d{2})$/.test(row.expiresAt) || !Number.isFinite(Date.parse(row.expiresAt)))) {
          throw new Error('The certificate-link catalog or exact server-set version could not be verified. No partial list authorises a write.');
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
  const canReview = data && page <= pages && data.total > 0 && !blocked && !confirmed && !disabled && !busy;
  const dirty = (!confirmed && !!(reason || confirmation)) || (blocked && attempted.current);
  useEffect(() => { callbacks.current.onDirtyChange(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { alive.current = false; window.clearInterval(timer); callbacks.current.onDirtyChange(false); callbacks.current.onBusyChange(false); };
  }, []);
  const reconcile = async () => {
    if (pending.current || disabled || !available) return;
    pending.current = true; setBusy(true); setError(''); setConfirmation(null); setAcknowledged(false);
    try {
      const result = await query.refetch(); tenant.assertCurrent();
      if (result.error || !result.data) throw result.error || new Error('Current certificate links could not be loaded.');
      if (!alive.current) return;
      setBlocked(false); setClock(Date.now());
      setNotice(confirmed
        ? 'Previously confirmed revocation is not being repeated. Current link metadata was refreshed; links issued after that operation are a separate set.'
        : 'The current full-set version and total were reloaded. The reason is retained. A previous request may have committed; zero remaining links does not independently confirm that your reason was recorded. Review and explicitly confirm again only if links remain.');
    } catch (failure) { if (alive.current) { setError(failure.message); setBlocked(true); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const close = () => {
    if (pending.current || disabled) return;
    if (dirty && !window.confirm(`${blocked && attempted.current && !confirmed ? 'The last write may have committed. ' : ''}Discard only this local link-revocation reason/confirmation and close? Certificate template and issuance drafts are unchanged; no automatic retry will occur.`)) return;
    callbacks.current.onClose();
  };
  const unchanged = !!data && !!confirmation && data.version === confirmation.version && data.total === confirmation.total;
  return <section className="rounded-lg border p-4 space-y-4">
    <div className="flex flex-wrap justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold">Private certificate link access</h3><p className="awards-help break-words mt-2">Issued certificate: {issue.id} · issued {issue.created_at}</p></div><Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={close}>Close link controls</Button></div>
    <p className="text-sm">Revocation disables every currently unrevoked bearer link for this issued certificate, including expired links, and pending sends relying on them. The issued PDF and authenticated member access remain intact. This does not recall messages already delivered. Raw access URLs and tokens are never displayed.</p>
    <p className="awards-help">Unexpired means usable by expiry date only; the server still checks access/release authority. Link expiry is evaluated against the browser clock; server time remains authoritative.</p>
    <Button type="button" size="sm" variant="outline" disabled={busy || disabled || !available || query.isFetching} onClick={reconcile}>Reconcile current links (keep reason)</Button>
    {!available ? <p role="alert" className="awards-help">Reload the complete certificate library before reviewing or revoking links. Local revocation inputs are retained.</p>
      : query.isFetching || query.isPending ? <div aria-label="Loading certificate link metadata" className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div>
        : query.isError ? <p role="alert" className="text-sm text-red-700">{query.error.message} Previous link data was cleared. Reconcile before another confirmation.</p>
          : data && <>
            <p className="text-sm font-medium">{data.total} unrevoked links in the complete server set, including expired links. This total is not the number on this page.</p>
            {!data.total ? <div className="rounded-lg border border-dashed p-4 awards-help">No unrevoked links remain in the current server set. No revocation request will be sent.</div>
              : page > pages ? <div className="space-y-2"><p className="awards-help">This page is no longer in range. No previous rows are shown.</p><Button type="button" size="sm" variant="outline" disabled={busy || disabled} onClick={() => setPage(1)}>Load first link page</Button></div>
                : <ul className="divide-y">{data.links.map(row => <li key={row.id} className="py-3 text-sm space-y-1"><p className="break-words awards-help">Link record: {row.id}</p><p>{Date.parse(row.expiresAt) <= clock ? 'Expired' : 'Unexpired — usable by date'} · expires {dateLabel(row.expiresAt)}</p></li>)}</ul>}
            {data.total > 0 && <nav aria-label="Certificate link pages" className="flex flex-wrap justify-between items-center gap-3"><Button type="button" size="sm" variant="outline" disabled={page <= 1 || busy || disabled || !!confirmation} onClick={() => setPage(value => value - 1)}>Previous link page</Button><span className="awards-help">Requested page {page} · {pages} pages · up to 50 records per page</span><Button type="button" size="sm" variant="outline" disabled={page >= pages || page >= 10000 || busy || disabled || !!confirmation} onClick={() => setPage(value => value + 1)}>Next link page</Button></nav>}
            {pages > 10000 && <p role="alert" className="awards-help">The server limits browsing to 10,000 pages. The full-set total and version still cover all links; a revocation includes links outside browsable pages.</p>}
          </>}
    <div className="awards-field"><Label htmlFor="certificate-link-revocation-reason">Link-revocation reason (required)</Label><Textarea id="certificate-link-revocation-reason" maxLength={2000} rows={4} disabled={busy || disabled || !!confirmation} readOnly={!!confirmed} value={reason} onChange={event => setReason(event.target.value)} /></div>
    {!confirmed && <Button type="button" variant="outline" disabled={!canReview || !reason.trim() || reason.length > 2000} onClick={() => {
      if (!canReview || !reason.trim() || reason.length > 2000) return;
      tenant.assertCurrent(); setError(''); setAcknowledged(false);
      setConfirmation({ issueId: issue.id, version: data.version, total: data.total, reason: reason.trim() });
    }}>Review revocation of the complete link set…</Button>}
    {confirmed && <p role="status" className="text-sm">Server confirmed {confirmed.revokedCount} links revoked. Issued PDF and authenticated member access were retained. This confirmation describes that operation, not any links created later. Close and reopen these controls to authorise another separate revocation.</p>}
    {blocked && <p role="alert" className="text-sm text-amber-900">Writes are blocked until current link metadata is explicitly reconciled. A failed or ambiguous response is never automatically retried; your reason is retained.</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="awards-help">{notice}</p>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !pending.current) { setConfirmation(null); setAcknowledged(false); } }}>
      <DialogContent className="awards-workspace max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Revoke all private links for this certificate?</DialogTitle><DialogDescription>This revokes the entire server-versioned unrevoked set, not just the visible page. It does not revoke the issued PDF or authenticated member access.</DialogDescription></DialogHeader>
        {confirmation && <div className="space-y-4">
          <p className="text-sm font-semibold">All {confirmation.total} unrevoked links will be revoked, including expired links and links on other pages.</p>
          <p className="awards-help break-words">Issued certificate: {confirmation.issueId}</p>
          <p className="text-sm whitespace-pre-wrap break-words">Reason: {confirmation.reason}</p>
          <p className="text-sm">Bearer access and pending sends relying on these links will stop working. Previously delivered messages cannot be recalled. The issued certificate and authenticated member download remain intact.</p>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy || disabled} onChange={event => setAcknowledged(event.target.checked)} /><span>I explicitly authorise revoking ALL {confirmation.total} links in this exact reviewed server set, not just the current page.</span></label>
          {(!ready || !unchanged) && <p role="alert" className="text-sm text-red-700">Current link metadata no longer confirms this exact set. Return to the retained reason and reconcile; no write is allowed.</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { setConfirmation(null); setAcknowledged(false); }}>Return (keep reason)</Button><Button type="button" variant="destructive" disabled={busy || disabled || blocked || !!confirmed || !ready || !unchanged || !acknowledged} onClick={async () => {
            if (pending.current || disabled || blocked || confirmed || !ready || !unchanged || !acknowledged) return;
            pending.current = true; attempted.current = true; setBusy(true); setError(''); setNotice('');
            let saved = null;
            try {
              const result = await certificateRequest(tenant, '/api/awards/certificates', { body: { command: 'revoke_links', issueId: confirmation.issueId, version: confirmation.version, reason: confirmation.reason } });
              if (result.revoked !== true || !Number.isSafeInteger(result.revokedCount) || result.revokedCount < 0) throw new Error('The server did not confirm certificate-link revocation.');
              saved = result; tenant.assertCurrent();
              if (!alive.current) return;
              setConfirmed(result); setBlocked(true); setConfirmation(null); setAcknowledged(false);
              queryClient.setQueriesData({ queryKey: scope }, () => null);
              queryClient.invalidateQueries({ queryKey: ['award-audit-history', tenant.scopeKey, awardId] });
              if (result.revokedCount !== confirmation.total) throw new Error('The confirmed revoked count differs from the reviewed total. Reconcile current metadata; do not repeat this mutation.');
              const refreshed = await query.refetch(); tenant.assertCurrent();
              if (refreshed.error || !refreshed.data) throw refreshed.error || new Error('Current link metadata could not be refreshed.');
              if (alive.current) { setBlocked(false); setNotice('Revocation confirmed and current link metadata refreshed. No template, issuance or recipient-release changes were made.'); }
            } catch (failure) {
              if (alive.current) {
                queryClient.setQueriesData({ queryKey: scope }, () => null);
                setBlocked(true); setConfirmation(null); setAcknowledged(false);
                setError(saved ? `Revocation of ${saved.revokedCount} links was confirmed, but reconciliation is required: ${failure.message}. Do not repeat the write.`
                  : `${failure.message} The request may have committed. The reason is retained; reconcile current metadata before any new explicit confirmation.`);
              }
            } finally { pending.current = false; if (alive.current) setBusy(false); }
          }}>{busy ? 'Awaiting server confirmation…' : `Revoke all ${confirmation.total} links`}</Button></DialogFooter>
        </div>}
      </DialogContent>
    </Dialog>
  </section>;
}
