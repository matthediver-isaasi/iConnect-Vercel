import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FileText, History, Lock } from "lucide-react";
import { adminFetch } from "@/lib/adminFetch";
import MemberMembershipAmendmentLifecycle from "./MemberMembershipAmendmentLifecycle";
import MemberMonthlyMembershipAmendments from "./MemberMonthlyMembershipAmendments";
import MemberUpfrontFinancialChanges from "./MemberUpfrontFinancialChanges";

const endpoint = "/api/membership/member-amendments";
const dateLabel = value => {
  if (!value) return "Not supplied";
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? "Not supplied" : date.toLocaleDateString("en-GB");
};
const timestampLabel = value => {
  if (!value) return "Not supplied";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not supplied" : `${date.toISOString()} (UTC)`;
};
const money = (value, currency) => {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "Not supplied";
  if (!currency) return `${Number(value).toFixed(2)} (currency not supplied)`;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(Number(value));
  } catch {
    return `${Number(value).toFixed(2)} ${currency}`;
  }
};
function Blockers({ items = [] }) {
  if (!items.length) return null;
  return <ul role="alert" className="list-disc pl-5 text-sm text-amber-800 dark:text-amber-300 space-y-1">
    {items.map((item, index) => <li key={index}>{typeof item === "string" ? item : item.message || item.code || "Request blocked by server validation."}</li>)}
  </ul>;
}
function Amounts({ title, amounts, currency }) {
  return <div className="space-y-2">
    <p className="text-sm font-medium">{title}</p>
    <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
      {[["netMinor", "Net"], ["vatMinor", "VAT"], ["grossMinor", "Gross"]].map(([key, label]) => <div key={key}>
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="font-medium">{money(amounts?.[key] == null ? null : amounts[key] / 100, currency)}</dd>
      </div>)}
    </dl>
  </div>;
}
async function readResponse(response) {
  let body;
  try { body = await response.json(); } catch { throw new Error("The server returned an unreadable response. No outcome has been confirmed."); }
  if (!response.ok) {
    const error = new Error(body?.error?.message || (typeof body?.error === "string" ? body.error : null) || body?.message || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = body?.code || body?.error?.code;
    throw error;
  }
  return body;
}

// A new member/tenant always gets a fresh form and isolated request lifecycle.
export default function MemberMembershipAmendments({ memberId, tenantId }) {
  if (!memberId) return null;
  return <AmendmentPanel key={`${tenantId || ""}:${memberId}`} memberId={memberId} tenantId={tenantId} />;
}

function AmendmentPanel({ memberId, tenantId }) {
  const queryClient = useQueryClient();
  const queryKey = ["member-amendments", tenantId, memberId];
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey,
    queryFn: async () => readResponse(await adminFetch(`${endpoint}?memberId=${encodeURIComponent(memberId)}`, {}, tenantId)),
    retry: false,
  });
  const [form, setForm] = useState({ configId: "", bandId: "", effectiveDate: "", reason: "" });
  const [preview, setPreview] = useState(null);
  const [pending, setPending] = useState(null);
  const [requestError, setRequestError] = useState("");
  const [saved, setSaved] = useState(null);
  const attempt = useRef(null);
  const ambiguousSave = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const structures = Array.isArray(data?.structures) ? data.structures : [];
  const history = Array.isArray(data?.history) ? data.history : [];
  const selected = structures.find(item => String(item.id) === form.configId);
  const bands = Array.isArray(selected?.bands) ? selected.bands : [];
  const isFlat = selected?.pricing_model === "flat";
  const blockers = Array.isArray(data?.blockers) ? data.blockers : [];
  const canPreview = data?.capabilities?.preview === true && !blockers.length;
  const valid = !!(form.configId && (isFlat || form.bandId) && form.effectiveDate && form.reason.trim());
  const locked = !!pending || !!attempt.current || !!saved;
  function edit(field, value) {
    generation.current += 1;
    setForm(previous => ({ ...previous, [field]: value, ...(field === "configId" ? { bandId: "" } : {}) }));
    setPreview(null);
    setRequestError("");
  }
  async function submit(action) {
    const retryingCreate = action === "create" && !!attempt.current;
    if (pending || saved || (!retryingCreate && (!valid || !canPreview))) return;
    // `blockers` also describe deferred settlement/application. The server's
    // canCreate grant, not absence of those advisory blockers, permits saving.
    if (action === "create" && !retryingCreate && (data?.capabilities?.create !== true || preview?.canCreate !== true || !preview?.quote || !preview?.expectedQuote)) return;
    const token = ++generation.current;
    setPending(action);
    setRequestError("");
    if (action === "preview") setPreview(null);
    try {
      const payload = { ...form, bandId: isFlat ? null : form.bandId, reason: form.reason.trim(), memberId, settlementChoice: "defer", action };
      if (action === "create") {
        if (!attempt.current) {
          // Retain the exact payload and key even after a timeout or unreadable response.
          attempt.current = { ...payload, expectedQuote: preview.expectedQuote, idempotencyKey: crypto.randomUUID() };
        }
      }
      const result = await readResponse(await adminFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "create" ? attempt.current : payload),
      }, tenantId));
      if (generation.current !== token) return;
      if (action === "preview") {
        if (typeof result?.canCreate !== "boolean") throw new Error("The server did not return a valid preview. Saving is unavailable; retry the preview.");
        setPreview(result);
      } else {
        if (!result?.amendment?.id) throw new Error("The server did not confirm a saved request. Retry with the same request key.");
        setSaved(result.amendment);
        setPreview(null);
        queryClient.setQueryData(queryKey, previous => previous ? {
          ...previous,
          history: [result.amendment, ...(previous.history || []).filter(item => item.id !== result.amendment.id)],
        } : previous);
        // Refresh this panel only; do not change membership or invoice caches.
        void refetch();
      }
    } catch (failure) {
      if (generation.current === token) {
        if (action === "create" && failure.status === 409 && failure.code === "quote_changed" && !ambiguousSave.current) {
          // The service rejects this fingerprint before writing. Discard only
          // this definitively rejected attempt, never a prior uncertain save.
          attempt.current = null;
          setPreview(null);
          setRequestError(`${failure.message} Review a fresh preview before saving; the rejected quote cannot be reused.`);
        } else {
          if (action === "create") ambiguousSave.current = true;
          setRequestError(failure.message || "Request failed. Please retry.");
        }
      }
    } finally {
      if (generation.current === token) setPending(null);
    }
  }
  const current = data?.current;
  const isMonthly = current?.commitment_snapshot?.payment_frequency === "monthly";
  const quote = preview?.quote;
  function updateLifecycle(id, lifecycle) {
    queryClient.setQueryData(queryKey, previous => previous ? {
      ...previous, lifecycle: { ...(previous.lifecycle || {}), [id]: lifecycle },
    } : previous);
    void refetch();
  }
  return <Card data-testid="member-amendments">
    <CardHeader>
      <CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" />Membership change requests</CardTitle>
       <p className="text-sm text-muted-foreground">{isMonthly ? "Preview a retained-term monthly membership change, save its authority, then explicitly approve execution. Preview and saving never change the provider or membership." : "Preview and record an upfront personal membership change, then follow its separate settlement and application history. Saving a proposal does not collect payment, issue a refund, or change entitlement."}</p>
    </CardHeader>
    <CardContent className="space-y-5">
      <div className="rounded-md border bg-muted/50 p-3 text-sm flex items-start gap-2">
        <Lock className="w-4 h-4 shrink-0 mt-0.5" />
         <div className="space-y-1">
           <p>The original paid commitment and consent stay immutable. Settlement evidence and applied membership revisions are recorded separately; the original term and renewal boundary are preserved.</p>
           {data && !isMonthly && <p>{data.capabilities?.invoice === true ? "Additional payment uses a Xero invoice and verified payment evidence." : "Invoice collection is unavailable for this server or your current capabilities."} {data.capabilities?.refund === true ? "Refund support records a manual, bank-reconciled Xero refund; it does not send cash automatically." : "Refund processing is unavailable for this server or your current capabilities."}</p>}
           {data && !isMonthly && data.monthlyExecutionAvailable !== true && data.capabilities?.providerAmendment !== true && <p>Monthly card, fixed Direct Debit and dynamic Direct Debit amendments are not connected to this workflow. No provider change or monthly amendment can be completed here.</p>}
         </div>
      </div>
      {isLoading ? <div role="status" aria-label="Loading membership change requests" className="space-y-2">
        <div className="h-5 w-2/3 rounded bg-muted" /><div className="h-16 rounded bg-muted" />
       </div> : isError && !data ? <div role="alert" className="space-y-2">
        <p className="text-sm">Change requests could not be loaded: {error?.message}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>Retry loading</Button>
      </div> : <>
         {isError && <div role="alert" className="rounded-md border p-3 text-sm space-y-2">
           <p>History could not be refreshed: {error?.message}. Previously loaded records are shown; their latest outcome is not confirmed.</p>
           <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>Retry loading</Button>
         </div>}
         {!isMonthly && <Blockers items={blockers} />}
        {current && <div className="rounded-md border p-3 text-sm space-y-1" data-testid="amendment-original">
          <p className="font-medium">{current.payment_status === "paid" ? "Original paid commitment" : "Original purchase record"} <Badge variant="outline">Read-only</Badge></p>
          <p>{current.commitment_snapshot?.config?.name || current.structureName || "Historical structure"}{current.tier_label ? ` · ${current.tier_label}` : ""}</p>
          <p>Recorded payment status: {current.payment_status === "paid" ? "Paid" : current.payment_status ? String(current.payment_status).replaceAll("_", " ") : "Not supplied"}.</p>
           <p>Original expiry: {dateLabel(current.term_end_date)}. Original renewal: {dateLabel(current.membership_renewal_date)}.</p>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
            <div><dt className="text-muted-foreground">Recorded net</dt><dd>{money(current.final_cost, current.currency)}</dd></div>
            <div><dt className="text-muted-foreground">Recorded VAT</dt><dd>{money(current.vat_amount, current.currency)}</dd></div>
            <div><dt className="text-muted-foreground">Recorded gross</dt><dd>{money(current.total_with_vat, current.currency)}</dd></div>
          </dl>
        </div>}
         {(isMonthly || data?.monthlyChanges?.length > 0) && <MemberMonthlyMembershipAmendments
           memberId={memberId} tenantId={tenantId} data={data} actionsEnabled={!isError}
           readResponse={readResponse} onRefresh={refetch}
         />}
         {!isMonthly && (!canPreview ? <p className="text-sm text-muted-foreground">Preview is unavailable for this member or your current permissions. Existing membership operations are unchanged.</p> :
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit("preview"); }}>
            <fieldset disabled={locked} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor={`amend-config-${memberId}`}>Target membership structure</Label>
                <select id={`amend-config-${memberId}`} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.configId} onChange={event => edit("configId", event.target.value)} required>
                  <option value="">Choose a structure</option>
                  {structures.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`amend-band-${memberId}`}>Target pricing band</Label>
                <select id={`amend-band-${memberId}`} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.bandId} onChange={event => edit("bandId", event.target.value)} disabled={!selected || locked || isFlat} required={!isFlat}>
                  <option value="">{isFlat ? "Flat price — no band" : "Choose a band"}</option>
                  {bands.map(item => <option key={item.id} value={item.id}>{item.label || item.name}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`amend-date-${memberId}`}>Effective date</Label>
                <Input id={`amend-date-${memberId}`} type="date" required value={form.effectiveDate} onChange={event => edit("effectiveDate", event.target.value)} />
                <p className="text-xs text-muted-foreground">Only today (UTC) is supported in this phase. Backdated and scheduled changes are not enabled.</p>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor={`amend-reason-${memberId}`}>Reason for change</Label>
                <Textarea id={`amend-reason-${memberId}`} required maxLength={2000} value={form.reason} onChange={event => edit("reason", event.target.value)} placeholder="Record why this change is being requested" />
              </div>
            </fieldset>
            {!structures.length && <p className="text-sm text-muted-foreground">No eligible target structures are available.</p>}
            {!attempt.current && !saved && <Button type="submit" variant="outline" disabled={!valid || !!pending}>{pending === "preview" ? "Preparing preview…" : "Preview"}</Button>}
          </form>)}
        {preview && !quote && <div className="rounded-md border p-3 space-y-2" aria-live="polite">
          <p className="text-sm font-medium">Preview unavailable — no request has been saved</p>
          <Blockers items={preview.blockers} />
        </div>}
        {quote && <div className="rounded-md border p-4 space-y-3" data-testid="amendment-quote" aria-live="polite">
          <p className="font-medium">Preview only — remaining-term adjustment</p>
          <p className="text-sm text-muted-foreground">Target: {selected?.name} · {isFlat ? "Flat price" : bands.find(item => String(item.id) === form.bandId)?.label || bands.find(item => String(item.id) === form.bandId)?.name}. Effective {dateLabel(form.effectiveDate)}.</p>
          <Amounts title="Original remaining-term value" amounts={quote.originalRemaining} currency={quote.currency} />
          <Amounts title="Target remaining-term value" amounts={quote.targetRemaining} currency={quote.currency} />
          <div className="border-t pt-3"><Amounts title="Remaining-term delta (target less original)" amounts={quote.delta} currency={quote.currency} /></div>
          <p className="text-sm">Remaining days: {quote.proration?.remainingDays ?? "Not supplied"} of {quote.proration?.totalDays ?? "Not supplied"}. Expiry: {dateLabel(quote.term?.endDate || current?.term_end_date)} · unchanged.</p>
          <p className="text-xs text-muted-foreground">Actual remaining UTC days; net and VAT rounded separately to the nearest minor unit.</p>
          <p className="text-xs text-muted-foreground">Positive delta: additional amount to settle. Negative delta: credit to resolve. Neither is charged or refunded by saving.</p>
          {!!preview.blockers?.length && <div className="space-y-1">
            <p className="text-sm font-medium">{preview.canCreate ? "Limitations after saving" : "Request blocked"}</p>
            <Blockers items={preview.blockers} />
          </div>}
           <Button type="button" disabled={!!pending || (!attempt.current && (data?.capabilities?.create !== true || preview.canCreate !== true || !preview.expectedQuote))} onClick={() => submit("create")}>
            {pending === "create" ? "Saving request…" : attempt.current ? "Retry save change request" : "Save change request"}
          </Button>
          {!preview.expectedQuote && <p className="text-xs text-muted-foreground">The server did not supply a quote fingerprint. Preview again before saving.</p>}
          {data?.capabilities?.create !== true && <p className="text-xs text-muted-foreground">Your permissions allow preview only.</p>}
        </div>}
        {requestError && <div role="alert" className="text-sm space-y-1">
          <p>{requestError}</p>
          {attempt.current && <p>The save outcome is unconfirmed. Fields are locked; retry uses the same request key to avoid duplicate requests.</p>}
        </div>}
        {saved && <div role="status" className="rounded-md border p-3 text-sm space-y-1">
          <p className="font-medium">Change request saved · {saved.id}</p>
           <p>Proposal state at creation: {saved.status === "pending_settlement" ? "Pending settlement — no payment or refund has been processed by saving." : saved.status === "pending_application" ? "Pending application — no entitlement has changed by saving." : saved.status || "Not supplied"}.</p>
           <p>Saving does not change membership entitlement or original paid records. Check current settlement and application evidence below, including on a replayed save.</p>
        </div>}
        <section className="space-y-3" aria-label="Amendment history">
          <h3 className="font-medium text-sm flex items-center gap-2"><History className="w-4 h-4" />Amendment history</h3>
          {!history.length ? <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No membership change requests recorded. Original fee and payment history remains below.</div> :
            <ol className="space-y-3">{history.map(item => <li key={item.id} className="rounded-md border p-3 space-y-2 text-sm">
               <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">Request {item.id}</span><Badge variant="outline">Proposal: {item.status === "pending_settlement" ? "Pending settlement" : item.status === "pending_application" ? "Pending application" : item.status || "Status not supplied"}</Badge></div>
               <p>Effective: {dateLabel(item.effective_date || item.request?.effectiveDate)}{item.created_at ? ` · Recorded: ${dateLabel(item.created_at)}` : ""}</p>
              <p className="whitespace-pre-wrap break-words">{item.reason || item.request?.reason || "No reason supplied"}</p>
              {item.quote && <>
                <p>Original: {item.quote.sourceSnapshot?.commitment_snapshot?.config?.name || "Historical structure"}{item.quote.sourceSnapshot?.tier_label ? ` · ${item.quote.sourceSnapshot.tier_label}` : ""}</p>
                 <p>Target: {item.quote.targetSnapshot?.config?.name || "Not supplied"} · {item.quote.targetSnapshot?.band?.label || item.quote.targetSnapshot?.band?.name || (item.quote.targetSnapshot?.config?.pricing_model === "flat" ? "Flat price" : "Band not supplied")}</p>
                <Amounts title="Recorded remaining-term delta" amounts={item.quote.delta} currency={item.quote.currency} />
                <p>Expiry: {dateLabel(item.quote.term?.endDate)} · unchanged by this request.</p>
                <details className="rounded-md bg-muted/50 p-3">
                  <summary className="cursor-pointer font-medium">Financial breakdown and audit evidence</summary>
                  <div className="space-y-3 pt-3">
                    <Amounts title="Original paid full-term value" amounts={item.quote.originalFullTerm} currency={item.quote.currency} />
                    <Amounts title="Original remaining-term value" amounts={item.quote.originalRemaining} currency={item.quote.currency} />
                    <Amounts title="Target remaining-term value" amounts={item.quote.targetRemaining} currency={item.quote.currency} />
                    <p>Remaining days: {item.quote.proration?.remainingDays ?? "Not supplied"} of {item.quote.proration?.totalDays ?? "Not supplied"}.</p>
                    <p className="break-all">Original purchase: {item.source_record_id || item.quote.sourceRecordId || "Not supplied"}</p>
                    <p className="break-all">Recorded by: {item.actor_id || "Not supplied"}</p>
                     <p className="break-all">Recorded at: {timestampLabel(item.created_at)}</p>
                     <p className="break-all">Quote fingerprint: {item.request?.expectedQuote || "Not supplied"}</p>
                     <p className="break-all">Request key: {item.idempotency_key || item.request?.idempotencyKey || "Not supplied"}</p>
                     <p>Proposal snapshot — Settlement: {item.settlement_status === "not_started" ? "Not started — no payment or refund processed at creation" : "Not confirmed by this record"}.</p>
                     <p>Entitlement application: {item.entitlement_applied === false ? "Not applied at creation" : "Not confirmed by this record"}. See separate current lifecycle evidence below.</p>
                  </div>
                </details>
              </>}
               <p className="text-xs text-muted-foreground">Recorded proposal status is immutable; this request is not a payment receipt or evidence of applied entitlement.</p>
               <MemberMembershipAmendmentLifecycle
                 amendment={item}
                 lifecycle={data?.lifecycle?.[item.id]}
                 capabilities={data?.capabilities}
                 eligibleSource={!!current?.id && item.source_record_id === current.id && !item.quote?.sourceSnapshot?.billing_agreement_id && item.quote?.sourceSnapshot?.commitment_snapshot?.payment_frequency === "upfront"}
                 tenantId={tenantId}
                 refreshing={isFetching}
                 actionsEnabled={!isError}
                 readResponse={readResponse}
                 onUpdate={updateLifecycle}
                 onRefresh={refetch}
               />
            </li>)}</ol>}
        </section>
        {(current?.commitment_snapshot?.payment_frequency === "upfront" || data?.financialChanges?.length > 0) && <MemberUpfrontFinancialChanges
          key={`${tenantId || ""}:${memberId}:financial`}
          memberId={memberId} tenantId={tenantId} data={data} actionsEnabled={!isError}
          readResponse={readResponse} onRefresh={refetch}
        />}
      </>}
    </CardContent>
  </Card>;
}
