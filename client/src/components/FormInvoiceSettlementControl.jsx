import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function valueLabel(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function SettlementResult({ result }) {
  const rows = [
    ["Invoice ID", result?.invoice_id],
    ["Invoice number", result?.invoice_number],
    ["Stripe PaymentIntent", result?.stripe_payment_intent_id || result?.payment?.stripe_payment_intent_id],
    ["Settlement state", result?.settlement_state],
    ["Payment recorded", result?.payment_recorded],
    ["Annotation recorded", result?.annotation_recorded],
    ["Clearing account", result?.account],
    ["Balance", result?.balance],
  ];

  return (
    <div className="rounded-md border">
      <dl className="divide-y text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-3 px-3 py-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium break-all">{valueLabel(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function contextLabel(key) {
  return String(key)
    .replace(/^quickbooks_/, "")
    .replace(/^xero_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ProviderContext({ context }) {
  const entries = context && typeof context === "object" ? Object.entries(context) : [];
  return (
    <div className="rounded-md border p-3 space-y-2" data-testid="settlement-provider-context">
      <p className="text-sm font-medium">Accounting company / realm / context</p>
      {entries.length > 0 ? (
        <dl className="space-y-1 text-sm">
          {entries.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-3">
              <dt className="text-muted-foreground">{contextLabel(key)}</dt>
              <dd className="font-medium break-all">{valueLabel(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-destructive">Provider context is unavailable.</p>
      )}
    </div>
  );
}

export default function FormInvoiceSettlementControl({ recordId, table, onSettled }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(null);
  const [response, setResponse] = useState(null);
  const [typedAccount, setTypedAccount] = useState("");
  const [providerContextAcknowledged, setProviderContextAcknowledged] = useState(false);
  const [lastAction, setLastAction] = useState(null);
  const [requestError, setRequestError] = useState("");

  const requestSettlement = async (payload) => {
    const fetchResponse = await fetch("/api/admin/form-invoice-settlement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    const data = await fetchResponse.json().catch(() => ({}));
    if (fetchResponse.status === 403) {
      throw new Error(data?.error || "You do not have finance permission to inspect or update this settlement.");
    }
    if (!fetchResponse.ok || !data?.ok) {
      throw new Error(data?.error || "Could not inspect the Stripe settlement.");
    }
    return data;
  };

  const inspect = async () => {
    setLoading(true);
    setRequestError("");
    setResponse(null);
    setTypedAccount("");
    setProviderContextAcknowledged(false);
    setLastAction(null);
    try {
      const data = await requestSettlement({ recordId, table });
      setResponse(data);
    } catch (error) {
      setRequestError(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (nextOpen) => {
    setOpen(nextOpen);
    if (nextOpen) inspect();
  };

  const execute = async (annotationOnly) => {
    if (!response?.planToken || !response?.result?.provider_context || !providerContextAcknowledged) return;
    if (!annotationOnly && !response.result.account) return;
    const action = annotationOnly ? "annotation" : "settlement";
    setExecuting(action);
    setRequestError("");
    try {
      const data = await requestSettlement({
        recordId,
        table,
        execute: true,
        planToken: annotationOnly ? response.annotationPlanToken : response.planToken,
        expectedProviderContext: response.result.provider_context,
        ...(annotationOnly
          ? { annotationOnly: true }
          : { expectedAccount: typedAccount }),
      });
      setResponse(data);
      setTypedAccount("");
      setProviderContextAcknowledged(false);
      setLastAction(action);
      if (annotationOnly) {
        if (data.result?.annotation_recorded) {
          toast.success("Stripe PaymentIntent reference added to the existing invoice");
        } else {
          toast.error(data.result?.error || "Stripe reference was not recorded");
        }
      } else if (data.result?.payment_recorded) {
        toast.success("Stripe settlement recorded on the existing invoice");
      } else {
        toast.error(data.result?.error || "Stripe payment was not recorded on the invoice");
      }
      onSettled?.();
    } catch (error) {
      setRequestError(error.message);
    } finally {
      setExecuting(null);
    }
  };

  const result = response?.result;
  const isDryRun = response?.dryRun === true;
  const settlementBlocked = isDryRun
    && (!result?.account || result?.settlement_state === "blocked");
  const accountMatches = !!result?.account && typedAccount === String(result.account);
  const hasProviderContext = !!result?.provider_context
    && typeof result.provider_context === "object"
    && Object.keys(result.provider_context).length > 0;
  const canAnnotate = isDryRun && result?.annotation_recorded !== true;
  const actionSucceeded = lastAction === "annotation"
    ? result?.annotation_recorded === true
    : result?.payment_recorded === true;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => handleOpenChange(true)}
        data-testid={`button-inspect-stripe-settlement-${recordId}`}
      >
        <Search className="mr-1 h-3.5 w-3.5" />
        Inspect Stripe settlement
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Inspect Stripe settlement</DialogTitle>
            <DialogDescription>
              This checks how to record the customer&apos;s existing Stripe payment against the linked invoice.
              It does not create a new invoice or charge the customer again.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Inspecting settlement…
            </div>
          ) : requestError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Settlement request failed</AlertTitle>
              <AlertDescription>{requestError}</AlertDescription>
            </Alert>
          ) : result ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Badge variant={isDryRun ? "outline" : "secondary"}>
                  {isDryRun
                    ? "Dry run — no changes made"
                    : (lastAction === "annotation" ? "Stripe reference result" : "Settlement result")}
                </Badge>
              </div>

              <SettlementResult result={result} />
              <ProviderContext context={result.provider_context} />

              {result.error && (
                <Alert variant={result.settlement_state === "blocked" ? "destructive" : "warning"}>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>{result.settlement_state === "blocked" ? "Settlement blocked" : "Inspection note"}</AlertTitle>
                  <AlertDescription>{result.error}</AlertDescription>
                </Alert>
              )}

              {!isDryRun && actionSucceeded && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>
                    {lastAction === "annotation" ? "Stripe reference action completed" : "Settlement action completed"}
                  </AlertTitle>
                  <AlertDescription>
                    {lastAction === "annotation"
                      ? "This action only adds the full Stripe PaymentIntent reference; it does not record an accounting payment."
                      : "No new invoice or Stripe charge was created; the customer had already paid."}
                  </AlertDescription>
                </Alert>
              )}

              {isDryRun && (
                <div className="flex items-start gap-2 rounded-md border p-3">
                  <Checkbox
                    id={`provider-context-${recordId}`}
                    checked={providerContextAcknowledged}
                    onCheckedChange={(checked) => setProviderContextAcknowledged(checked === true)}
                    disabled={!hasProviderContext}
                    data-testid={`checkbox-provider-context-${recordId}`}
                  />
                  <Label htmlFor={`provider-context-${recordId}`} className="font-normal leading-snug">
                    I confirm the accounting company, realm, and provider context shown above are the intended
                    destination for this invoice.
                  </Label>
                </div>
              )}

              {isDryRun && !settlementBlocked && (
                <div className="space-y-2">
                  <Label htmlFor={`settlement-account-${recordId}`}>
                    To confirm, type the clearing account exactly: <strong>{String(result.account)}</strong>
                  </Label>
                  <Input
                    id={`settlement-account-${recordId}`}
                    value={typedAccount}
                    onChange={(event) => setTypedAccount(event.target.value)}
                    autoComplete="off"
                    data-testid={`input-settlement-account-${recordId}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    Record settlement uses this clearing account on the existing invoice.
                  </p>
                </div>
              )}

              {isDryRun && !result.account && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Clearing account unavailable</AlertTitle>
                  <AlertDescription>
                    Recording an accounting payment is blocked until a clearing account is configured.
                    You can still use “Add Stripe reference only” below.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
            {canAnnotate && (
              <Button
                variant="outline"
                onClick={() => execute(true)}
                disabled={!providerContextAcknowledged || !hasProviderContext || !!executing}
                data-testid={`button-annotate-stripe-reference-${recordId}`}
              >
                {executing === "annotation" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Stripe reference only
              </Button>
            )}
            {isDryRun && !settlementBlocked && (
              <Button
                onClick={() => execute(false)}
                disabled={!accountMatches || !providerContextAcknowledged || !hasProviderContext || !!executing}
                data-testid={`button-execute-stripe-settlement-${recordId}`}
              >
                {executing === "settlement" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Record settlement
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}