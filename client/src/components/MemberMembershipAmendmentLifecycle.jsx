import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { adminFetch } from "@/lib/adminFetch";

const treatments = {
  collect: "Collect additional payment by Xero invoice",
  credit: "Retain a Xero credit note (not a cash refund)",
  refund: "Record a manual, bank-reconciled refund in Xero",
  none: "Verify zero financial difference",
};
const stateLabel = value => value ? String(value).replaceAll("_", " ") : "Not supplied";
const stamp = value => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "Not supplied";
};
function paymentLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function isLifecycle(value) {
  return value && Object.hasOwn(value, "settlement") && Object.hasOwn(value, "application") &&
    Array.isArray(value.notifications) &&
    (value.settlement === null || (value.settlement && typeof value.settlement.state === "string")) &&
    (value.application === null || (!!value.application?.id &&
      !!value.application.snapshot?.targetSnapshot?.config?.id &&
      typeof value.application.effective_date === "string" && typeof value.application.expires_on === "string"));
}

// The proposal is immutable. Only the separate, server-owned lifecycle is live.
// No amount, payer, document ID, quote fingerprint or new operation key is sent
// by these actions. Settlement reservation/recovery is keyed by amendmentId.
export default function MemberMembershipAmendmentLifecycle({
  amendment, lifecycle, capabilities = {}, eligibleSource, onUpdate, onRefresh,
  tenantId, readResponse, refreshing = false, actionsEnabled = true,
}) {
  const [choice, setChoice] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [pending, setPending] = useState(null);
  const [failure, setFailure] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [validationRejected, setValidationRejected] = useState(false);
  const inFlight = useRef(false);
  const active = useRef(true);
  const reservedChoice = useRef(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const available = isLifecycle(lifecycle);
  const settlement = available ? lifecycle.settlement : null;
  const application = available ? lifecycle.application : null;
  const notifications = available ? lifecycle.notifications : [];
  const state = settlement?.state;
  const delta = amendment.quote?.delta;
  const parts = [delta?.netMinor, delta?.vatMinor, delta?.grossMinor];
  const consistent = parts.every(Number.isSafeInteger) &&
    delta.netMinor + delta.vatMinor === delta.grossMinor;
  const positive = consistent && delta.grossMinor > 0 && delta.netMinor >= 0 && delta.vatMinor >= 0;
  const negative = consistent && delta.grossMinor < 0 && delta.netMinor <= 0 && delta.vatMinor <= 0;
  const zero = consistent && parts.every(value => value === 0);
  const today = new Date().toISOString().slice(0, 10);
  const choices = [
    ...(positive && capabilities.invoice === true ? ["collect"] : []),
    ...(negative && capabilities.retainedCredit === true ? ["credit"] : []),
    ...(negative && capabilities.refund === true ? ["refund"] : []),
    ...(zero && capabilities.apply === true ? ["none"] : []),
  ];
  const canStart = actionsEnabled && available && eligibleSource && !settlement && !application && !unconfirmed &&
    ["pending_settlement", "pending_application"].includes(amendment.status) &&
    typeof amendment.quote?.currency === "string" && /^[A-Z]{3}$/.test(amendment.quote.currency) &&
    !!amendment.quote?.targetSnapshot?.config?.id &&
    amendment.quote?.effectiveDate === today &&
    amendment.quote?.financialDirection !== "tax_adjustment" && choices.length > 0;
  const canReconcile = available && capabilities.reconcile === true && !application &&
    (["reserved", "awaiting_payment", "uncertain", "settled"].includes(state) || unconfirmed);
  const canApply = actionsEnabled && available && capabilities.apply === true && state === "settled" && !application;
  const canNotify = actionsEnabled && available && capabilities.notifications === true && notifications.some(item => item.state === "pending");
  const lockedChoice = settlement?.choice || reservedChoice.current;
  const url = settlement?.choice === "collect" && state === "awaiting_payment"
    ? paymentLink(settlement.evidence?.paymentUrl) : null;

  async function run(action) {
    if (inFlight.current) return;
    if (action === "settle" && (!canStart || !choices.includes(choice) || !reviewing ||
        (reservedChoice.current && reservedChoice.current !== choice))) return;
    if ((action === "reconcile" && !canReconcile) || (action === "apply" && !canApply) || (action === "notify" && !canNotify)) return;
    const payload = { action, amendmentId: amendment.id };
    if (action === "settle") {
      reservedChoice.current = choice;
      payload.settlementChoice = choice;
    }
    inFlight.current = true;
    setPending(action);
    setFailure("");
    try {
      const result = await readResponse(await adminFetch("/api/membership/member-amendments", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      }, tenantId));
      if (!active.current) return;
      if (!isLifecycle(result) || (action === "settle" && !result.settlement) ||
          (action === "apply" && !result.application)) {
        throw new Error("The server did not confirm the action outcome. Refresh history or reconcile; do not start another financial operation.");
      }
      setUnconfirmed(false);
      setValidationRejected(false);
      setReviewing(false);
      onUpdate(amendment.id, result);
    } catch (error) {
      if (!active.current) return;
      if (action === "settle") {
        // This explicit 422 is the production prepare/validation rejection.
        // Provider-write failures are instead classified as uncertain by the
        // service. Only this definitive rejection permits same-payload review.
        const rejected = error.status === 422
          && ["finance_evidence_required", "operational_scope_unsupported"].includes(error.code);
        setValidationRejected(rejected);
        setUnconfirmed(!rejected);
      }
      setReviewing(false);
      setFailure(`${error.message || "Action failed; no outcome has been confirmed."}${error.code ? ` (${error.code})` : ""}`);
      // A failed HTTP response can follow a durable reservation/provider write.
      // Refresh facts, never automatically retry a financial or delivery action.
      void onRefresh();
    } finally {
      inFlight.current = false;
      if (active.current) setPending(null);
    }
  }

  return <div className="border-t pt-3 space-y-3" data-testid={`amendment-lifecycle-${amendment.id}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">Current settlement and application</h4>
      <Badge variant="outline">{application ? "Applied" : state === "applied" ? "Application not confirmed" : state ? stateLabel(state) : available ? "Not started" : "Not confirmed"}</Badge>
    </div>
    {!available && <p className="text-muted-foreground">The server has not supplied lifecycle evidence. Financial and application actions are unavailable.</p>}
    {available && !settlement && !application && <p>No settlement or membership application is recorded. The saved proposal is not a payment receipt.</p>}
    {lockedChoice && <p>Financial treatment: {treatments[lockedChoice] || stateLabel(lockedChoice)}. This choice is locked; a retained credit cannot also be refunded.</p>}
    {settlement && <div className="space-y-1">
      <p>Provider: {settlement.evidence?.provider || settlement.context?.provider || "Not supplied"}. Reconciliation: {stateLabel(state)}.</p>
      {state === "reserved" && <p>Operation reserved. Provider completion is not confirmed. Reconcile before taking further action.</p>}
      {state === "uncertain" && <p role="status">Provider outcome is uncertain. Do not create a replacement request or repeat a money operation. Reconcile existing evidence.</p>}
      {state === "awaiting_payment" && <p>{settlement.choice === "refund"
        ? "Awaiting a recorded manual refund. No automatic cash transfer has been made."
        : "Invoice issued; additional payment is not yet verified. Membership has not been applied."}</p>}
      {settlement.evidence?.instruction && <p className="whitespace-pre-wrap">{settlement.evidence.instruction}</p>}
      {settlement.choice === "refund" && settlement.context?.reference && state === "awaiting_payment" && <p className="break-all">Required Xero refund payment reference: {settlement.context.reference}:refund. Reconciliation requires the exact quoted refund amount, a bank-reconciled payment against this credit note, and no invoice allocation.</p>}
      {state === "settled" && <p>{settlement.choice === "credit"
        ? "Retained credit verified. This is not a cash refund."
        : settlement.choice === "refund" ? "Bank-reconciled manual refund verified."
          : settlement.choice === "none" ? "Zero financial difference verified."
            : "Additional invoice payment verified."} Membership application is a separate step.</p>}
      {state === "conflict" && <p role="alert">Review required. The settlement cannot authorise membership application. Recorded financial evidence is retained; do not issue another collection or refund.</p>}
      {state === "applied" && !application && <p role="alert">Settlement reports applied, but no membership application record was returned. Refresh history; changed entitlement cannot be confirmed from this response.</p>}
      {settlement.error_code && <p role="alert">Reconciliation error: {settlement.error_code}</p>}
      {url && <a href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Open collection invoice</a>}
      {state === "awaiting_payment" && settlement.choice === "collect" && !url && <p className="text-muted-foreground">No secure payment link was returned. Contact finance using the recorded document reference.</p>}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
        <div className="break-all"><dt className="text-muted-foreground">Provider document</dt><dd>{settlement.evidence?.documentId || "Not confirmed"}</dd></div>
        <div className="break-all"><dt className="text-muted-foreground">Accounting reference</dt><dd>{settlement.evidence?.reference || settlement.context?.reference || "Not supplied"}</dd></div>
        <div className="break-all"><dt className="text-muted-foreground">Last lifecycle update (UTC)</dt><dd>{stamp(settlement.updated_at)}</dd></div>
        <div className="break-all"><dt className="text-muted-foreground">Next recovery attempt (UTC)</dt><dd>{stamp(settlement.next_attempt_at)}</dd></div>
      </dl>
      <details className="rounded-md bg-muted/50 p-3">
        <summary className="cursor-pointer font-medium">Provider reconciliation evidence</summary>
        <p className="pt-2 break-all">Settlement record: {settlement.id || "Not supplied"} · Actor: {settlement.actor_id || "Not supplied"}</p>
        <p className="break-all">Original invoice: {settlement.evidence?.sourceInvoiceId || settlement.context?.sourceInvoiceId || "Not supplied"}</p>
        <pre className="whitespace-pre-wrap break-all text-xs pt-2">{JSON.stringify(settlement.evidence || {}, null, 2)}</pre>
      </details>
    </div>}
    {application ? <div className="rounded-md border p-3 space-y-1" role="status">
      <p className="font-medium">Applied membership history</p>
      <p>{application.snapshot?.targetSnapshot?.config?.name || "Target structure not supplied"} · {application.snapshot?.targetSnapshot?.band?.label || application.snapshot?.targetSnapshot?.band?.name || (application.snapshot?.targetSnapshot?.config?.pricing_model === "flat" ? "Flat price" : "Band not supplied")}</p>
      <p>Effective: {application.effective_date || "Not supplied"}. Original term boundary: {application.expires_on || "Not supplied"} (exclusive).</p>
      <p>Applied at (UTC): {stamp(application.created_at)}</p>
      <p className="break-all">Applied by: {application.applied_by || "Not supplied"} · Application: {application.id}</p>
      <p className="break-all">Original purchase: {application.source_record_id || amendment.source_record_id || "Not supplied"}</p>
      <p>The original purchase and consent remain unchanged. This application is a separate, term-limited membership revision.</p>
    </div> : available && <p>Membership application: not recorded. A provider document or settlement alone does not confirm changed entitlement.</p>}
    {canStart && <div className="rounded-md border p-3 space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`amend-treatment-${amendment.id}`}>Financial treatment</Label>
        <select id={`amend-treatment-${amendment.id}`} value={choice} disabled={!!pending || reviewing || !!reservedChoice.current} onChange={event => setChoice(event.target.value)} className="flex min-h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="">Choose financial treatment</option>
          {choices.map(value => <option key={value} value={value}>{treatments[value]}</option>)}
        </select>
      </div>
      {choice === "refund" && <p>Creates a credit note for a manual refund, not a bank transfer. Finance must pay and bank-reconcile the exact refund in Xero before application.</p>}
      {choice === "credit" && <p>Leaves a credit note with the original payer. No cash is refunded. This choice cannot later be switched to refund.</p>}
      {reviewing ? <div className="space-y-2" role="group" aria-label="Confirm financial treatment">
        <p>Confirm: {treatments[choice]}. Uses the immutable recorded adjustment above and the verified original invoice payer, not an editable member contact. The server will validate eligibility again.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!!pending} onClick={() => run("settle")}>{pending === "settle" ? "Submitting settlement…" : "Confirm settlement"}</Button>
          <Button variant="outline" size="sm" disabled={!!pending} onClick={() => setReviewing(false)}>Cancel settlement review</Button>
        </div>
      </div> : <Button variant="outline" size="sm" disabled={!choices.includes(choice) || !!pending} onClick={() => setReviewing(true)}>{validationRejected ? "Review settlement retry" : "Review settlement"}</Button>}
    </div>}
    {available && !settlement && !application && !canStart && !unconfirmed && <p className="text-muted-foreground">Settlement is unavailable for this record, its financial direction, or your returned capabilities. Unsupported monthly/provider-linked changes are not processed here.</p>}
    {available && !settlement && !application && amendment.quote?.effectiveDate && amendment.quote.effectiveDate !== today && <p>Initial settlement requires the proposal effective date to be today (UTC). This record requires finance review; no cancellation, replacement or repricing action is connected here.</p>}
    {failure && <div role="alert" className="space-y-1"><p>{failure}</p>{unconfirmed && <p>The settlement outcome is unconfirmed. The selected treatment is locked locally; use reconciliation, not another settlement attempt.</p>}{validationRejected && <p>Settlement validation was rejected; no success is confirmed. After correcting the reported evidence, review a retry of this same amendment and financial treatment.</p>}</div>}
    <div className="flex flex-wrap gap-2">
      {canReconcile && <Button variant="outline" size="sm" disabled={!!pending} onClick={() => run("reconcile")}>{pending === "reconcile" ? "Reconciling…" : "Reconcile provider status"}</Button>}
      {canApply && <Button size="sm" disabled={!!pending} onClick={() => run("apply")}>{pending === "apply" ? "Applying membership…" : "Apply verified membership change"}</Button>}
      <Button variant="outline" size="sm" disabled={!!pending || refreshing} onClick={() => { void onRefresh(); }}>{refreshing ? "Refreshing amendment history…" : "Refresh amendment history"}</Button>
    </div>
    {available && <div className="space-y-2">
      <p className="font-medium">Notifications</p>
      {!notifications.length ? <p className="text-muted-foreground">No notification delivery recorded.</p> : <ul className="space-y-2">{notifications.map(item => <li key={item.id || item.kind} className="rounded-md bg-muted/50 p-2">
        <p>{stateLabel(item.kind)}: {stateLabel(item.state)}</p>
        <p>Last update (UTC): {stamp(item.updated_at)}</p>
        {item.evidence?.messageId && <p className="break-all">Delivery reference: {item.evidence.messageId}</p>}
        {item.evidence?.reason && <p>{stateLabel(item.evidence.reason)}</p>}
        {["sending", "uncertain"].includes(item.state) && <p>Delivery is not confirmed. Automatic resend is withheld to avoid duplicate messages.</p>}
      </li>)}</ul>}
      {canNotify && <Button variant="outline" size="sm" disabled={!!pending} onClick={() => run("notify")}>{pending === "notify" ? "Retrying pending delivery…" : "Retry pending notifications"}</Button>}
    </div>}
  </div>;
}
