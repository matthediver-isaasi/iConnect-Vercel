import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { adminFetch } from "@/lib/adminFetch";

const endpoint = "/api/membership/member-amendments";
const list = value => Array.isArray(value) ? value : [];
const date = value => value ? String(value).slice(0, 10) : "Not supplied";
const message = value => typeof value === "string" ? value : value?.message || value?.code || "Unsupported financial evidence";
const money = (value, currency) => {
  if (!Number.isSafeInteger(value) || !/^[A-Z]{3}$/.test(currency || "")) return "Not supplied";
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(value / 100); }
  catch { return "Invalid currency"; }
};
function paymentLink(settlement) {
  if (settlement?.choice !== "collect" || settlement?.state !== "awaiting_payment" || settlement?.evidence?.verified !== true) return null;
  try {
    const url = new URL(settlement.evidence.paymentUrl);
    // Match the existing admin lifecycle: only verified server evidence, HTTPS, no embedded credentials.
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function treatment(authority) {
  const delta = authority?.calculation?.delta?.grossMinor;
  if (!Number.isSafeInteger(delta)) return null;
  if (delta > 0) return "collect";
  if (delta === 0) return "none";
  if (authority?.settlement?.surplusHandling === "credit") return authority.creditLiabilityBinding ? "credit" : null;
  if (authority?.settlement?.surplusHandling === "refund") return "refund";
  if (authority?.settlement?.surplusHandling === "approval") return "approval";
  return null;
}
function blockers(authority) {
  return [...list(authority?.calculation?.blockers), ...list(authority?.calculation?.finance?.blockers), ...list(authority?.settlement?.blockers)];
}
function supported(authority, memberId, tenantId, replacementAvailable = false) {
  return authority?.action === "change" && authority.memberId === memberId && authority.tenantId === tenantId
    && authority.sourceSnapshot?.commitment_snapshot?.payment_frequency === "upfront"
    && !!authority.sourceSnapshot?.id && authority.calculation?.sourceRecordId === authority.sourceSnapshot.id
    && !!authority.targetSnapshot?.id && authority.calculation?.version === 2
    && (authority.calculation.behaviour === "retain_term"
      ? authority.calculation.newTerm?.renewalDate === authority.sourceSnapshot.membership_renewal_date
      : replacementAvailable && authority.calculation.behaviour === "new_term"
        && typeof authority.calculation.newTerm?.startDate === "string"
        && authority.calculation.newTerm?.startDate === authority.calculation.effectiveDate
        && authority.calculation.newTerm.startDate !== authority.sourceSnapshot.term_start_date
        && authority.calculation.newTerm.renewalDate > authority.calculation.newTerm.startDate)
    && !!authority.sourceSnapshot.membership_renewal_date
    && /^[A-Z]{3}$/.test(authority.calculation.currency || "")
    && authority.fundingEvidence?.complete === true
    && authority.fundingEvidence.sourceRecordId === authority.sourceSnapshot.id
    && authority.calculation.finance?.personalFundingOnly === true
    && list(authority.fundingEvidence.settledFunding).length > 0
    && authority.fundingEvidence.settledFunding.every(item => item.kind === "cash" && item.ownerType === "member" && item.ownerId === memberId)
    && !!treatment(authority) && !blockers(authority).length;
}
function isApplication(value) {
  return !!(value?.id && value.snapshot?.targetSnapshot?.config?.id
    && /^\d{4}-\d{2}-\d{2}/.test(value.effective_date || "")
    && /^\d{4}-\d{2}-\d{2}/.test(value.expires_on || ""));
}
function isLifecycle(value) {
  return value && Object.hasOwn(value, "execution") && Object.hasOwn(value, "settlement")
    && Object.hasOwn(value, "application") && Array.isArray(value.notifications)
    && (value.settlement === null || typeof value.settlement?.state === "string")
    && (value.application === null || isApplication(value.application));
}
const treatments = {
  collect: "Collect additional payment by invoice",
  none: "Verify zero financial difference",
  credit: "Issue liability-backed iConnect member credit",
  refund: "Record a manual, bank-reconciled cash refund",
};
function FinancialSummary({ authority, creditEnabled = false, selectedTreatment = "", executionLocked = false }) {
  const calculation = authority?.calculation;
  const source = authority?.sourceSnapshot;
  const policy = treatment(authority);
  const choice = policy === "approval" ? selectedTreatment : policy;
  const creditEligible = creditEnabled && !!authority?.creditLiabilityBinding && !authority?.creditEligibilityError;
  return <div className="space-y-2 text-sm">
    <p>Source: {source?.commitment_snapshot?.config?.name || source?.structureName || "Historical upfront purchase"}{source?.tier_label ? ` · ${source.tier_label}` : ""}</p>
    <p>Source term: {date(source?.term_start_date)} to {date(source?.term_end_date)}. Original renewal boundary: {date(source?.membership_renewal_date)}{calculation?.behaviour === "new_term" ? " · replaced after settlement." : " · retained."}</p>
    {calculation?.behaviour === "new_term" && <p>New term: {date(calculation.newTerm?.startDate)} to renewal on {date(calculation.newTerm?.renewalDate)}. The new invoice records the full term price; unused paid value is transferred from the original purchase.</p>}
    <p>Selected target: {authority?.targetSnapshot?.name || "Not supplied"} · {authority?.targetBandSnapshot?.label || authority?.targetBandSnapshot?.name || (authority?.targetSnapshot?.pricing_model === "flat" ? "Flat price" : "Band not supplied")}</p>
    <p>Effective: {date(calculation?.effectiveDate)}</p>
    <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {[["netMinor", "Net adjustment"], ["vatMinor", "VAT adjustment"], ["grossMinor", "Gross adjustment"]].map(([key, label]) => <div key={key}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{money(calculation?.delta?.[key], calculation?.currency)}</dd></div>)}
    </dl>
    <p className="font-medium">Financial treatment: {choice === "credit" && !creditEligible ? "iConnect member credit policy — not yet executable" : treatments[choice] || (policy === "approval" ? "Tenant approval policy — explicit refund or eligible iConnect credit choice required" : "Unavailable — resolve financial policy or liability evidence")}</p>
    {choice === "collect" && <p>An invoice requests the additional payment. Application is not confirmed until payment evidence is verified and a separate application record is returned.</p>}
    {choice === "none" && <p>No collection, cash refund or member credit is requested. A separate application record is still required.</p>}
    {(choice === "refund" || (policy === "approval" && !choice)) && <p>{policy === "approval" && !choice ? "If refund is selected: the" : "The"} manual refund must be recorded and bank-reconciled before membership application. This does not send cash automatically.</p>}
    {(choice === "credit" || authority?.settlement?.surplusHandling === "credit" || policy === "approval") && <>
      <p>iConnect member credit requires frozen liability backing. It is not a retained Xero credit note and not a cash refund. Credit is not spendable until a membership application exists.</p>
      {!creditEnabled && <p role="alert">Member credit execution is not enabled. Both execution capabilities are required; an account binding alone does not enable credit. {policy === "approval" && !executionLocked ? "Refund remains an explicitly selectable option under the approval policy, but nothing is selected automatically." : "No retained Xero credit or refund fallback is offered against this policy or locked execution."}</p>}
      {!authority?.creditLiabilityBinding && <p role="alert">Frozen credit liability binding is missing. Credit execution is blocked; {policy === "approval" && !executionLocked ? "refund remains available only by explicit selection." : "no alternative treatment is inferred."}</p>}
      {typeof authority?.creditEligibilityError === "string" && authority.creditEligibilityError && <p role="alert">Credit eligibility: {authority.creditEligibilityError}</p>}
    </>}
    {!!blockers(authority).length && <ul role="alert" className="list-disc pl-5 text-amber-800 dark:text-amber-300">{blockers(authority).map((item, index) => <li key={index}>{message(item)}</li>)}</ul>}
  </div>;
}

// Isolated from legacy proposal/settlement flows. Storage contains operational
// key/fingerprint only: never selection, free-text reasons or personal form data.
export default function MemberUpfrontFinancialChanges({ memberId, tenantId, data, actionsEnabled, readResponse, onRefresh }) {
  const key = `membership-upfront-financial-confirm:${JSON.stringify([tenantId || "", memberId])}`;
  const [recovery] = useState(() => {
    try {
      const value = window.localStorage.getItem(key);
      if (!value) return {};
      const parsed = JSON.parse(value);
      if (!parsed.idempotencyKey || !parsed.fingerprint || Object.keys(parsed).some(item => !["idempotencyKey", "fingerprint"].includes(item))) throw new Error("Invalid recovery metadata");
      return { metadata: parsed };
    } catch { return { error: "Confirmation recovery metadata could not be read. Do not create another authority; contact finance support to recover the original request." }; }
  });
  const [form, setForm] = useState({ configId: "", bandId: "", effectiveDate: "", reason: "" });
  const [preview, setPreview] = useState(null);
  const [metadata, setMetadata] = useState(recovery.metadata || null);
  const attempt = useRef(null);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(recovery.error || "");
  const [pending, setPending] = useState(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const serial = useRef(0);
  const sourceStamp = JSON.stringify(data?.current || null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current += 1; }; }, []);
  useEffect(() => {
    setPreview(null);
    if (!attempt.current) {
      serial.current += 1;
    }
  }, [sourceStamp]);
  const structures = list(data?.structures);
  const selected = structures.find(item => String(item.id) === form.configId);
  const flat = selected?.pricing_model === "flat";
  const valid = !!(selected && (flat || list(selected.bands).some(item => String(item.id) === form.bandId))
    && /^\d{4}-\d{2}-\d{2}$/.test(form.effectiveDate) && form.reason.trim() && form.reason.length <= 2000);
  const available = data?.financialExecutionAvailable === true;
  const replacementAvailable = data?.replacementExecutionAvailable === true;
  const creditEnabled = available && data?.memberCreditExecutionAvailable === true;
  const upfront = data?.current?.commitment_snapshot?.payment_frequency === "upfront";
  const locked = !!pending || !!metadata || !!saved || !!recovery.error || !actionsEnabled;
  const records = list(data?.financialChanges);
  const history = saved && !records.some(item => item.id === saved.id) ? [saved, ...records] : records;
  const post = async payload => readResponse(await adminFetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }, tenantId));
  function edit(field, value) {
    serial.current += 1;
    setPreview(null);
    setError("");
    setForm(previous => ({ ...previous, [field]: value, ...(field === "configId" ? { bandId: "" } : {}) }));
  }
  async function submit(action) {
    if (busy.current || !actionsEnabled || saved || recovery.error) return;
    if (action === "preview_change" && (!upfront || !valid || metadata)) return;
    if (action === "confirm_change" && (!available || (!attempt.current && (!valid || !preview?.fingerprint || preview.sourceStamp !== sourceStamp || preview.authority?.sourceSnapshot?.id !== data?.current?.id || !supported(preview.authority, memberId, tenantId, replacementAvailable))))) return;
    if (action === "recover_change" && !metadata) return;
    busy.current = true;
    const token = ++serial.current;
    setPending(action);
    setError("");
    try {
      const selection = { ...form, bandId: flat ? null : form.bandId, reason: form.reason.trim(), action: "change" };
      let payload = { action, memberId, selection };
      if (action === "preview_change") setPreview(null);
      if (action === "confirm_change") {
        if (!attempt.current) {
          if (window.localStorage.getItem(key)) throw new Error("Another confirmation recovery record exists. Reload to recover it; do not submit a new authority.");
          const immutable = { ...payload, fingerprint: preview.fingerprint, idempotencyKey: crypto.randomUUID() };
          const minimal = { fingerprint: immutable.fingerprint, idempotencyKey: immutable.idempotencyKey };
          try { window.localStorage.setItem(key, JSON.stringify(minimal)); }
          catch { throw new Error("Request-key recovery storage is unavailable. No confirmation was sent. Restore browser storage before saving."); }
          attempt.current = immutable;
          setMetadata(minimal);
        }
        payload = attempt.current;
      }
      if (action === "recover_change") payload = { action, memberId, ...metadata };
      const result = await post(payload);
      if (!alive.current || serial.current !== token) return;
      if (action === "preview_change") {
        if (!result?.authority || !result?.fingerprint) throw new Error("No valid authority and fingerprint were returned. Nothing was saved.");
        setPreview({ ...result, sourceStamp });
      } else {
        if (!result?.record?.id || !result.record.authority) throw new Error("Saved authority is not confirmed. Keep the original request key and recover again; do not create a new authority.");
        setSaved({ execution: null, settlement: null, application: null, notifications: [], ...result.record });
        setPreview(null);
        try { window.localStorage.removeItem(key); } catch { /* Metadata replay remains read-only and safe. */ }
        void onRefresh();
      }
    } catch (failure) {
      if (alive.current && serial.current === token) setError(failure.message || "Financial request outcome is unconfirmed. Recover the original request.");
    } finally {
      busy.current = false;
      if (alive.current) setPending(null);
    }
  }
  return <section aria-label="Upfront financial changes" data-testid="upfront-financial-changes" className="rounded-md border p-4 space-y-4">
    <div className="space-y-1"><h3 className="font-medium">Upfront financial change · {replacementAvailable ? "retained or replacement term" : "retained term"}</h3>
      <p className="text-sm text-muted-foreground">Separate from legacy change requests. Preview and save authority, check financial evidence, then explicitly approve collection, liability-backed member credit, or manual refund. No replacement term or monthly settlement is offered here.</p>
    </div>
    {!available && <p role="status" className="rounded-md bg-muted/50 p-3 text-sm">Upfront financial execution and authority saving are unavailable on this server. Existing records remain visible for read-only review and recovery. No financial write can be started here.</p>}
    {upfront && <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submit("preview_change"); }}>
      <fieldset disabled={locked} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1.5"><Label htmlFor={`financial-config-${memberId}`}>Financial change target structure (required)</Label>
          <select id={`financial-config-${memberId}`} required value={form.configId} onChange={event => edit("configId", event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            <option value="">Choose a structure</option>{structures.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div className="space-y-1.5"><Label htmlFor={`financial-band-${memberId}`}>Financial change pricing band{flat ? " (not required for flat price)" : " (required)"}</Label>
          <select id={`financial-band-${memberId}`} required={!flat} disabled={!selected || flat || locked} value={form.bandId} onChange={event => edit("bandId", event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            <option value="">{flat ? "Flat price — no band" : "Choose a band"}</option>{list(selected?.bands).map(item => <option key={item.id} value={item.id}>{item.label || item.name}</option>)}
          </select>
        </div>
        <div className="space-y-1.5"><Label htmlFor={`financial-date-${memberId}`}>Financial change effective date (required)</Label>
          <Input id={`financial-date-${memberId}`} type="date" required value={form.effectiveDate} onChange={event => edit("effectiveDate", event.target.value)} />
          <p className="text-xs text-muted-foreground">The server verifies the original purchase, retained term and payment evidence.</p>
        </div>
        <div className="space-y-1.5 md:col-span-2"><Label htmlFor={`financial-reason-${memberId}`}>Financial change reason (required)</Label>
          <Textarea id={`financial-reason-${memberId}`} required maxLength={2000} value={form.reason} onChange={event => edit("reason", event.target.value)} />
        </div>
      </fieldset>
      {!structures.length && <p className="text-sm text-muted-foreground">No target structures are available for preview.</p>}
      {!metadata && !saved && <Button type="submit" variant="outline" disabled={locked || !valid}>{pending === "preview_change" ? "Preparing financial preview…" : "Preview upfront financial change"}</Button>}
    </form>}
    {preview && <div data-testid="upfront-financial-preview" aria-live="polite" className="rounded-md border p-3 space-y-3">
      <p className="font-medium text-sm">Financial preview only — no authority saved</p>
      <FinancialSummary authority={preview.authority} creditEnabled={creditEnabled} />
      {!supported(preview.authority, memberId, tenantId, replacementAvailable) && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">Unsupported or blocked personal, cash-backed authority. No financial fallback is available.</p>}
      {!metadata && <Button type="button" disabled={!!pending || !available || !actionsEnabled || !supported(preview.authority, memberId, tenantId, replacementAvailable)} onClick={() => submit("confirm_change")}>Save upfront financial authority</Button>}
    </div>}
    {metadata && !saved && <div role="status" className="rounded-md border p-3 space-y-2 text-sm">
      <p>Confirmation outcome unconfirmed. The original request key and fingerprint are retained; no new authority key can be created. Only operational recovery metadata is stored, never reasons or personal form data.</p>
      {attempt.current && <Button type="button" variant="outline" disabled={!!pending || !available || !actionsEnabled} onClick={() => submit("confirm_change")}>Retry original financial confirmation</Button>}
      <Button type="button" variant="outline" disabled={!!pending || !actionsEnabled} onClick={() => submit("recover_change")}>{pending === "recover_change" ? "Recovering financial authority…" : "Recover saved financial authority"}</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{error}</p>}
    {saved && <p role="status" className="text-sm">Upfront financial authority saved · {saved.id}. Saving is not approval, settlement or membership application.</p>}
    <div className="space-y-3"><h4 className="text-sm font-medium">Upfront financial authority history</h4>
      {!history.length ? <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No upfront financial authorities recorded. Legacy membership requests and original purchase history are unchanged.</p> : history.map(record => <FinancialExecution key={record.id} record={record} memberId={memberId} tenantId={tenantId} available={available} replacementAvailable={replacementAvailable} creditEnabled={creditEnabled} enabled={actionsEnabled} post={post} onRefresh={onRefresh} />)}
    </div>
  </section>;
}

function FinancialExecution({ record, memberId, tenantId, available, replacementAvailable, creditEnabled, enabled, post, onRefresh }) {
  const [outcome, setOutcome] = useState(null);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [approval, setApproval] = useState(false);
  const [selectedChoice, setSelectedChoice] = useState("");
  const [executionLock, setExecutionLock] = useState(record.execution || null);
  const approvalFor = useRef(null);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (record.execution) {
      setExecutionLock(previous => previous?.settlement_choice ? previous : record.execution);
      setApproval(false);
      approvalFor.current = null;
      setReason("");
    }
  }, [record.execution?.id, record.execution?.settlement_choice]);
  const lifecycle = outcome || record;
  const settlement = lifecycle.settlement;
  const application = isApplication(lifecycle.application) ? lifecycle.application : null;
  const safe = supported(record.authority, memberId, tenantId, replacementAvailable);
  const replacement = record.authority?.calculation?.behaviour === "new_term";
  const policy = treatment(record.authority);
  const execution = executionLock || lifecycle.execution || record.execution;
  const choice = execution ? execution.settlement_choice : policy === "approval" ? selectedChoice : policy;
  const creditEligible = creditEnabled && !!record.authority?.creditLiabilityBinding && !record.authority?.creditEligibilityError;
  useEffect(() => {
    setApproval(false);
    approvalFor.current = null;
    setReason("");
    if (!creditEligible && !execution && selectedChoice === "credit") setSelectedChoice("");
  }, [available, creditEligible]);
  const choices = policy === "approval" ? ["refund", ...(creditEligible ? ["credit"] : [])]
    : policy === "credit" ? (creditEligible ? ["credit"] : []) : [policy].filter(Boolean);
  const executionConflict = (!execution && !!settlement) || (!!execution && (
    !execution.settlement_choice
    || (lifecycle.execution?.id && execution.id && lifecycle.execution.id !== execution.id)
    || (record.execution?.id && execution.id && record.execution.id !== execution.id)
    || (lifecycle.execution?.settlement_choice && lifecycle.execution.settlement_choice !== execution.settlement_choice)
    || (record.execution?.settlement_choice && record.execution.settlement_choice !== execution.settlement_choice)
    || (settlement?.choice && settlement.choice !== execution.settlement_choice)
  ));
  const hasGrant = outcome?.nextAction === "execute" || (outcome?.nextAction === "back_credit" && choice === "credit");
  const canExecute = safe && choices.includes(choice) && !executionConflict && hasGrant;
  const canChoose = safe && available && hasGrant && policy === "approval" && !execution && !settlement;
  function changeChoice(value) {
    if (execution || busy.current || (value !== "" && !choices.includes(value))) return;
    setSelectedChoice(value);
    setApproval(false);
    approvalFor.current = null;
    setReason("");
    setError("");
  }
  const url = paymentLink(settlement);
  async function run(action) {
    if (busy.current || !enabled || !safe || application) return;
    if (action === "execute_change" && (!available || (choice === "credit" && !creditEligible) || !canExecute || !approval || approvalFor.current !== choice || !reason.trim() || reason.length > 2000)) return;
    busy.current = true;
    setPending(action);
    setError("");
    setApproval(false);
    approvalFor.current = null;
    setReason("");
    // Retain financial evidence, but remove any execution grant after EVERY attempt.
    setOutcome(previous => previous ? { ...previous, nextAction: undefined } : null);
    try {
      const result = await post({ action, memberId, authorityId: record.id,
        ...(action === "execute_change" ? { approve: true, reason: reason.trim(), settlementChoice: choice } : {}),
      });
      if (!alive.current) return;
      if (!isLifecycle(result)) throw new Error("Financial lifecycle evidence is incomplete. No application or completed outcome is confirmed; recover this authority.");
      if (result.execution) setExecutionLock(previous => previous?.settlement_choice ? previous : result.execution);
      setOutcome(action === "resume_change" ? result : { ...result, nextAction: undefined });
      void onRefresh();
    } catch (failure) {
      if (alive.current) setError(failure.message || "Financial outcome unconfirmed. Recover this authority; do not submit a new execution.");
    } finally {
      busy.current = false;
      if (alive.current) setPending(null);
    }
  }
  return <article data-testid={`financial-authority-${record.id}`} className="rounded-md border p-3 space-y-3 text-sm">
    <div className="flex flex-wrap justify-between gap-2"><h5 className="font-medium break-all">Financial authority {record.id}</h5><Badge variant="outline">{application ? "Application confirmed" : "Application not confirmed"}</Badge></div>
    <FinancialSummary authority={record.authority} creditEnabled={creditEnabled} selectedTreatment={choice} executionLocked={!!execution} />
    <p className="whitespace-pre-wrap break-words">Recorded change reason: {record.authority?.request?.reason || "Not supplied"}</p>
    {!safe && <p role="alert">Financial execution blocked: unsupported source, member/tenant binding, retained-term, cash funding or liability evidence. No alternative financial route is inferred.</p>}
    <p>Execution: {execution?.id || "Not confirmed"} · Settlement: {settlement?.state || "Not started / not confirmed"}</p>
    {execution && <p className="font-medium">Locked execution treatment: {treatments[execution.settlement_choice] || "Missing or unsupported — recover execution evidence"}. This saved execution choice cannot be changed.</p>}
    {executionConflict && <p role="alert">Execution treatment evidence is missing or conflicts with recorded settlement. No alternative choice or new execution is permitted; recover the existing authority.</p>}
    {(lifecycle.execution?.last_error || lifecycle.execution?.error) && <p role="alert">Execution error: {message(lifecycle.execution.last_error || lifecycle.execution.error)}</p>}
    {settlement?.evidence?.reason && <p role="alert">Settlement evidence: {settlement.evidence.reason}</p>}
    {settlement?.last_error && <p role="alert">Finance error: {message(settlement.last_error)}</p>}
    {settlement?.state === "awaiting_payment" && <div className="space-y-1">
      <p>Awaiting collection — verified payment and membership application are not yet confirmed.</p>
      {url ? <a className="underline underline-offset-4" href={url} target="_blank" rel="noopener noreferrer">Open verified payment invoice</a> : <p>Verified payment link is unavailable. No untrusted or inferred URL is offered.</p>}
    </div>}
    {settlement?.state === "settled" && !application && <p role="status">Settlement recorded, but membership application is not confirmed.{choice === "credit" ? " Member credit is not spendable yet." : ""} Recover to verify application evidence.</p>}
    {lifecycle.application && !application && <p role="alert">Application evidence is incomplete. Completion is not confirmed.</p>}
    {application ? <div role="status" className="rounded-md bg-muted/50 p-3 space-y-1">
      <p className="font-medium">Upfront membership application confirmed</p>
      <p>Application: {application.id} · Effective: {date(application.effective_date)} · Expires: {date(application.expires_on)}</p>
      <p>{replacement ? "New renewal boundary" : "Original renewal boundary retained"}: {date(replacement ? record.authority?.calculation?.newTerm?.renewalDate : record.authority?.sourceSnapshot?.membership_renewal_date)}</p>
      {choice === "credit" && <p>iConnect member credit may be used only according to its recorded liability-backed credit terms. This application is not a cash refund.</p>}
    </div> : safe && <div className="space-y-3 border-t pt-3">
      <p className="text-muted-foreground">Check / recover is read-only financial recovery: it never starts collection, refunds or credit backing. Only a separately approved execute action may start financial writes.</p>
      <Button type="button" variant="outline" disabled={!!pending || !enabled} onClick={() => run("resume_change")}>{pending === "resume_change" ? "Recovering financial evidence…" : "Check / recover upfront financial change"}</Button>
      {(canExecute || canChoose) && available && <div className="rounded-md border p-3 space-y-3">
        <p className="font-medium">{outcome?.nextAction === "back_credit" ? "Approve liability backing for iConnect member credit" : "Approve upfront financial execution"}</p>
        <p>{treatments[choice] || "Choose a permitted treatment before approving."} {replacement ? "A new term replaces the original after verified settlement." : "The original term is retained."} Approval applies only to this saved authority and its existing execution identity.</p>
        {policy === "approval" && <div className="space-y-1.5">
          <Label htmlFor={`financial-treatment-${record.id}`}>Surplus financial treatment (required)</Label>
          <select id={`financial-treatment-${record.id}`} required value={choice || ""} disabled={!!execution || !!pending || !enabled} onChange={event => changeChoice(event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            <option value="">Choose refund or eligible iConnect credit</option>
            {(execution ? [execution.settlement_choice].filter(Boolean) : choices).map(value => <option key={value} value={value}>{treatments[value] || value}</option>)}
          </select>
          <p className="text-xs text-muted-foreground">{execution ? "Locked to execution.settlement_choice; recovery cannot select another treatment." : "No treatment is selected by default. Changing treatment clears approval and its reason."}</p>
        </div>}
        <div className="space-y-1.5"><Label htmlFor={`financial-approval-reason-${record.id}`}>Financial approval reason (required)</Label>
          <Textarea id={`financial-approval-reason-${record.id}`} required maxLength={2000} value={reason} disabled={!!pending || !enabled || !canExecute} onChange={event => setReason(event.target.value)} />
        </div>
        <div className="flex items-start gap-2"><input id={`financial-approve-${record.id}`} type="checkbox" required checked={approval && approvalFor.current === choice} disabled={!!pending || !enabled || !canExecute} onChange={event => { setApproval(event.target.checked); approvalFor.current = event.target.checked ? choice : null; }} className="mt-1" />
          <Label htmlFor={`financial-approve-${record.id}`}>I explicitly approve this financial treatment and {replacement ? "replacement-term" : "retained-term"} change (required).</Label>
        </div>
        <Button type="button" disabled={!!pending || !enabled || !canExecute || !approval || approvalFor.current !== choice || !reason.trim()} onClick={() => run("execute_change")}>Approve and execute upfront financial change</Button>
      </div>}
      {outcome && !application && !canExecute && !canChoose && <p className="text-muted-foreground">No permitted execution action is available. Continue read-only recovery or resolve the finance evidence; do not start a replacement authority.</p>}
    </div>}
    <div className="space-y-1"><p className="font-medium">Notification evidence</p>
      {!list(lifecycle.notifications).length ? <p className="text-muted-foreground">No delivery confirmed. Notification state does not establish settlement or application.</p> : <ul className="list-disc pl-5">{lifecycle.notifications.map((item, index) => <li key={item.id || index}>{item.state || item.status || "Not confirmed"}{item.evidence?.reason ? ` · ${item.evidence.reason}` : ""}</li>)}</ul>}
    </div>
    {pending === "execute_change" && <p role="status">Submitting explicit financial approval. Do not start another request.</p>}
    {error && <p role="alert" className="text-amber-800 dark:text-amber-300">{error}</p>}
  </article>;
}
