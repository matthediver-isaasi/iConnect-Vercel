import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

const STATUS_LABELS = {
  delivered: "Delivered",
  awaiting_confirmation: "Awaiting confirmation",
  bounced_or_failed: "Bounced / delivery failed",
  not_sent: "Not sent (send error)",
  sending: "Sending",
};

export const OPENS_NOTE = "Opens are tracking-image requests and may include privacy preloading; some opens are not reported.";

const formatDate = (value) => (value ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const formatDateTime = (value) => (value ? new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

// Loads per-email-setting counts for one event. Read-only: never sends.
export function useEventEmailDeliveryStats(eventId) {
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const [reloadKey, setReloadKey] = useState(0);
  const request = useRef(0);
  const reload = useCallback(() => setReloadKey(k => k + 1), []);
  useEffect(() => {
    const id = ++request.current;
    if (!eventId) { setState({ loading: false, error: null, data: null }); return undefined; }
    setState(prev => ({ ...prev, loading: true, error: null }));
    fetch(`/api/event-emails/${eventId}/stats`, { credentials: "include" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (id !== request.current) return;
        if (!response.ok) setState({ loading: false, error: body.error || `Stats unavailable (${response.status})`, data: null });
        else setState({ loading: false, error: null, data: body });
      })
      .catch((err) => { if (id === request.current) setState({ loading: false, error: err.message || "Network error", data: null }); });
    return () => { request.current++; };
  }, [eventId, reloadKey]);
  return { ...state, reload };
}

export function EventEmailDeliveryStatsRow({ email, eventId, statsState, onShowRecipients }) {
  const testId = `email-delivery-stats-${email.id}`;
  if (!eventId || email.isNew) {
    return <p className="text-xs text-slate-500 mb-3" data-testid={testId}>Delivery stats appear after this email is saved and sent.</p>;
  }
  if (statsState?.loading && !statsState?.data) {
    return <p className="text-xs text-slate-500 mb-3 flex items-center gap-1" data-testid={testId}><Loader2 className="h-3 w-3 animate-spin" /> Loading delivery stats…</p>;
  }
  if (statsState?.error) {
    return <p className="text-xs text-slate-500 mb-3" data-testid={testId}>Delivery stats unavailable: {statsState.error}</p>;
  }
  const trackingStartedAt = statsState?.data?.trackingStartedAt || null;
  const counts = statsState?.data?.emails?.[email.id] || null;
  const createdBeforeTracking = trackingStartedAt && (!email.created_at || new Date(email.created_at) < new Date(trackingStartedAt));
  const trackingNote = createdBeforeTracking
    ? <p className="text-slate-500" data-testid={`text-tracking-started-${email.id}`}>Tracking started on {formatDate(trackingStartedAt)}. Emails sent before then are not counted.</p>
    : null;
  if (!counts || counts.total === 0) {
    return <div className="text-xs space-y-1 mb-3" data-testid={testId}>
      <p className="text-slate-500">No tracked sends yet.</p>
      {trackingNote}
    </div>;
  }
  return <div className="text-xs space-y-1 mb-3 whitespace-normal" data-testid={testId}>
    <p>
      <span data-testid={`text-email-sent-${email.id}`}>{counts.sent.toLocaleString()} sent (accepted)</span>
      {" · "}<span data-testid={`text-email-delivered-${email.id}`}>{counts.delivered.toLocaleString()} delivered</span>
      {" · "}<span data-testid={`text-email-awaiting-${email.id}`}>{counts.awaiting.toLocaleString()} awaiting confirmation</span>
      {" · "}<span data-testid={`text-email-opened-${email.id}`}>{counts.opened.toLocaleString()} tracking-image recipients</span>
      {" · "}<span data-testid={`text-email-failed-${email.id}`}>{counts.failed.toLocaleString()} failed</span>
      {" · "}<button type="button" className="underline font-medium" onClick={() => onShowRecipients?.(email)} data-testid={`button-email-recipients-${email.id}`}>View recipients</button>
    </p>
    <p className="text-slate-500">Sent means accepted by the provider, not confirmed delivery; provider-accepted emails without delivery confirmation are shown as awaiting confirmation. {OPENS_NOTE}</p>
    {trackingNote}
  </div>;
}

const PAGE_SIZE = 25;

export const MAX_RESEND_SELECTION = 25;

function statusLabel(r) {
  const label = STATUS_LABELS[r.status] || r.status;
  if (r.resent) return `${label} · resent`;
  return label;
}

// Admin-only, explicit resend of failed / not-sent rows. Never triggered
// automatically: the admin selects rows and confirms before anything is sent.
export function EventEmailRecipientsDialog({ eventId, email, onClose, onResent }) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [resend, setResend] = useState({ running: false, error: null, summary: null });
  const request = useRef(0);
  useEffect(() => { setPage(1); setSelected(new Set()); setResend({ running: false, error: null, summary: null }); }, [email?.id]);
  useEffect(() => {
    if (!email || !eventId) return undefined;
    const id = ++request.current;
    setState(prev => ({ ...prev, loading: true, error: null }));
    fetch(`/api/event-emails/${eventId}/stats?emailId=${encodeURIComponent(email.id)}&page=${page}&pageSize=${PAGE_SIZE}`, { credentials: "include" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (id !== request.current) return;
        if (!response.ok) setState({ loading: false, error: body.error || `Unable to load recipients (${response.status})`, data: null });
        else {
          setState({ loading: false, error: null, data: body });
          // Drop selections that are no longer resendable after a reload.
          const allowed = new Set((body.recipients || []).filter(r => r.resendable).map(r => r.id));
          setSelected(prev => new Set([...prev].filter(x => allowed.has(x))));
        }
      })
      .catch((err) => { if (id === request.current) setState({ loading: false, error: err.message || "Network error", data: null }); });
    return () => { request.current++; };
  }, [eventId, email, page, reloadKey]);

  const recipients = state.data?.recipients || [];
  const resendableOnPage = recipients.filter(r => r.resendable);
  const allPageSelected = resendableOnPage.length > 0 && resendableOnPage.every(r => selected.has(r.id));
  const toggle = (id, on) => setSelected(prev => {
    const next = new Set(prev);
    if (on) { if (next.size < MAX_RESEND_SELECTION) next.add(id); } else next.delete(id);
    return next;
  });
  const togglePage = (on) => setSelected(prev => {
    const next = new Set(prev);
    for (const r of resendableOnPage) {
      if (on) { if (next.size < MAX_RESEND_SELECTION) next.add(r.id); } else next.delete(r.id);
    }
    return next;
  });
  const selectedRows = recipients.filter(r => selected.has(r.id));
  const anyNotSent = selectedRows.some(r => r.status === "not_sent");

  async function runResend() {
    setConfirming(false);
    setResend({ running: true, error: null, summary: null });
    try {
      const response = await fetch(`/api/event-emails/${eventId}/resend`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailId: email.id, deliveryIds: [...selected], confirm: true }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setResend({ running: false, error: body.error || `Resend failed (${response.status})`, summary: null }); return; }
      setResend({ running: false, error: null, summary: body });
      setSelected(new Set());
      setPage(1);
      setReloadKey(k => k + 1);
      onResent?.();
    } catch (err) {
      setResend({ running: false, error: err.message || "Network error", summary: null });
    }
  }

  const total = state.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const problems = (resend.summary?.results || []).filter(r => r.outcome !== "sent");
  return <Dialog open={Boolean(email)} onOpenChange={(open) => { if (!open && !resend.running) onClose(); }}>
    <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
      <DialogHeader>
        <DialogTitle>Email recipients</DialogTitle>
        <DialogDescription>{email?.subject || "Untitled email"} — tracked sends, newest first. {OPENS_NOTE}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-slate-500" data-testid="text-resend-hint">Select bounced, failed or not-sent rows to resend. Delivered and awaiting rows cannot be resent.</span>
        <Button type="button" size="sm" disabled={selected.size === 0 || resend.running} onClick={() => setConfirming(true)} data-testid="button-resend-selected">
          {resend.running ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Resending…</> : `Resend to ${selected.size} selected`}
        </Button>
      </div>
      {resend.error && <p role="alert" className="text-sm text-red-600" data-testid="text-resend-error">{resend.error}</p>}
      {resend.summary && <div className="text-sm rounded border border-slate-200 p-2 space-y-1" data-testid="text-resend-summary">
        <p>{resend.summary.sent} resent{resend.summary.queued ? ` · ${resend.summary.queued} queued` : ""}{resend.summary.failed ? ` · ${resend.summary.failed} failed` : ""}{resend.summary.skipped ? ` · ${resend.summary.skipped} not resent` : ""}. New sends appear at the top of the list.</p>
        {problems.length > 0 && <ul className="list-disc pl-5 text-slate-600">
          {problems.map(r => <li key={r.deliveryId}>{r.email || "Recipient"}: {r.reason || (r.outcome === "failed" ? "Send failed" : "Not resent")}</li>)}
        </ul>}
      </div>}
      <div className="flex-1 overflow-y-auto" data-testid="event-email-recipients">
        {state.loading && <p className="text-sm text-slate-500 flex items-center gap-2 p-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading recipients…</p>}
        {state.error && <p role="alert" className="text-sm text-red-600 p-2">{state.error}</p>}
        {!state.loading && !state.error && recipients.length === 0 && <p className="text-sm text-slate-500 p-2">No tracked sends yet.</p>}
        {!state.loading && !state.error && recipients.length > 0 && <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500 border-b">
            <th className="py-2 pr-2 w-8">
              <Checkbox aria-label="Select all resendable rows on this page" checked={allPageSelected} disabled={resendableOnPage.length === 0 || resend.running}
                onCheckedChange={(v) => togglePage(v === true)} data-testid="checkbox-resend-page" />
            </th>
            <th className="py-2 pr-2">Recipient</th><th className="py-2 pr-2">Sent</th><th className="py-2 pr-2">Status</th><th className="py-2 pr-2">Opened</th><th className="py-2">Failure reason</th>
          </tr></thead>
          <tbody>{recipients.map(r => <tr key={r.id} className="border-b align-top" data-testid={`row-email-recipient-${r.id}`}>
            <td className="py-2 pr-2">
              {r.resendable
                ? <Checkbox aria-label={`Select ${r.email} for resend`} checked={selected.has(r.id)} disabled={resend.running || (!selected.has(r.id) && selected.size >= MAX_RESEND_SELECTION)}
                    onCheckedChange={(v) => toggle(r.id, v === true)} data-testid={`checkbox-resend-${r.id}`} />
                : null}
            </td>
            <td className="py-2 pr-2 break-all">{r.email}{r.isResend && <span className="block text-xs text-slate-500">Admin resend</span>}</td>
            <td className="py-2 pr-2 whitespace-nowrap">{formatDateTime(r.sentAt || r.attemptedAt)}</td>
            <td className="py-2 pr-2" title={r.resendBlockedReason || undefined}>{statusLabel(r)}</td>
            <td className="py-2 pr-2">{r.opened ? "Yes" : "—"}</td>
            <td className="py-2 text-slate-600 break-words">{r.failureReason || "—"}</td>
          </tr>)}</tbody>
        </table>}
      </div>
      {pages > 1 && <div className="flex items-center justify-between pt-2 text-sm">
        <span className="text-slate-500">Page {page} of {pages} · {total.toLocaleString()} sends{selected.size ? ` · ${selected.size} selected` : ""}</span>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={page <= 1 || state.loading} onClick={() => setPage(p => p - 1)}>Previous</Button>
          <Button type="button" variant="outline" size="sm" disabled={page >= pages || state.loading} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      </div>}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resend this email to {selected.size} {selected.size === 1 ? "recipient" : "recipients"}?</AlertDialogTitle>
            <AlertDialogDescription>
              “{email?.subject || "Untitled email"}” will be sent again now using the current email content. Each resend is tracked as a new send. Recipients whose booking was cancelled or who are no longer eligible will be skipped.
              {anyNotSent ? " Some selected rows had a send error; in rare cases the original may still arrive, so the recipient could receive it twice." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-resend-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runResend} data-testid="button-resend-confirm">Resend</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogContent>
  </Dialog>;
}
