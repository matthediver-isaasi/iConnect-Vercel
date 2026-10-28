import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { adminFetch } from "@/lib/adminFetch";

const endpoint = "/api/membership/member-amendments";
const choices = {
  collect: "Collect earned balance by invoice",
  none: "No collection or return",
  credit: "Issue liability-backed member credit",
  refund: "Record a bank-reconciled refund",
};
const date = value => value ? String(value).slice(0, 10) : "Not supplied";
const readable = value => typeof value === "string" ? value.replaceAll("_", " ") : "Not supplied";
const money = (minor, currency) => {
  if (!Number.isSafeInteger(minor) || !/^[A-Z]{3}$/.test(currency || "")) return "Not supplied";
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100); }
  catch { return "Invalid currency"; }
};
async function readResponse(response) {
  let body;
  try { body = await response.json(); }
  catch { throw new Error("The server returned an unreadable response. The outcome is not confirmed."); }
  if (!response.ok) {
    throw new Error(body?.error?.message || (typeof body?.error === "string" ? body.error : null) || body?.message || `Request failed (${response.status}).`);
  }
  return body;
}

// Remount on either scope change; detached requests can never populate the new scope.
export default function MemberCancellationFinancialRecovery({ memberId, tenantId, actionsEnabled = false, refreshVersion = 0 }) {
  if (!memberId) return null;
  return <CancellationFinances key={JSON.stringify([tenantId, memberId])} memberId={memberId} tenantId={tenantId} actionsEnabled={actionsEnabled} refreshVersion={refreshVersion} />;
}

function CancellationFinances({ memberId, tenantId, actionsEnabled, refreshVersion }) {
  const [records, setRecords] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(false);
  const busy = useRef(false);
  const serial = useRef(0);
  const refreshedVersion = useRef(refreshVersion);
  async function load(after = null) {
    if (busy.current) return;
    busy.current = true;
    const token = ++serial.current;
    setPending(true);
    setError("");
    try {
      const query = new URLSearchParams({ action: "cancellation_finances", memberId });
      if (after) query.set("after", after);
      const result = await readResponse(await adminFetch(`${endpoint}?${query}`, {}, tenantId));
      if (!alive.current || token !== serial.current) return;
      if (!Array.isArray(result?.records) || (result.nextCursor != null && typeof result.nextCursor !== "string")) {
        throw new Error("The server did not return a valid cancellation finance page.");
      }
      setRecords(previous => after
        ? [...previous, ...result.records.filter(item => !previous.some(old => old.id === item.id))]
        : result.records);
      setCursor(result.nextCursor || null);
      setLoaded(true);
    } catch (failure) {
      if (alive.current && token === serial.current) setError(failure.message || "Cancellation finances could not be loaded.");
    } finally {
      busy.current = false;
      if (alive.current && token === serial.current) setPending(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; serial.current += 1; busy.current = false; };
  }, []);
  useEffect(() => {
    if (pending || refreshedVersion.current === refreshVersion) return;
    refreshedVersion.current = refreshVersion;
    void load();
  }, [refreshVersion, pending]);
  return <section aria-label="Applied cancellation finances" className="rounded-md border p-4 space-y-4">
    <div className="space-y-1">
      <h3 className="font-medium">Applied cancellation finances</h3>
      <p className="text-sm text-muted-foreground">Review financial treatment for existing applied cancellations only. This does not create a cancellation, end access, or reactivate membership after payment.</p>
    </div>
    {pending && <div role="status" aria-label="Loading cancellation finances" className="space-y-2">
      <div className="h-4 w-2/3 rounded bg-muted" /><div className="h-16 rounded bg-muted" />
    </div>}
    {error && <div role="alert" className="space-y-2 text-sm">
      <p>Cancellation finances could not be loaded: {error}</p>
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => load(loaded ? cursor : null)}>Retry loading cancellation finances</Button>
    </div>}
    {loaded && !records.length && <p className="text-sm text-muted-foreground">No applied cancellations with financial records to review.</p>}
    {records.map(record => <CancellationFinanceRecord key={JSON.stringify([record.id, record.financial_state, record.effective_date, record.timing, record.access_ended_at])} record={record} memberId={memberId} tenantId={tenantId} actionsEnabled={actionsEnabled && !error} />)}
    {cursor && !error && <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => load(cursor)}>Load more cancellations</Button>}
  </section>;
}

function PlanSummary({ plan }) {
  return <div className="space-y-3 text-sm">
    <p className="font-medium">Treatment: {choices[plan.choice]}</p>
    <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {[["Earned balance to collect", plan.debtMinor], ["Returnable surplus", plan.surplusMinor], ["Prepaid value retained", plan.retainedPrepaidMinor]].map(([label, value]) =>
        <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{money(value, plan.currency)}</dd></div>)}
    </dl>
    <p>Return breakdown: net {money(plan.returnAmount?.netMinor, plan.currency)} · VAT {money(plan.returnAmount?.vatMinor, plan.currency)} · total {money(plan.returnAmount?.grossMinor, plan.currency)}.</p>
    <p>Credits against unpaid invoices reduce receivables; they are not spendable member credit.</p>
    {plan.choice === "credit" && <p>Member credit: {money(plan.surplusMinor, plan.currency)}. Credit expiry: {date(plan.creditExpiresAt)}.</p>}
    <ul className="list-disc pl-5 space-y-1" aria-label="Planned accounting operations">
      {plan.steps.map((step, index) => <li key={index}>
        {({ original_invoice: "Review original invoice (read-only)", credit_note: "Create accounting credit note", allocation: "Allocate credit against an invoice", invoice: "Create earned-service invoice", backing_payment: "Back member credit with liability accounting" })[step.kind] || "Accounting operation requires review"}
        {" · "}{money(step.kind === "allocation" ? step.amountMinor : step.amount?.grossMinor, plan.currency)}
      </li>)}
    </ul>
  </div>;
}

function CancellationFinanceRecord({ record, memberId, tenantId, actionsEnabled }) {
  const [choice, setChoice] = useState("");
  const [preview, setPreview] = useState(null);
  const [approval, setApproval] = useState(false);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState(null);
  const [recoveryOnly, setRecoveryOnly] = useState(false);
  const busy = useRef(false);
  const alive = useRef(false);
  const generation = useRef(0);
  const permission = useRef(actionsEnabled);
  permission.current = actionsEnabled;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { generation.current += 1; setPreview(null); setApproval(false); }, [actionsEnabled]);
  const done = record.financial_state === "settled" || outcome?.state === "done";
  const locked = !!pending || !actionsEnabled || done;
  function editChoice(value) {
    if (busy.current || recoveryOnly) return;
    setChoice(value);
    setPreview(null);
    setApproval(false);
    setError("");
    setOutcome(null);
  }
  async function run(action) {
    if (busy.current || !actionsEnabled || done) return;
    if (action === "preview_cancellation_finance" && recoveryOnly) return;
    if (action === "confirm_cancellation_finance" && (recoveryOnly || !preview || !approval)) return;
    busy.current = true;
    const token = generation.current;
    setPending(action);
    setError("");
    setApproval(false);
    const payload = { action, memberId, requestId: record.id };
    if (action === "preview_cancellation_finance") {
      setPreview(null);
      if (choice) payload.choice = choice;
    }
    if (action === "confirm_cancellation_finance") {
      payload.choice = preview.plan.choice;
      payload.expectedFingerprint = preview.fingerprint;
      payload.approve = true;
      // Any confirmation attempt consumes this grant. Never blindly repeat it.
      setRecoveryOnly(true);
      setPreview(null);
    }
    try {
      const result = await readResponse(await adminFetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      }, tenantId));
      if (!alive.current || !permission.current || token !== generation.current) return;
      if (action === "preview_cancellation_finance") {
        const plan = result?.plan;
        if (!plan || plan.version !== 1 || plan.requestId !== record.id || plan.memberId !== memberId
          || !Object.hasOwn(choices, plan.choice) || (choice && plan.choice !== choice)
          || !Array.isArray(plan.steps) || !/^[a-f0-9]{64}$/.test(result.fingerprint || "")
          || !/^[A-Z]{3}$/.test(plan.currency || "")
          || ![plan.debtMinor, plan.surplusMinor, plan.retainedPrepaidMinor].every(value => Number.isSafeInteger(value) && value >= 0)) {
          throw new Error("The server did not return a valid financial preview. Approval is unavailable.");
        }
        // Retain only the display plan and approval fingerprint, never provider evidence.
        setPreview({ plan, fingerprint: result.fingerprint });
      } else {
        if (!["done", "pending"].includes(result?.state)) throw new Error("Financial outcome is not confirmed. Recover this cancellation before any further approval.");
        setOutcome(result);
        setPreview(null);
        setRecoveryOnly(!(result.state === "pending" && result.needsApproval === true && !result.needsReview));
      }
    } catch (failure) {
      if (alive.current) {
        setError(failure.message || "Financial outcome is unknown. Recover this cancellation.");
        if (action !== "preview_cancellation_finance") { setRecoveryOnly(true); setPreview(null); }
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(null);
    }
  }
  return <article className="rounded-md border p-3 space-y-3 text-sm" aria-label={`Cancellation ${record.id}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium break-all">Cancellation {record.id}</h4>
      <Badge variant="outline">{done ? "Financially settled" : readable(record.financial_state)}</Badge>
    </div>
    <p>Effective: {date(record.effective_date)} · Timing: {readable(record.timing)} · Access ended: {date(record.access_ended_at)}</p>
    {!done && <>
      <div className="rounded-md bg-muted/50 p-3 space-y-1">
        <p>Approval can create accounting documents or spendable member credit. Refunds require recorded bank reconciliation; this does not send a cash refund itself.</p>
        <p>Recovery resumes an already approved plan, including its accounting operations. It never approves or chooses financial treatment.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`cancellation-choice-${record.id}`}>Cancellation financial treatment</Label>
        <select id={`cancellation-choice-${record.id}`} value={choice} onChange={event => editChoice(event.target.value)} disabled={locked || recoveryOnly} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
          <option value="">Preview server policy</option>
          {Object.entries(choices).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">The server validates policy and funding. Unsupported monthly or mixed funding requires review; no alternative treatment is inferred.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {!recoveryOnly && <Button type="button" variant="outline" disabled={locked} onClick={() => run("preview_cancellation_finance")}>{pending === "preview_cancellation_finance" ? "Preparing cancellation preview…" : "Preview cancellation finances"}</Button>}
        <Button type="button" variant="outline" disabled={locked} onClick={() => run("recover_cancellation_finance")}>{pending === "recover_cancellation_finance" ? "Recovering cancellation finances…" : "Recover approved cancellation finances"}</Button>
      </div>
    </>}
    {preview && !done && <div className="rounded-md border p-3 space-y-3" aria-live="polite">
      <h5 className="font-medium">Financial preview — not approved</h5>
      <PlanSummary plan={preview.plan} />
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={approval} disabled={locked || recoveryOnly} onChange={event => setApproval(event.target.checked)} />
        <span>I explicitly approve this financial plan and its accounting documents or member credit. I understand that a refund requires bank reconciliation and no cash is sent by this action.</span>
      </label>
      <Button type="button" disabled={locked || recoveryOnly || !approval} onClick={() => run("confirm_cancellation_finance")}>Approve cancellation financial plan</Button>
    </div>}
    {recoveryOnly && !done && <p role="status">Approval or execution outcome needs recovery. Confirmation is locked; recover the existing cancellation, do not repeat approval.</p>}
    {error && <p role="alert" className="text-amber-800 dark:text-amber-300">{error}</p>}
    {outcome && <div role="status" className="rounded-md bg-muted/50 p-3 space-y-1">
      <p className="font-medium">{outcome.state === "done" ? "Cancellation finances completed" : "Cancellation finances pending"}</p>
      {outcome.message && <p>{outcome.message}</p>}
      {outcome.balanceState && <p>Balance: {readable(outcome.balanceState)}</p>}
      {outcome.needsApproval && <p>No approved plan is recorded. Review a fresh preview and explicitly approve before execution.</p>}
      {outcome.needsReview && <p>Finance review and read-only reconciliation are required. No new treatment is approved here.</p>}
    </div>}
  </article>;
}
