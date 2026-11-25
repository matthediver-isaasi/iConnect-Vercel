import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Loader2, Lock, Repeat } from "lucide-react";
import { toast } from "sonner";
import MembershipOverrideControls from "./MembershipOverrideControls";
import { toEditorLine } from "./addonLineShape";
import MembershipAddonLinesEditor, { addonLinesAreValid, serializeAddonLines } from "./MembershipAddonLinesEditor";
import { formatCost } from "./membershipCost";

async function postReplace(body) {
  const response = await fetch("/api/membership/org-membership-replace", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "Request failed");
    error.code = payload.code;
    error.details = payload.details || null;
    throw error;
  }
  return payload;
}

function Row({ label, value, testId, strong = false }) {
  return (
    <div className="flex justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-semibold" : "font-medium"} data-testid={testId}>{value}</span>
    </div>
  );
}

/**
 * Guided flow for replacing the recorded current organisation membership
 * year. The period is read-only throughout; the server enforces it too.
 */
export default function ReplaceOrgMembershipYearDialog({
  open, onOpenChange, organizationId, record, currency,
  availableConfigs, configsLoading, membershipSettings, addonVatRates, onReplaced,
}) {
  const [reason, setReason] = useState("");
  const [changePricing, setChangePricing] = useState(true);
  const [overrideType, setOverrideType] = useState("structure");
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [discountType, setDiscountType] = useState("percentage");
  const [discountValue, setDiscountValue] = useState("");
  const [addonLines, setAddonLines] = useState([]);
  const [addonsTouched, setAddonsTouched] = useState(false);
  const [baseline, setBaseline] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // A credit note already raised in the accounting package (e.g. manually by
  // finance) that fully credits the original invoice. The admin must confirm
  // it before the replacement may adopt it instead of raising a new one.
  const [existingCreditNote, setExistingCreditNote] = useState(null);
  const [linkCreditNoteId, setLinkCreditNoteId] = useState(null);
  const idempotencyKey = useRef(null);

  // Reset whenever the dialog opens for a record.
  useEffect(() => {
    if (!open || !record?.id) return;
    idempotencyKey.current = crypto.randomUUID();
    setReason("");
    setChangePricing(true);
    setOverrideType("structure");
    setSelectedConfigId("");
    setManualPrice("");
    setDiscountType("percentage");
    setDiscountValue("");
    setAddonLines([]);
    setAddonsTouched(false);
    setPreview(null);
    setPreviewError(null);
    setBaseline(null);
    setExistingCreditNote(null);
    setLinkCreditNoteId(null);
  }, [open, record?.id, organizationId]);

  // Eligibility + original details (no override). Re-checked once an
  // existing credit note is confirmed for linking.
  useEffect(() => {
    if (!open || !record?.id) return;
    let cancelled = false;
    setPreviewError(null);
    postReplace({ action: "preview", organizationId, recordId: record.id, ...(linkCreditNoteId ? { linkCreditNoteId } : {}) })
      .then((result) => {
        if (cancelled) return;
        setBaseline(result.preview);
        setAddonLines((result.preview?.replacement?.addonLines || []).map(toEditorLine));
      })
      .catch((error) => {
        if (cancelled) return;
        if (error.code === "existing_credit_note" && error.details?.existingCreditNote && !linkCreditNoteId) {
          setExistingCreditNote(error.details.existingCreditNote);
          return;
        }
        setPreviewError(error.message);
      });
    return () => { cancelled = true; };
  }, [open, record?.id, organizationId, linkCreditNoteId]);

  const override = useMemo(() => {
    if (!changePricing) return null;
    if (overrideType === "structure") return selectedConfigId ? { overrideType, configId: selectedConfigId } : undefined;
    if (overrideType === "price") return manualPrice !== "" ? { overrideType, manualPrice } : undefined;
    return discountValue !== "" ? { overrideType, discountType, discountValue } : undefined;
  }, [changePricing, overrideType, selectedConfigId, manualPrice, discountType, discountValue]);

  // Any input change invalidates the shown preview.
  useEffect(() => { setPreview(null); }, [override, addonLines]);

  const original = baseline?.original;
  const addonsValid = addonLinesAreValid(addonLines);
  const requestBody = () => ({
    organizationId,
    recordId: record.id,
    override: override || null,
    ...(linkCreditNoteId ? { linkCreditNoteId } : {}),
    ...(addonsTouched ? { addonLines: serializeAddonLines(addonLines, membershipSettings) } : {}),
  });

  const runPreview = async () => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const result = await postReplace({ action: "preview", ...requestBody() });
      setPreview(result.preview);
    } catch (error) {
      setPreviewError(error.message);
    } finally {
      setPreviewing(false);
    }
  };

  const confirm = async () => {
    setSubmitting(true);
    try {
      const result = await postReplace({
        action: "execute",
        ...requestBody(),
        reason: reason.trim(),
        idempotencyKey: idempotencyKey.current,
        period: {
          membershipYear: original.membershipYear,
          termStartDate: original.termStartDate,
          termEndDate: original.termEndDate,
        },
      });
      if (result.operation?.sync_state === "complete") {
        toast.success("Membership year replaced");
      } else {
        toast.warning("Membership year replaced, but accounting sync needs attention. Use Retry in Fee History.");
      }
      onReplaced?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(error.message || "Could not replace the membership year");
    } finally {
      setSubmitting(false);
    }
  };

  const cur = original?.currency || currency;
  const canPreview = !!original && override !== undefined && addonsValid && !previewing;
  const canConfirm = !!preview && !!reason.trim() && !submitting;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle data-testid="text-replace-year-title">Replace {record?.membership_year || ""} membership</DialogTitle>
          <DialogDescription>
            The original record is retired and its invoice credited. A replacement for the same period is created with its own invoice.
          </DialogDescription>
        </DialogHeader>

        {existingCreditNote && !linkCreditNoteId && !previewError && (
          <div className="p-3 rounded-md border border-amber-500/40 bg-amber-500/5 space-y-3 text-sm" data-testid="section-replace-existing-credit">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">The original invoice has already been credited</p>
                <p className="text-muted-foreground">
                  Credit note <span className="font-medium text-foreground" data-testid="text-existing-credit-number">{existingCreditNote.number || existingCreditNote.id}</span>
                  {existingCreditNote.date ? ` dated ${existingCreditNote.date}` : ""} for {formatCost(existingCreditNote.amount, existingCreditNote.currency || currency)} fully
                  credits {record?.accounting_invoice_number || record?.xero_invoice_number || "the original invoice"}. If it was raised for this change,
                  link it to the replacement and no new credit note will be created. Only the new invoice will be raised.
                </p>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => setLinkCreditNoteId(existingCreditNote.id)} data-testid="button-link-existing-credit">
              Use credit note {existingCreditNote.number || ""} for this replacement
            </Button>
          </div>
        )}

        {!original && !previewError && !(existingCreditNote && !linkCreditNoteId) && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking this year can be replaced...
          </div>
        )}
        {previewError && (
          <div className="flex items-start gap-2 p-3 rounded-md border border-destructive/40 bg-destructive/5 text-sm" data-testid="text-replace-error">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-destructive shrink-0" />
            <span>{previewError}</span>
          </div>
        )}

        {original && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="replace-reason" className="text-sm font-medium">
                Reason <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="replace-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="Why is this year being replaced?"
                data-testid="textarea-replace-reason"
              />
            </div>

            <div className="p-3 rounded-md border bg-muted/30 space-y-1" data-testid="section-replace-original">
              <p className="text-sm font-medium flex items-center gap-1"><Lock className="w-3 h-3" /> Original (read-only)</p>
              <Row label="Period" value={`${original.membershipYear} · ${original.termStartDate || "?"} to ${original.termEndDate || "?"}`} testId="text-replace-period" />
              <Row label="Tier" value={original.tierLabel || "-"} />
              <Row label="Final cost (ex VAT)" value={formatCost(original.finalCost, cur)} />
              <Row label="Invoice" value={original.invoiceNumber ? `${original.invoiceNumber} (${original.invoiceStatus || "unknown"})` : "No invoice"} testId="text-replace-original-invoice" />
              {original.purchaseOrderNumber && <Row label="PO number (kept)" value={original.purchaseOrderNumber} />}
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="replace-change-pricing"
                  checked={changePricing}
                  onCheckedChange={(v) => setChangePricing(!!v)}
                  data-testid="checkbox-replace-change-pricing"
                />
                <Label htmlFor="replace-change-pricing" className="text-sm cursor-pointer">
                  Apply a structure, price or discount override to the replacement
                </Label>
              </div>
              {changePricing && (
                <MembershipOverrideControls
                  overrideType={overrideType} setOverrideType={setOverrideType}
                  selectedConfigId={selectedConfigId} setSelectedConfigId={setSelectedConfigId}
                  manualPrice={manualPrice} setManualPrice={setManualPrice}
                  discountType={discountType} setDiscountType={setDiscountType}
                  discountValue={discountValue} setDiscountValue={setDiscountValue}
                  availableConfigs={availableConfigs} configsLoading={configsLoading}
                  currency={cur} idPrefix="replace-" testIdPrefix="replace-"
                />
              )}
            </div>

            {(membershipSettings?.addon_freeform_enabled || addonLines.length > 0) && (
              <div className="space-y-3">
                <Label className="text-sm font-medium">Invoice add-on lines</Label>
                <MembershipAddonLinesEditor
                  lines={addonLines}
                  setLines={(updater) => { setAddonsTouched(true); setAddonLines(updater); }}
                  membershipSettings={membershipSettings}
                  addonVatRates={addonVatRates}
                  currency={cur}
                  allowTrainingFund={false}
                  testIdPrefix="replace-"
                />
              </div>
            )}

            <Button variant="outline" size="sm" onClick={runPreview} disabled={!canPreview} data-testid="button-replace-preview">
              {previewing && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              Preview replacement
            </Button>

            {preview && (
              <>
                <Separator />
                <div className="space-y-1" data-testid="section-replace-preview">
                  <p className="text-sm font-medium">Replacement for the same period</p>
                  <Row label="Period" value={`${preview.replacement.membershipYear} · ${preview.replacement.termStartDate || "?"} to ${preview.replacement.termEndDate || "?"}`} />
                  <Row label="Tier" value={preview.replacement.tierLabel || "-"} />
                  <Row label="Annual cost" value={formatCost(preview.replacement.annualCost, cur)} />
                  {preview.replacement.prorataCost != null && <Row label="Pro-rata" value={formatCost(preview.replacement.prorataCost, cur)} />}
                  {preview.replacement.freePeriodDiscount > 0 && <Row label="Free period" value={`-${formatCost(preview.replacement.freePeriodDiscount, cur)}`} />}
                  {preview.replacement.rolloverDiscount > 0 && <Row label="Rollover" value={`-${formatCost(preview.replacement.rolloverDiscount, cur)}`} />}
                  {preview.replacement.customDiscountTotal > 0 && <Row label="Discounts" value={`-${formatCost(preview.replacement.customDiscountTotal, cur)}`} />}
                  <Row label="Membership fee (ex VAT)" value={formatCost(preview.replacement.finalCost, cur)} />
                  <Row label="VAT" value={formatCost(preview.replacement.vatAmount + (preview.replacement.addonTotals?.vat || 0), cur)} />
                  {preview.replacement.addonLines?.length > 0 && (
                    <Row label="Add-ons (ex VAT)" value={formatCost(preview.replacement.addonTotals?.subtotal, cur)} />
                  )}
                  <Row label="Replacement total" value={formatCost(preview.replacement.total, cur)} strong testId="text-replace-total" />
                </div>
                <div className="p-3 rounded-md border space-y-1" data-testid="section-replace-accounting">
                  <p className="text-sm font-medium flex items-center gap-1"><Repeat className="w-3 h-3" /> Accounting actions ({preview.accounting.provider})</p>
                  {preview.accounting.existingCreditNote ? (
                    <Row label={`Existing credit note ${preview.accounting.existingCreditNote.number || ""} linked (no new credit note)`} value={formatCost(preview.accounting.creditNoteAmount, cur)} testId="text-replace-credit-amount" />
                  ) : preview.accounting.creditNoteAmount > 0 ? (
                    <Row label={`Credit note against ${preview.original.invoiceNumber || "original invoice"}`} value={formatCost(preview.accounting.creditNoteAmount, cur)} testId="text-replace-credit-amount" />
                  ) : (
                    <Row label="Credit note" value="Not required" testId="text-replace-credit-amount" />
                  )}
                  <Row label="New invoice" value={preview.accounting.newInvoiceAmount > 0 ? formatCost(preview.accounting.newInvoiceAmount, cur) : "Not required"} testId="text-replace-invoice-amount" />
                  {preview.accounting.paidCreditToApply > 0 && (
                    <Row label="Already paid, applied to new invoice" value={`-${formatCost(preview.accounting.paidCreditToApply, cur)}`} />
                  )}
                  <Row label="Amount due on new invoice" value={formatCost(preview.accounting.amountDue, cur)} strong testId="text-replace-amount-due" />
                  {preview.accounting.surplusCredit > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {formatCost(preview.accounting.surplusCredit, cur)} stays as unallocated credit in the accounting package for finance to refund or use.
                    </p>
                  )}
                  {preview.accounting.newInvoiceAmount > 0 && (
                    <p className="text-xs text-muted-foreground">The new invoice is emailed to the organisation's invoicing email.</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting} data-testid="button-cancel-replace">Cancel</Button>
          <Button onClick={confirm} disabled={!canConfirm} data-testid="button-confirm-replace">
            {submitting && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            Replace membership year
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
