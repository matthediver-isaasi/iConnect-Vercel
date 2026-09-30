import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

async function recoveryRequest(url, options) {
  const response = await fetch(url, { credentials: "include", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Monthly membership recovery request failed");
  return body;
}

function plainStatus(value) {
  return value ? String(value).replaceAll("_", " ") : "Unavailable";
}

export default function MonthlyMembershipRecoveryCard() {
  const queryClient = useQueryClient();
  const [agreements, setAgreements] = useState(null);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [directAgreementId, setDirectAgreementId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const loadList = async () => {
    setError("");
    setNotice("");
    try {
      const result = await recoveryRequest("/api/membership/monthly-recovery?limit=25");
      setAgreements(result.agreements || []);
    } catch (err) {
      setError(err.message);
      setAgreements([]);
    }
  };

  useEffect(() => { loadList(); }, []);

  const inspect = async (id) => {
    setBusy(true);
    setError("");
    setNotice("");
    setSelected(id);
    setPreview(null);
    setConfirmed(false);
    try {
      setPreview(await recoveryRequest(`/api/membership/monthly-recovery?agreementId=${encodeURIComponent(id)}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!selected || !confirmed) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await recoveryRequest("/api/membership/monthly-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreementId: selected, confirmed: true }),
      });
      if (result.waiting) {
        setError("The provider setup is still waiting. No recovery changes were made.");
        return;
      }
      if (result.alreadyComplete) {
        setNotice(result.outcome || "This agreement is already complete; no recovery mutation was run.");
        setConfirmed(false);
        return;
      }
      if (result.resumed !== true) {
        throw new Error(result.error || "Recovery was not completed. Re-preview the agreement before trying again.");
      }
      await Promise.all([
        loadList(),
        queryClient.invalidateQueries({ queryKey: ["/api/membership/payment-plan"] }),
      ]);
      setPreview(await recoveryRequest(`/api/membership/monthly-recovery?agreementId=${encodeURIComponent(selected)}`));
      setConfirmed(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="monthly-membership-recovery">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <RefreshCw className="w-4 h-4" />
          Pending Monthly Agreement Recovery
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Preview and explicitly resume validated form-originated monthly agreements. This is not a general provider recovery tool.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="monthly-recovery-agreement-id" className="text-xs">
            Inspect a known historical agreement ID
          </Label>
          <div className="flex gap-2">
            <Input
              id="monthly-recovery-agreement-id"
              value={directAgreementId}
              onChange={(event) => setDirectAgreementId(event.target.value.trim())}
              placeholder="Agreement ID"
              className="font-mono text-xs"
              data-testid="input-monthly-recovery-agreement-id"
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy || !directAgreementId}
              onClick={() => inspect(directAgreementId)}
              data-testid="inspect-monthly-recovery-agreement-id"
            >
              Inspect ID
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use this for older agreements or active agreements with incomplete local obligations that are not shown in the pending list.
          </p>
        </div>
        {error && (
          <div className="text-sm text-destructive flex items-start gap-2" role="alert">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}
        {notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
        {agreements === null ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading pending agreements...
          </div>
        ) : agreements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No form-originated monthly agreements are available to inspect.</p>
        ) : (
          <div className="space-y-2">
            {agreements.map((agreement) => (
              <div key={agreement.id} className="rounded-md border p-3 flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="flex gap-2 items-center">
                    <Badge variant="outline">{agreement.provider === "stripe" ? "Stripe card" : "GoCardless"}</Badge>
                    <Badge variant="secondary">{(agreement.status || "unknown").replaceAll("_", " ")}</Badge>
                    <span className="text-xs text-muted-foreground">{agreement.environment}</span>
                  </div>
                  <p className="text-xs font-mono text-muted-foreground mt-1">{agreement.id}</p>
                  {!agreement.supported && <p className="text-xs text-destructive mt-1">{agreement.unsupportedReason}</p>}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => inspect(agreement.id)}
                  data-testid={`preview-monthly-recovery-${agreement.id}`}
                >
                  Preview
                </Button>
              </div>
            ))}
          </div>
        )}

        {busy && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Revalidating provider records...</div>}

        {preview && (
          <div className="rounded-md border p-4 space-y-3" data-testid="monthly-recovery-preview">
            <p className="text-xs text-muted-foreground">
              Selected agreement: <span className="font-mono">{preview.agreement?.id || selected}</span>
            </p>
            <div className="text-sm grid grid-cols-2 gap-2">
              <span className="text-muted-foreground">Provider setup</span>
              <span>{plainStatus(preview.provider?.setupStatus)}</span>
              {preview.agreement?.provider === "gocardless" && (
                <>
                  <span className="text-muted-foreground">Mandate status</span>
                  <span>{plainStatus(preview.provider?.mandateStatus)}</span>
                  <span className="text-muted-foreground">Earliest possible charge</span>
                  <span>{preview.provider?.nextPossibleChargeDate || "Unavailable"}</span>
                  <span className="text-muted-foreground">Recoverable payment</span>
                  <span>{plainStatus(preview.provider?.recoverablePaymentStatus)}</span>
                </>
              )}
              {preview.agreement?.provider === "stripe" && (
                <>
                  <span className="text-muted-foreground">Latest invoice status</span>
                  <span>{plainStatus(preview.provider?.latestInvoiceStatus)}</span>
                  <span className="text-muted-foreground">Latest invoice paid</span>
                  <span>{preview.provider?.latestInvoicePaid ? "Yes" : "No"}</span>
                </>
              )}
              <span className="text-muted-foreground">Local plan</span>
              <span>{preview.local?.hasPlan ? plainStatus(preview.local.planStatus || "present") : "No plan"}</span>
              <span className="text-muted-foreground">Membership history</span>
              <span>{plainStatus(preview.local?.historyStatus)}</span>
              <span className="text-muted-foreground">Local payment status</span>
              <span>{plainStatus(preview.local?.paymentStatus)}</span>
              <span className="text-muted-foreground">Invoice mode</span>
              <span>{plainStatus(preview.terms?.invoicingMode || "unknown")}</span>
              <span className="text-muted-foreground">Activation rule</span>
              <span>{plainStatus(preview.terms?.activationRule || "unknown")}</span>
              <span className="text-muted-foreground">Recorded instalments</span>
              <span>{preview.local?.recordedInstalments ?? 0}</span>
              <span className="text-muted-foreground">Accounting recovery needed</span>
              <span>{preview.local?.accountingIncomplete ? "Yes" : "No"}</span>
            </div>
            {preview.proposedWork?.length > 0 && (
              <div>
                <p className="text-sm font-medium">Proposed work</p>
                <ul className="text-xs text-muted-foreground list-disc pl-5">
                  {preview.proposedWork.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            )}
            {preview.warnings?.map((warning) => (
              <p className="text-xs text-amber-700 dark:text-amber-400" key={warning}>{warning}</p>
            ))}
            {!preview.supported ? (
              <p className="text-sm text-destructive">{preview.unsupportedReason}</p>
            ) : !preview.canResume ? (
              <p className="text-sm text-muted-foreground">Provider setup is not fulfilled. Resume is unavailable and no mutation will run.</p>
            ) : (
              <>
                <div className="flex items-start gap-2">
                  <Checkbox id="confirm-monthly-recovery" checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
                  <Label htmlFor="confirm-monthly-recovery" className="text-xs leading-5">
                    I understand and explicitly confirm: {preview.confirmationDisclosure}
                  </Label>
                </div>
                <Button disabled={!confirmed || busy} onClick={resume} data-testid="confirm-monthly-recovery">
                  Confirm and resume
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}