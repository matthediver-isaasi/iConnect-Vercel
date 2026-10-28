import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { adminFetch } from "@/lib/adminFetch";

const endpoint = "/api/membership/member-amendments";
const date = value => value ? String(value).slice(0, 10) : "Not supplied";
const minorMoney = (value, currency) => {
  if (!Number.isSafeInteger(value) || !currency) return "Not supplied";
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(value / 100); }
  catch { return "Invalid currency — financial review required"; }
};
const message = item => typeof item === "string" ? item : item?.message || item?.code || "Unrecognised financial blocker";
const list = value => Array.isArray(value) ? value : [];
const isApplication = value => !!(value?.operationId && /^\d{4}-\d{2}-\d{2}/.test(value.effectiveDate || "") && /^\d{4}-\d{2}-\d{2}/.test(value.expiresOn || ""));
function financialBlockers(authority) {
  return [...list(authority?.calculation?.finance?.blockers), ...list(authority?.calculation?.blockers)]
    .filter(item => (typeof item === "string" ? item : item?.code) !== "provider_schedule_coordination_required");
}
function supported(authority) {
  const calculation = authority?.calculation;
  const amount = calculation?.version === 3 ? calculation.currentMonthlyPriceMinor : calculation?.futureObligationMinor;
  return authority?.action === "change"
    && authority?.sourceSnapshot?.commitment_snapshot?.payment_frequency === "monthly"
    && calculation?.behaviour === "retain_term" && [2, 3].includes(calculation?.version)
    && Number.isSafeInteger(amount) && amount >= 0 && !!calculation.currency
    && !!authority.sourceSnapshot.membership_renewal_date
    && calculation?.newTerm?.renewalDate === authority.sourceSnapshot.membership_renewal_date
    && !financialBlockers(authority).length;
}
function executableEvidence(authority) {
  return supported(authority) && authority?.monthlyExecution?.version === 1
    && !!authority.monthlyExecution.providerTarget && !!authority.monthlyExecution.providerAuthority;
}
function AuthoritySummary({ authority, operation }) {
  const calculation = authority?.calculation;
  const source = authority?.sourceSnapshot;
  const executionQuote = operation?.prepared?.quote;
  return <div className="space-y-2 text-sm">
    <p>Source: {source?.commitment_snapshot?.config?.name || source?.structureName || "Historical structure"}{source?.tier_label ? ` · ${source.tier_label}` : ""}</p>
    <p>Source term: {date(source?.term_start_date)} to {date(source?.term_end_date)}. Original renewal boundary: {date(source?.membership_renewal_date)} · retained.</p>
    <p>Selected target: {authority?.targetSnapshot?.name || "Not supplied"} · {authority?.targetBandSnapshot?.label || authority?.targetBandSnapshot?.name || (authority?.targetSnapshot?.pricing_model === "flat" ? "Flat price" : "Band not supplied")}</p>
    <p>Effective date: {date(calculation?.effectiveDate)}</p>
    {calculation?.version === 3 ? <>
      <p className="font-medium">Current prospective monthly price: {minorMoney(calculation.currentMonthlyPriceMinor, calculation.currency)}</p>
      <p className="text-muted-foreground">A prospective monthly rate, not a fixed annual total. Future collections remain subject to applicable pricing rules.</p>
    </> : calculation?.version === 2 ? <>
      <p className="font-medium">Future fixed-term obligation: {minorMoney(calculation.futureObligationMinor, calculation.currency)}</p>
      {executionQuote ? <div className="rounded-md bg-muted/50 p-3 space-y-1">
        <p>Execution quote: {minorMoney(executionQuote.amountMinor, executionQuote.currency)} per collection.</p>
        <p>Collection dates: {list(executionQuote.collectionDates).map(date).join(", ") || "Not supplied"}</p>
      </div> : <p className="text-muted-foreground">Execution schedule quote is not yet available. No collection amount or schedule is inferred.</p>}
    </> : <p role="alert">Unsupported calculation evidence. No financial amounts have been inferred.</p>}
    {financialBlockers(authority).length > 0 && <div role="alert"><p className="font-medium">Financial review required</p><ul className="list-disc pl-5">{financialBlockers(authority).map((item, index) => <li key={index}>{message(item)}</li>)}</ul></div>}
    {!supported(authority) && <p role="alert" className="text-amber-800 dark:text-amber-300">This authority does not contain supported retained-term monthly evidence. Saving and execution are blocked; resolve the source, term or financial evidence first.</p>}
  </div>;
}

export default function MemberMonthlyMembershipAmendments({ memberId, tenantId, data, actionsEnabled, readResponse, onRefresh, selectedAuthority }) {
  const storageKey = `membership-monthly-confirm:${JSON.stringify([tenantId || "", memberId])}`;
  const [recovery] = useState(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return {};
      const payload = JSON.parse(raw);
      if (payload.action !== "confirm_change" || payload.memberId !== memberId || !payload.selection || !payload.fingerprint || !payload.idempotencyKey) {
        throw new Error("Invalid recovery record");
      }
      return { payload };
    } catch { return { error: "Saved confirmation recovery could not be read. Do not create another authority; restore browser storage or contact finance support." }; }
  });
  const [form, setForm] = useState(recovery.payload?.selection || { configId: "", bandId: "", effectiveDate: "", reason: "" });
  const [preview, setPreview] = useState(null);
  const [attempt, setAttempt] = useState(recovery.payload || null);
  const attemptRef = useRef(recovery.payload || null);
  const [saved, setSaved] = useState(null);
  const [pending, setPending] = useState(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const [error, setError] = useState(recovery.error || "");
  useEffect(() => () => { generation.current += 1; }, []);
  const structures = list(data?.structures);
  const selected = structures.find(item => String(item.id) === String(form.configId));
  const flat = selected?.pricing_model === "flat";
  const valid = !!(selected && (flat || list(selected.bands).some(item => String(item.id) === String(form.bandId))) && /^\d{4}-\d{2}-\d{2}$/.test(form.effectiveDate) && form.reason.trim() && form.reason.length <= 2000);
  const monthly = data?.current?.commitment_snapshot?.payment_frequency === "monthly";
  const locked = !!pending || !!attempt || !!saved || !!recovery.error || !actionsEnabled;
  const entries = list(data?.monthlyChanges);
  const records = saved && !entries.some(item => item.id === saved.id) ? [saved, ...entries] : entries;
  async function post(payload) {
    return readResponse(await adminFetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }, tenantId));
  }
  function edit(field, value) {
    generation.current += 1;
    setForm(previous => ({ ...previous, [field]: value, ...(field === "configId" ? { bandId: "" } : {}) }));
    setPreview(null);
    setError("");
  }
  async function submit(action) {
    if (busy.current || saved || !actionsEnabled || recovery.error) return;
    if (!attemptRef.current && (!valid || (action === "confirm_change" && (!preview?.fingerprint || !supported(preview.authority))))) return;
    busy.current = true;
    const token = ++generation.current;
    setPending(action);
    setError("");
    try {
      const selection = { ...form, bandId: flat ? null : form.bandId, reason: form.reason.trim(), action: "change" };
      let payload = { action, memberId, selection };
      if (action === "preview_change") setPreview(null);
      if (action === "confirm_change") {
        if (!attemptRef.current) {
          // Persist BEFORE transport. An unknown result can only replay this exact authority request.
          const existing = window.localStorage.getItem(storageKey);
          if (existing) throw new Error("Another confirmation recovery record exists. Reload to recover it before proceeding.");
          const immutable = { ...payload, fingerprint: preview.fingerprint, idempotencyKey: crypto.randomUUID() };
          window.localStorage.setItem(storageKey, JSON.stringify(immutable));
          attemptRef.current = immutable;
          setAttempt(immutable);
        }
        payload = attemptRef.current;
      }
      const result = await post(payload);
      if (generation.current !== token) return;
      if (action === "preview_change") {
        if (!result?.authority || !result?.fingerprint) throw new Error("The server did not return authority and fingerprint evidence. Nothing was saved.");
        setPreview(result);
      } else {
        if (!result?.record?.id || !result.record.authority) throw new Error("The confirmation outcome is unconfirmed. Retry the same saved request key.");
        setSaved(result.record);
        setPreview(null);
        // A storage cleanup failure must not turn a confirmed save into a new authority.
        try { window.localStorage.removeItem(storageKey); } catch { /* Exact replay remains safe. */ }
        void onRefresh();
      }
    } catch (failure) {
      if (generation.current === token) setError(failure.message || "Monthly request failed. No outcome has been confirmed.");
    } finally {
      busy.current = false;
      if (generation.current === token) setPending(null);
    }
  }
  return <section aria-label="Retained-term monthly changes" className="space-y-4 rounded-md border p-4">
    <div className="space-y-1"><h3 className="font-medium">Retained-term monthly change</h3>
      <p className="text-sm text-muted-foreground">Preview → save authority → recover/check operation → explicit finance approval. The original renewal boundary stays unchanged. Preview, saving and recovery never start a provider change.</p>
    </div>
    {data?.monthlyExecutionAvailable !== true && <p role="status" className="rounded-md bg-muted/50 p-3 text-sm">Monthly execution unavailable. {data?.monthlyExecutionNotice || "This server has not enabled monthly execution. You may review and save supported authority, but cannot execute it here."}</p>}
    {monthly && <form onSubmit={event => { event.preventDefault(); void submit("preview_change"); }} className="space-y-3">
      <fieldset disabled={locked} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor={`monthly-config-${memberId}`}>Target membership structure (required)</Label>
          <select id={`monthly-config-${memberId}`} required value={form.configId} onChange={event => edit("configId", event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            <option value="">Choose a structure</option>{structures.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`monthly-band-${memberId}`}>Target pricing band{flat ? " (not required for flat price)" : " (required)"}</Label>
          <select id={`monthly-band-${memberId}`} required={!flat} disabled={!selected || flat || locked} value={form.bandId || ""} onChange={event => edit("bandId", event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            <option value="">{flat ? "Flat price — no band" : "Choose a band"}</option>{list(selected?.bands).map(item => <option key={item.id} value={item.id}>{item.label || item.name}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`monthly-date-${memberId}`}>Effective date (required)</Label>
          <Input id={`monthly-date-${memberId}`} type="date" required value={form.effectiveDate} onChange={event => edit("effectiveDate", event.target.value)} />
          <p className="text-xs text-muted-foreground">The server validates the date against the existing agreement and collection boundaries.</p>
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor={`monthly-reason-${memberId}`}>Reason for change (required)</Label>
          <Textarea id={`monthly-reason-${memberId}`} required maxLength={2000} value={form.reason} onChange={event => edit("reason", event.target.value)} />
        </div>
      </fieldset>
      {!structures.length && <p className="text-sm text-muted-foreground">No eligible target structures were supplied.</p>}
      {!attempt && !saved && <Button type="submit" variant="outline" disabled={locked || !valid}>{pending === "preview_change" ? "Preparing monthly preview…" : "Preview monthly change"}</Button>}
    </form>}
    {preview && <div data-testid="monthly-preview" className="rounded-md border p-3 space-y-3" aria-live="polite">
      <p className="font-medium text-sm">Preview only — no authority saved</p>
      <AuthoritySummary authority={preview.authority} />
      {!attempt && <Button type="button" disabled={!!pending || !actionsEnabled || !supported(preview.authority)} onClick={() => submit("confirm_change")}>Save monthly authority</Button>}
    </div>}
    {attempt && !saved && <div className="rounded-md border p-3 text-sm space-y-2" role="status">
      <p>Confirmation outcome unconfirmed. Fields are locked. Retry reuses the exact persisted selection, fingerprint and request key, including after a reload. Do not submit another authority.</p>
      <Button type="button" variant="outline" disabled={!!pending || !actionsEnabled} onClick={() => submit("confirm_change")}>{pending === "confirm_change" ? "Recovering saved authority…" : "Retry saved monthly confirmation"}</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{error}</p>}
    {saved && <p role="status" className="text-sm">Monthly authority saved · {saved.id}. Saving did not execute a provider change or confirm membership application.</p>}
    <div className="space-y-3">
      <h4 className="font-medium text-sm">Monthly authority and operation history</h4>
      {!records.length ? <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No monthly authorities recorded. Original membership and collection evidence remain unchanged.</p> : records.map(record => <MonthlyOperation key={record.id} memberId={memberId} record={record} available={data?.monthlyExecutionAvailable === true} enabled={actionsEnabled} post={post} onRefresh={onRefresh} selection={selectedAuthority?.id === record.id ? selectedAuthority.revision : null} />)}
    </div>
  </section>;
}

function MonthlyOperation({ memberId, record, available, enabled, post, onRefresh, selection }) {
  const [outcome, setOutcome] = useState(null);
  const [approval, setApproval] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const alive = useRef(true);
  const article = useRef(null);
  useEffect(() => {
    if (selection == null) return;
    article.current?.focus();
    article.current?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
    setApproval(false);
    setReason("");
    setOutcome(previous => previous ? { ...previous, nextAction: undefined } : null);
  }, [selection]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const operation = outcome?.operation || record.operation;
  // Only concrete application evidence establishes completion; provider state alone does not.
  const applicationEvidence = outcome?.application || record.application || record.operation?.evidence?.application;
  const application = isApplication(applicationEvidence) ? applicationEvidence : null;
  const safe = executableEvidence(record.authority) && record.authority.memberId === memberId;
  const executable = outcome?.nextAction === "execute"
    || (outcome?.nextAction === "approve_finalization" && ["provider_applied", "reserved"].includes(operation?.state));
  const finalize = outcome?.nextAction === "approve_finalization" && operation?.state === "provider_applied";
  async function run(action) {
    if (busy.current || !enabled || !available || !safe || application) return;
    if (action === "execute_change" && (!executable || !approval || !reason.trim() || reason.length > 2000)) return;
    busy.current = true;
    setPending(action);
    setError("");
    // Any execution uncertainty must return through recovery, never a direct retry.
    setOutcome(null);
    setApproval(false);
    try {
      const result = await post({
        action, memberId, authorityId: record.id,
        ...(action === "execute_change" ? { approve: true, reason: reason.trim() } : {}),
      });
      if (!alive.current) return;
      if (isApplication(result?.application)) {
        setOutcome(result);
        void onRefresh(result);
      } else if (action === "resume_change" && ((result?.state === "not_started" && result.nextAction === "execute") || (result?.operation && result.nextAction === "approve_finalization"))) {
        setOutcome(result);
      } else {
        throw new Error("No membership application was confirmed. Recover the operation before any further approval.");
      }
    } catch (failure) {
      if (alive.current) setError(failure.message || "Operation outcome unconfirmed. Recover before further approval.");
    } finally {
      busy.current = false;
      if (alive.current) setPending(null);
    }
  }
  return <article ref={article} tabIndex={-1} data-testid={`monthly-authority-${record.id}`} aria-label={selection != null ? "Selected approved monthly financial authority" : undefined} className={`rounded-md border p-3 space-y-3 text-sm ${selection != null ? "ring-2 ring-primary ring-offset-2" : ""}`}>
    {selection != null && <p className="font-medium">Selected approved request · review the existing monthly operation below</p>}
    <div className="flex flex-wrap justify-between gap-2"><h5 className="font-medium break-all">Authority {record.id}</h5><Badge variant="outline">{application ? "Application confirmed" : "Application not confirmed"}</Badge></div>
    <AuthoritySummary authority={record.authority} operation={operation} />
    {available && !safe && <p role="alert">Execution is blocked: confirmed monthly execution or member-binding evidence is missing or unsupported. No provider action is available for this authority.</p>}
    <p className="whitespace-pre-wrap break-words">Change reason: {record.authority?.request?.reason || "Not supplied"}</p>
    <p>Operation: {operation?.id || "Not supplied"} · State: {operation?.state || "Not confirmed"}</p>
    {applicationEvidence && !application && <p role="alert">Application evidence is incomplete. Completion is not confirmed; recover the operation.</p>}
    {(operation?.result?.reason || operation?.evidence?.reason) && <p role="alert">Provider evidence: {operation.result?.reason || operation.evidence?.reason}</p>}
    <p>Notification: {typeof record.notification === "string" ? record.notification : record.notification?.status || record.notification?.state || "Not confirmed"}. Notification is not evidence of membership application.</p>
    {record.notification?.evidence?.reason && <p>Notification evidence: {record.notification.evidence.reason}</p>}
    {application ? <div role="status" className="rounded-md bg-muted/50 p-3 space-y-1">
      <p className="font-medium">Membership application confirmed</p>
      <p>Operation: {application.operationId || "Not supplied"}</p>
      <p>Effective: {date(application.effectiveDate)} · Expires: {date(application.expiresOn)}</p>
      <p>Original renewal boundary retained: {date(record.authority?.sourceSnapshot?.membership_renewal_date)}</p>
    </div> : available && safe && <div className="space-y-3 border-t pt-3">
      <p className="text-muted-foreground">Check or recover first. Recovery never starts a provider change. An unresolved provider outcome must be reconciled, not submitted as a new authority.</p>
      <Button type="button" variant="outline" disabled={!!pending || !enabled} onClick={() => run("resume_change")}>{pending === "resume_change" ? "Recovering operation…" : "Check / recover monthly operation"}</Button>
      {outcome?.nextAction === "approve_finalization" && !executable && <p role="alert">Provider outcome is unresolved or blocked ({operation?.state || "unknown"}). Execution approval is unavailable. Recover again or request finance reconciliation.</p>}
      {executable && <div className="rounded-md border p-3 space-y-3">
        <p className="font-medium">{finalize ? "Approve finalization of the verified provider change" : "Explicit approval required — change the existing monthly schedule"}</p>
        <p>{finalize ? "Provider evidence has been recovered. Approval finalizes membership application for this same authority; it does not create a new operation." : "This action may change the provider collection schedule and membership. It does not start a new term. Review the amounts, effective date and original renewal boundary above."}</p>
        <div className="space-y-1.5">
          <Label htmlFor={`monthly-approval-reason-${record.id}`}>Finance approval reason (required)</Label>
          <Textarea id={`monthly-approval-reason-${record.id}`} required maxLength={2000} value={reason} disabled={!!pending || !enabled} onChange={event => setReason(event.target.value)} />
        </div>
        <div className="flex items-start gap-2">
          <input id={`monthly-approve-${record.id}`} type="checkbox" required checked={approval} disabled={!!pending || !enabled} onChange={event => setApproval(event.target.checked)} className="mt-1" />
          <Label htmlFor={`monthly-approve-${record.id}`}>I explicitly approve {finalize ? "finalization" : "execution"} of this retained-term monthly change (required).</Label>
        </div>
        <Button type="button" disabled={!!pending || !enabled || !approval || !reason.trim()} onClick={() => run("execute_change")}>{finalize ? "Approve monthly finalization" : "Approve and execute monthly change"}</Button>
      </div>}
    </div>}
    {pending === "execute_change" && <p role="status">Executing approved change. Do not submit another authority.</p>}
    {error && <p role="alert" className="text-amber-800 dark:text-amber-300">{error}</p>}
  </article>;
}
