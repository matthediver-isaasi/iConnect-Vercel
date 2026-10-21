import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CalendarDays, Lock } from "lucide-react";
import { adminFetch } from "@/lib/adminFetch";
import { directDebitPolicyText, directDebitFirstCollectionText, directDebitCollectionPolicy } from "@/lib/directDebitConsentSummary";

const endpoint = "/api/membership/member-start";
const dateLabel = value => {
  if (!value) return "Not supplied";
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? "Not supplied" : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const money = (value, currency) => {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "Not supplied";
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(Number(value)); }
  catch { return `${Number(value).toFixed(2)} ${currency || "(currency not supplied)"}`; }
};
const modeLabel = mode => ({ stripe_upfront: "Card — one-off payment", stripe_monthly: "Card — monthly payments", direct_debit: "Direct Debit — monthly payments", invoice: "Invoice — payment remains outstanding", free: "Free — zero-value membership" })[mode] || mode;
const supportedModes = ["stripe_upfront", "stripe_monthly", "direct_debit", "invoice", "free"];
const monthlyMode = mode => ["stripe_monthly", "direct_debit"].includes(mode);
const dynamicOffer = (offer, mode) => mode === "direct_debit" && directDebitCollectionPolicy(offer)?.pricing_policy === "dynamic";
const completeOffer = (offer, mode) => {
  if (!offer || !/^[A-Z]{3}$/.test(offer.currency || "") || !offer.activationRule) return false;
  const dynamic = dynamicOffer(offer, mode);
  const required = dynamic ? ["monthlyAmount"] : ["monthlyAmount", "instalmentCount", "planTotal"];
  return required.every(key => offer[key] != null && offer[key] !== "" && Number.isFinite(Number(offer[key])) && Number(offer[key]) > 0) &&
    (dynamic || Number.isInteger(Number(offer.instalmentCount)));
};
function paymentOptions(source) {
  if (Array.isArray(source?.paymentOptions)) return source.paymentOptions.filter(item => supportedModes.includes(item.mode));
  return (Array.isArray(source?.paymentModes) ? source.paymentModes : []).filter(mode => supportedModes.includes(mode)).map(mode => ({ mode, available: true, reason: null }));
}
function AuthorizationLink({ request, paymentUrl }) {
  const [message, setMessage] = useState("");
  const url = request?.paymentUrl || paymentUrl;
  // Only server-issued local member links are accepted, never provider URLs.
  if (!url || !/^\/(?:membership-fees\/[^/?#]+|MembershipFeePayment\?token=[^#]+)$/i.test(url)) return null;
  return <div className="space-y-2">
    <p>The member must open this saved authorization link and complete the selected payment method themselves. Creating this request does not collect payment or supply the member’s consent.</p>
    <a className="underline break-all" href={url} target="_blank" rel="noreferrer">Open member authorization link</a>
    <p className="break-all">{url}</p>
    <Button type="button" variant="outline" onClick={async () => {
      try { await navigator.clipboard.writeText(new URL(url, window.location.origin).href); setMessage("Authorization link copied."); }
      catch { setMessage("Unable to copy the link. Select and copy the displayed link instead."); }
    }}>Copy member authorization link</Button>
    {message && <p role="status">{message}</p>}
  </div>;
}
function RequestState({ request }) {
  return <div className="space-y-1">
    <p>Request status: {request?.status || "Not supplied"}{request?.paymentMode ? ` · ${modeLabel(request.paymentMode)}` : ""}</p>
    {request?.status === "awaiting_member_authorization" && <p>Awaiting member authorization — no payment is confirmed. The member must authorize their saved payment choice.</p>}
    {request?.status === "pending_payment" && <p>Payment is pending. Authorization or a saved payment plan is not evidence of settlement.</p>}
    <p className="text-muted-foreground">The saved request is the immutable authority for its payment method, term and pricing policy. Dynamic collections follow the saved policy; the initial quote is not a fixed future charge.</p>
  </div>;
}
function QuoteDetails({ quote }) {
  if (!quote) return null;
  const dynamic = dynamicOffer(quote.paymentOffer, quote.paymentMode);
  return <div className="space-y-3 text-sm">
    <p>Tier: {quote.tierLabel || (quote.bandId == null ? "Flat price" : "Not supplied")}</p>
    <p>Term: {dateLabel(quote.termStart)} – {dateLabel(quote.termEnd)}</p>
    <p>Membership year: {quote.membershipYear || "Not supplied"}</p>
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
      {[["annualCost", "Base fee"], ["finalCost", dynamic ? "Initial quoted net fee (not a fixed term total)" : "Net fee for this term"], ["vatAmount", "VAT"], ["totalWithVat", dynamic ? "Initial quote including VAT (not a guaranteed total)" : "Total including VAT"]].map(([key, label]) => <div key={key}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{money(quote[key], quote.currency)}</dd></div>)}
    </dl>
    <p>Payment: {modeLabel(quote.paymentMode)}</p>
    {monthlyMode(quote.paymentMode) && <div className="space-y-1">
      {completeOffer(quote.paymentOffer, quote.paymentMode) ? <>
        {dynamic ? <>
          <p>Current monthly price (variable): {money(quote.paymentOffer.monthlyAmount, quote.paymentOffer.currency)}</p>
          <p>No guaranteed plan total or fixed instalment count is quoted for dynamic collections.</p>
        </> : <p>{quote.paymentOffer.instalmentCount} monthly payments of {money(quote.paymentOffer.monthlyAmount, quote.paymentOffer.currency)} · Plan total: {money(quote.paymentOffer.planTotal, quote.paymentOffer.currency)}</p>}
        <p>Activation rule: {quote.paymentOffer.activationRule}</p>
        {typeof quote.paymentOffer.autoRenew === "boolean" && <p>{quote.paymentOffer.autoRenew ? "Automatic renewal is enabled in the saved offer." : "Automatic renewal is not enabled in the saved offer."}</p>}
        {quote.paymentMode === "direct_debit" && <>
          <p>First collection: {quote.paymentOffer.firstCollectionRule ? directDebitFirstCollectionText(quote.paymentOffer) : "Not supplied"}.</p>
          <p>{directDebitPolicyText(quote.paymentOffer)}</p>
        </>}
      </> : <p role="alert">The server has not supplied complete monthly payment terms. Request a fresh preview before continuing.</p>}
    </div>}
    <p className="text-muted-foreground">{quote.paymentMode === "invoice" ? "Invoice does not mean paid. Accounting processing and verified settlement are separate; no card or Direct Debit payment is collected here." : quote.paymentMode === "free" ? "A free membership can be created only when the server confirms a zero total." : "The member must authorize payment using their saved link. No card or Direct Debit consent is recorded here, and authorization alone does not mean paid."}</p>
  </div>;
}
function Blockers({ items = [] }) {
  if (!items.length) return null;
  return <ul className="list-disc pl-5 text-sm space-y-1" role="alert">
    {items.map((item, index) => <li key={index}>{typeof item === "string" ? item : item.message || item.code || "Unavailable following server validation."}</li>)}
  </ul>;
}
async function readResponse(response) {
  let body;
  try { body = await response.json(); }
  catch { throw new Error("The server response could not be read. No outcome has been confirmed."); }
  if (!response.ok) {
    const error = new Error(body?.error?.message || (typeof body?.error === "string" ? body.error : null) || body?.message || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = body?.code || body?.error?.code;
    throw error;
  }
  return body;
}

export default function MemberMembershipStart({ memberId, tenantId }) {
  if (!memberId) return null;
  if (!tenantId) return <Card data-testid="member-membership-start">
    <CardHeader><CardTitle className="text-base">Start / Renew membership</CardTitle></CardHeader>
    <CardContent role="status">Membership creation is unavailable until the member’s tenant has loaded. If this persists, reload the member page.</CardContent>
  </Card>;
  return <StartPanel key={`${tenantId}:${memberId}`} memberId={memberId} tenantId={tenantId} />;
}

function StartPanel({ memberId, tenantId }) {
  const queryClient = useQueryClient();
  const generation = useRef(0);
  const sending = useRef(false);
  useEffect(() => () => { generation.current += 1; }, []);
  const storageKey = `membership-start:${tenantId}:${memberId}`;
  const [attempt, setAttempt] = useState(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      return stored?.memberId === memberId && stored?.action === "create" && stored?.idempotencyKey && stored?.expectedQuote ? stored : null;
    } catch { return null; }
  });
  const [attemptQuote, setAttemptQuote] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(`${storageKey}:review`) || "null"); }
    catch { return null; }
  });
  const [form, setForm] = useState({ configId: "", bandId: "", startDate: "", reason: "" });
  const [preview, setPreview] = useState(null);
  const [paymentMode, setPaymentMode] = useState("");
  const [pending, setPending] = useState(null);
  const [requestError, setRequestError] = useState("");
  const [saved, setSaved] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [recoveryTarget, setRecoveryTarget] = useState(null);
  const queryKey = ["member-start", tenantId, memberId];
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey,
    queryFn: async () => readResponse(await adminFetch(`${endpoint}?memberId=${encodeURIComponent(memberId)}`, {}, tenantId)),
    retry: false,
  });
  const structures = Array.isArray(data?.structures) ? data.structures : [];
  const selected = structures.find(item => String(item.id) === form.configId);
  const bands = Array.isArray(selected?.bands) ? selected.bands : [];
  const isFlat = selected?.pricing_model === "flat";
  const blockers = Array.isArray(data?.blockers) ? data.blockers : [];
  const requests = Array.isArray(data?.requests) ? data.requests : [];
  const selectedBand = bands.find(item => String(item.id) === form.bandId);
  const optionSource = selectedBand && (Array.isArray(selectedBand.paymentOptions) || Array.isArray(selectedBand.paymentModes)) ? selectedBand : selected;
  const options = paymentOptions(optionSource);
  const modes = options.filter(item => item.available && !(item.mode === "invoice" && data?.capabilities?.invoiceAvailable === false)).map(item => item.mode);
  const hasOptions = structures.some(item => paymentOptions(item).length || item.bands?.some(band => paymentOptions(band).length));
  const canPreview = !isError && !!data && !blockers.length && !!hasOptions;
  const valid = !!(form.configId && (isFlat || form.bandId) && form.startDate && form.reason.trim() && modes.includes(paymentMode));
  const locked = !!pending || !!attempt || !!saved;
  const quote = preview?.quote;
  const completeQuote = !!quote && ["annualCost", "finalCost", "vatAmount", "totalWithVat"].every(key =>
    (dynamicOffer(quote.paymentOffer, paymentMode) && quote[key] == null) ||
    (quote[key] != null && quote[key] !== "" && Number.isFinite(Number(quote[key])) && Number(quote[key]) >= 0)
  ) && /^[A-Z]{3}$/.test(quote.currency || "") && /^\d{4}-\d{2}-\d{2}$/.test(quote.termStart || "") && /^\d{4}-\d{2}-\d{2}$/.test(quote.termEnd || "") &&
    quote.configId === form.configId && (quote.bandId || null) === (isFlat ? null : form.bandId) &&
    quote.paymentMode === paymentMode && (paymentMode !== "free" || Number(quote.totalWithVat) === 0) &&
    (!monthlyMode(paymentMode) || completeOffer(quote.paymentOffer, paymentMode));
  const canCreate = canPreview && valid && preview?.canCreate === true && !!preview?.expectedQuote && completeQuote &&
    (paymentMode !== "invoice" || data?.capabilities?.invoiceAvailable !== false);

  function edit(field, value) {
    generation.current += 1;
    setForm(previous => ({ ...previous, [field]: value, ...(field === "configId" ? { bandId: "" } : {}) }));
    setPreview(null);
    setRequestError("");
  }
  useEffect(() => {
    if (paymentMode && !modes.includes(paymentMode)) {
      generation.current += 1;
      setPaymentMode("");
      setPreview(null);
    }
  }, [JSON.stringify(modes), paymentMode]);
  function openConfirmation(target = null) {
    setRecoveryTarget(target);
    setAcknowledged(false);
    setConfirmOpen(true);
  }
  async function submit(action) {
    const recovering = action === "resume";
    const retrying = action === "create" && !!attempt;
    if (sending.current || (!recovering && saved) || (!recovering && !retrying && (!valid || !canPreview || !!attempt))) return;
    if (action === "create" && (!acknowledged || !confirmOpen || (!retrying && !canCreate))) return;
    if (recovering && (!acknowledged || !confirmOpen || !recoveryTarget?.id || recoveryTarget.canResume !== true || !!attempt || isError)) return;
    const token = ++generation.current;
    sending.current = true;
    setPending(action);
    setRequestError("");
    if (recovering) setSaved(null);
    if (action === "preview") setPreview(null);
    try {
      let payload = { ...form, bandId: isFlat ? null : form.bandId, memberId, action, paymentMode, reason: form.reason.trim() };
      if (recovering) payload = { action: "resume", memberId, requestId: recoveryTarget.id };
      if (action === "create") {
        payload = attempt || { ...payload, expectedQuote: preview.expectedQuote, idempotencyKey: crypto.randomUUID() };
        // Persist before the first POST. A reload must not silently turn an
        // uncertain financial operation into a new request.
        if (!attempt) {
          sessionStorage.setItem(`${storageKey}:review`, JSON.stringify(quote));
          setAttemptQuote(quote);
        }
        sessionStorage.setItem(storageKey, JSON.stringify(payload));
        setAttempt(payload);
      }
      const result = await readResponse(await adminFetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, tenantId));
      if (generation.current !== token) return;
      if (action === "preview") {
        if (typeof result?.canCreate !== "boolean") throw new Error("The server did not return a valid preview. Retry the preview before continuing.");
        setPreview(result);
      } else {
        if (!result?.request?.id) throw new Error("The server did not confirm the request outcome. Retry the original request with the same key.");
        if (recovering && result.request.id !== recoveryTarget.id) throw new Error("The server returned a different request. Recovery has not been confirmed.");
        setOutcome(result);
        setConfirmOpen(false);
        if ((result.record?.id || ["awaiting_member_authorization", "pending_payment", "completed"].includes(result.request.status)) && !result.reconciliation_required) {
          setSaved(result);
          setPreview(null);
          if (!recovering) {
            setAttempt(null);
            try {
              sessionStorage.removeItem(storageKey);
              sessionStorage.removeItem(`${storageKey}:review`);
            } catch { /* A retained key safely replays on reload. */ }
          }
        }
        if (result.record?.id) {
          // A confirmed history row may still need accounting reconciliation.
          // Refresh history without treating the row as a paid membership.
          void queryClient.invalidateQueries({ queryKey: ["member-membership", memberId] });
          void queryClient.invalidateQueries({ queryKey: ["member-amendments", tenantId, memberId] });
        }
        void queryClient.invalidateQueries({ queryKey });
      }
    } catch (failure) {
      if (generation.current === token) {
        setRequestError(failure.message || "Request failed. Please retry.");
        if (action === "create" || recovering) setConfirmOpen(false);
      }
    } finally {
      sending.current = false;
      setPending(null);
    }
  }

  return <Card data-testid="member-membership-start">
    <CardHeader>
      <CardTitle className="text-base flex items-center gap-2"><CalendarDays className="w-4 h-4" />Start / Renew membership</CardTitle>
      <p className="text-sm text-muted-foreground">Create an individual membership term. Review the dates, fees and payment method before confirming. Changes to an existing purchase belong in membership change requests below.</p>
    </CardHeader>
    <CardContent className="space-y-5">
      <div className="rounded-md border bg-muted/50 p-3 text-sm flex items-start gap-2">
        <Lock className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="space-y-1"><p>A preview does not create a membership or collect money. This workflow does not record card or Direct Debit consent on the member’s behalf.</p><p>Payment options are enabled by the selected structure and tier. For card or Direct Debit, share the saved authorization link with the member after creation.</p></div>
      </div>
      {isLoading ? <div role="status" aria-label="Loading membership start options" className="space-y-2">
        <div className="h-5 w-2/3 rounded bg-muted" /><div className="h-20 rounded bg-muted" />
      </div> : isError && !data ? <div role="alert" className="text-sm space-y-2">
        <p>Membership options could not be loaded: {error?.message}</p>
        <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>Retry loading options</Button>
      </div> : <>
        {isError && <div role="alert" className="text-sm space-y-2"><p>Options could not be refreshed: {error?.message}. New requests are unavailable until refreshed.</p><Button variant="outline" onClick={() => refetch()} disabled={isFetching}>Retry loading options</Button></div>}
        <Blockers items={blockers} />
        {!structures.length && <p className="text-sm text-muted-foreground">No eligible individual membership structures are available.</p>}
        {!canPreview && <p className="text-sm text-muted-foreground">Start / Renew preview is unavailable for this member or your current permissions.</p>}
        {selected && !modes.length && <p className="text-sm text-muted-foreground">The server has not enabled any available payment options for this structure / tier.</p>}
        {data?.capabilities?.invoiceAvailable === false && <p role="alert" className="text-sm">Invoice creation is unavailable because the durable membership accounting queue is not enabled. A finance administrator must configure the supported accounting workflow before invoice memberships can be created.</p>}
        {canPreview && <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit("preview"); }}>
          <fieldset disabled={locked} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor={`start-config-${memberId}`}>Membership structure</Label>
              <select id={`start-config-${memberId}`} required className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.configId} onChange={event => edit("configId", event.target.value)}>
                <option value="">Choose a structure</option>
                {structures.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`start-band-${memberId}`}>Membership tier</Label>
              <select id={`start-band-${memberId}`} required={!isFlat} disabled={!selected || locked || isFlat} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.bandId} onChange={event => edit("bandId", event.target.value)}>
                <option value="">{isFlat ? "Flat price — no tier required" : "Choose a tier"}</option>
                {bands.map(item => <option key={item.id} value={item.id}>{item.label || item.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`start-date-${memberId}`}>Membership start date</Label>
              <Input id={`start-date-${memberId}`} required type="date" min={new Date().toISOString().slice(0, 10)} value={form.startDate} onChange={event => edit("startDate", event.target.value)} />
              <p className="text-xs text-muted-foreground">Choose today (UTC) or later. The preview confirms the term and whether this date is eligible.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`start-payment-${memberId}`}>Payment option</Label>
              <select id={`start-payment-${memberId}`} required value={paymentMode} onChange={event => { generation.current += 1; setPaymentMode(event.target.value); setPreview(null); setRequestError(""); }} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="">Choose a supported payment option</option>
                {options.map(item => <option key={item.mode} value={item.mode} disabled={!modes.includes(item.mode)}>{modeLabel(item.mode)}{!modes.includes(item.mode) ? ` — unavailable${item.reason ? `: ${item.reason}` : ""}` : ""}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">Only server-enabled methods can be selected. Free is eligible only for a zero total.</p>
              {options.filter(item => !item.available && item.reason).map(item => <p className="text-xs text-muted-foreground" key={item.mode}>{modeLabel(item.mode)}: {item.reason}</p>)}
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor={`start-reason-${memberId}`}>Reason for start / renewal</Label>
              <Textarea id={`start-reason-${memberId}`} required maxLength={2000} value={form.reason} onChange={event => edit("reason", event.target.value)} placeholder="Record why this membership is being started or renewed" />
            </div>
          </fieldset>
          {!attempt && !saved && <Button type="submit" variant="outline" disabled={!valid || !!pending || !structures.length}>{pending === "preview" ? "Preparing preview…" : "Preview membership"}</Button>}
        </form>}
        {preview && <div data-testid="member-start-preview" className="rounded-md border p-4 space-y-3" aria-live="polite">
          <p className="font-medium">Preview only — no membership created</p>
          {quote && <>
            <p className="text-sm">{selected?.name} · {isFlat ? "Flat price" : bands.find(item => String(item.id) === form.bandId)?.label}</p>
            <QuoteDetails quote={quote} />
          </>}
          <Blockers items={preview.blockers} />
          {quote && !completeQuote && <p role="alert" className="text-sm">The server quote is incomplete or does not match the selected request. Request a fresh preview before confirming.</p>}
          {!preview.expectedQuote && <p className="text-sm text-muted-foreground">A quote fingerprint is required. Request a fresh preview before confirming.</p>}
          <Button type="button" disabled={!canCreate || locked} onClick={() => openConfirmation()}>Review and confirm membership</Button>
        </div>}
      </>}
      {requestError && <div role="alert" className="text-sm space-y-2"><p>{requestError}</p></div>}
      {attempt && !saved && <div className="rounded-md border p-3 space-y-2 text-sm" role="status">
        <p className="font-medium">Previous creation outcome is unconfirmed</p>
        <p>The original request is retained in this tab, including after reload. Fields are locked. Retry the same request to check the outcome without creating a duplicate; do not start another request.</p>
        {outcome && <p>Server request status: {outcome.request?.status || "Not supplied"}. {outcome.reconciliation_required ? "Reconciliation is required. Contact your finance administrator; no successful payment is confirmed." : "Creation has not yet been confirmed. This is not a payment receipt."}</p>}
        <p className="break-all">Request key: {attempt.idempotencyKey}</p>
        <Button variant="outline" disabled={!!pending} onClick={() => openConfirmation()}>Review retry</Button>
      </div>}
      {outcome && !saved && !attempt && <div role="status" className="rounded-md border p-3 text-sm space-y-1">
        <p className="font-medium">Saved request · {outcome.request?.status || "Outcome unconfirmed"}</p>
        <p>{outcome.reconciliation_required ? "Reconciliation is required. Review and recover the same saved request below; do not create another membership." : "The request remains pending. This is not a payment receipt."}</p>
      </div>}
      {saved?.record && <div role="status" className="rounded-md border p-3 text-sm space-y-1">
        <p className="font-medium">Membership record created · {saved.record.id}</p>
        <p>{saved.record.payment_status === "paid" && saved.record.total_with_vat === 0 ? "Zero-value membership recorded — no payment collected." : "Creation is not a payment receipt. Review the recorded payment status in membership history below."}</p>
        <p>Recorded payment status: {saved.record.payment_status || "Not supplied"}.{saved.accounting_pending ? " Accounting processing is pending." : ""}</p>
      </div>}
      {saved && <div role="status" className="rounded-md border p-3 text-sm space-y-2">
        {!saved.record && <p className="font-medium">Membership request saved · {saved.request.id}</p>}
        <RequestState request={saved.request} />
        <AuthorizationLink request={saved.request} paymentUrl={saved.paymentUrl} />
      </div>}
      {!isLoading && <section aria-label="Saved membership start requests" className="space-y-3">
        <h3 className="text-sm font-medium">Saved start / renewal requests</h3>
        {!requests.length ? <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{isError ? "Saved requests could not be confirmed. Retry loading options." : "No start / renewal requests have been recorded in this workflow."}</p> :
          <ol className="space-y-3">{requests.map(item => <li key={item.id} className="rounded-md border p-3 space-y-2 text-sm">
            <p className="font-medium break-all">Request {item.id}</p>
            <p>Request status: {item.status || "Not supplied"} · Payment status: {item.payment_status || "Not supplied"}</p>
            <RequestState request={item} />
            <AuthorizationLink request={item} />
            {item.quote && <QuoteDetails quote={item.quote} />}
            <p className="whitespace-pre-wrap break-words">Reason: {item.reason || "Not supplied"}</p>
            {item.record_id && <p className="break-all">Membership record: {item.record_id}</p>}
            {item.accounting_pending && <p>Accounting processing is pending. This is not evidence of payment.</p>}
            {item.reconciliation_required && <p role="alert">Reconciliation required. Resume only this saved immutable request.</p>}
            {item.canResume === true && <>
              <Button variant="outline" disabled={!!pending || !!attempt || isError} onClick={() => openConfirmation(item)} aria-label={`Review recovery for request ${item.id}`}>Review recovery</Button>
              <p className="text-xs text-muted-foreground">{attempt ? "Resolve the original retained request before recovering another request." : "Recovery uses the saved request, without re-pricing or creating another membership term."}</p>
            </>}
          </li>)}</ol>}
      </section>}
      <Dialog open={confirmOpen} onOpenChange={open => { if (!pending) setConfirmOpen(open); }}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto" hideCloseButton={!!pending} onEscapeKeyDown={event => { if (pending) event.preventDefault(); }} onPointerDownOutside={event => { if (pending) event.preventDefault(); }}>
          <DialogHeader>
            <DialogTitle>{recoveryTarget ? "Recover the saved membership request?" : attempt ? "Retry the original membership request?" : "Confirm membership creation"}</DialogTitle>
            <DialogDescription>{recoveryTarget ? "Resume the server’s immutable saved request. This does not select a new price or create another membership term; accounting or notification recovery may be attempted." : attempt ? "This sends exactly the same request and request key. A previous attempt may already have completed." : "This creates a financial membership record. Confirm only after reviewing the term, amount and payment option."}</DialogDescription>
          </DialogHeader>
          {recoveryTarget ? <div className="text-sm space-y-2">
            <p className="break-all">Request {recoveryTarget.id}</p>
            <QuoteDetails quote={recoveryTarget.quote} />
            <p>Request status: {recoveryTarget.status || "Not supplied"} · Payment status: {recoveryTarget.payment_status || "Not supplied"}</p>
          </div> : attempt ? <div className="text-sm space-y-2">
            <QuoteDetails quote={attemptQuote} />
            {!attemptQuote && <p>The original financial breakdown is unavailable in this tab. This retry submits only the original request; it does not select a new price or initiate a card or Direct Debit payment.</p>}
            <p>Structure ID: {attempt.configId} · Tier ID: {attempt.bandId || "Flat price"}</p>
            <p>Start date: {dateLabel(attempt.startDate)} · {modeLabel(attempt.paymentMode)}</p>
            <p className="whitespace-pre-wrap break-words">Reason: {attempt.reason}</p>
            <p className="break-all">Request key: {attempt.idempotencyKey}</p>
          </div> : <><p className="text-sm font-medium">{selected?.name}</p><QuoteDetails quote={quote} /><p className="text-sm whitespace-pre-wrap break-words">Reason: {form.reason}</p></>}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={acknowledged} disabled={!!pending} onChange={event => setAcknowledged(event.target.checked)} className="mt-1" />
            <span>I have reviewed this request and explicitly authorise {recoveryTarget ? "recovery of this saved request, not a new membership purchase" : attempt ? "retrying the same membership creation request" : "creating this membership with the selected payment option"}.</span>
          </label>
          <DialogFooter>
            <Button variant="outline" disabled={!!pending} onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button disabled={!acknowledged || !!pending} onClick={() => submit(recoveryTarget ? "resume" : "create")}>{pending ? "Submitting membership…" : recoveryTarget ? "Confirm recovery" : attempt ? "Confirm retry" : "Confirm and create membership"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CardContent>
  </Card>;
}
