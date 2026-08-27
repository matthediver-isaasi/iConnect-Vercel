import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Layers, Save, Loader2, CalendarDays, TrendingUp,
  History, AlertCircle, Wallet, ArrowRight, Pencil, X, ShieldAlert,
  FileText, Send, PlayCircle, CheckCircle2, XCircle, Info, AlertTriangle, Mail,
  Lock, LockOpen, ShieldCheck, Users, Plus, ArrowLeft, Link2, Eye, Download, RefreshCw
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import MemberJoinLinkSection from "@/components/MemberJoinLinkSection";
import { useMemberTerminology } from "@/contexts/MemberTerminologyContext";
import { getMembershipHistoryLifecycle } from "@/lib/membershipHistoryLifecycle";

function PaymentStatusBadge({ paymentStatus }) {
  const status = paymentStatus || 'unpaid';
  const variantMap = { paid: 'secondary', partial: 'warning', voided: 'destructive', unpaid: 'outline' };
  const labelMap = { paid: 'Paid', partial: 'Partial', voided: 'Voided', unpaid: 'Unpaid' };
  return (
    <Badge variant={variantMap[status] || 'outline'} data-testid={`badge-payment-${status}`}>
      {labelMap[status] || status}
    </Badge>
  );
}

function getCurrencySymbol(code) {
  const map = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };
  return map[code] || code;
}

function formatCost(value, currency) {
  if (value === null || value === undefined) return '-';
  const symbol = getCurrencySymbol(currency);
  return `${symbol}${parseFloat(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function YearCostSection({
  yearData,
  yearLabel,
  currency,
  periodLabel,
  fieldLabel,
  configName,
  isNewOrg,
  goLiveDate,
  showRecordFee,
  currentYearRecorded,
  recordMutation,
  organizationId,
  onOpenOverride,
  onRemoveOverride,
  removeOverridePending,
  onSimulate,
  simulatePending,
  testIdPrefix,
  invoicingMode,
  invoiceDate,
  onInvoicingModeChange,
  onInvoiceDateChange,
  onSaveInvoicing,
  invoicingSaving,
  onManualRenewal,
  manualRenewalPending,
  purchaseOrderNumber,
  onPurchaseOrderChange,
  poSuppliedByMember,
  onEmailFees,
  emailFeesPending,
  hideInvoicing,
  onlineCardPayment,
  approvalRequired,
  feesApproved,
  onApprove,
  onUnapprove,
  approvePending,
  isFlat,
  showAdvanceInvoice,
  onAdvanceInvoice,
  advanceInvoicePending,
  advanceInvoiceRecord,
}) {
  const [poUnlocked, setPoUnlocked] = useState(false);
  const { memberLabel } = useMemberTerminology();
  const isPoLocked = poSuppliedByMember && !poUnlocked;

  if (!yearData) return null;

  const hasOverride = !!yearData.overrideType;
  const invoiceSent = !!advanceInvoiceRecord;
  const advanceInvoiceNumber = advanceInvoiceRecord?.accounting_invoice_number || advanceInvoiceRecord?.xero_invoice_number || null;
  const advanceInvoiceDate = advanceInvoiceRecord?.created_at
    ? new Date(advanceInvoiceRecord.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const advanceActivationDate = advanceInvoiceRecord?.scheduled_activation_date
    ? new Date(advanceInvoiceRecord.scheduled_activation_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  return (
    <div data-testid={`section-${testIdPrefix}`} className={approvalRequired && feesApproved ? 'rounded-md border border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/30 p-3 -m-1' : ''}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            <Wallet className="w-3 h-3" />
            {yearLabel}
          </p>
          {isNewOrg && testIdPrefix === 'current-year' && (
            <Badge variant="outline" className="text-xs">New {memberLabel}</Badge>
          )}
          {approvalRequired && feesApproved && (
            <Badge variant="outline" className="text-xs text-green-700 border-green-300 dark:text-green-400 dark:border-green-700" data-testid={`badge-approved-${testIdPrefix}`}>
              <ShieldCheck className="w-3 h-3 mr-1" />
              Approved
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {!currentYearRecorded && !feesApproved && (
            <Button
              size="sm"
              variant={hasOverride ? "secondary" : "outline"}
              onClick={() => onOpenOverride(yearData.membershipYear)}
              data-testid={`button-override-${testIdPrefix}`}
            >
              <Pencil className="w-3 h-3 mr-1" />
              {hasOverride ? 'Edit Override' : 'Override'}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => onSimulate(yearData.membershipYear)}
            disabled={simulatePending}
            data-testid={`button-simulate-${testIdPrefix}`}
          >
            {simulatePending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <PlayCircle className="w-3 h-3 mr-1" />}
            Simulate
          </Button>
        </div>
      </div>
      <p className="font-semibold" data-testid={`text-year-${testIdPrefix}`}>{yearData.membershipYear}</p>

      {isNewOrg && testIdPrefix === 'current-year' && goLiveDate && (
        <p className="text-xs text-muted-foreground mt-1">
          Go-live date: {new Date(goLiveDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
        </p>
      )}

      {hasOverride && (
        <div className="mt-2 p-2 rounded-md bg-warning/10 dark:bg-warning/30 border border-warning/30 dark:border-warning">
          <div className="flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 text-warning dark:text-warning mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-warning dark:text-warning">
                {yearData.overrideType === 'price' ? 'Manual Price Override' : yearData.overrideType === 'discount' ? 'Discount Override' : 'Structure Override'}
                {yearData.overrideConfigName && ` - ${yearData.overrideConfigName}`}
                {yearData.overrideType === 'discount' && yearData.overrideDiscountType === 'percentage' && ` (${yearData.overrideDiscountValue}%)`}
                {yearData.overrideType === 'discount' && yearData.overrideDiscountType === 'fixed' && ` (${formatCost(yearData.overrideDiscountValue, currency)})`}
              </p>
              {yearData.overrideNote && (
                <p className="text-xs text-warning dark:text-warning mt-0.5">{yearData.overrideNote}</p>
              )}
              {yearData.originalAnnualCost !== undefined && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Original: <span className="line-through">{formatCost(yearData.originalAnnualCost, currency)}</span>
                </p>
              )}
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onRemoveOverride(yearData.membershipYear)}
              disabled={removeOverridePending}
              data-testid={`button-remove-override-${testIdPrefix}`}
            >
              {removeOverridePending ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-2 p-3 bg-muted/50 rounded-md space-y-1">
        {yearData.startDate && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Start Date</span>
            <span className="font-medium">{new Date(yearData.startDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          </div>
        )}
        {!isFlat && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Based on {fieldLabel}</span>
            <span className="font-medium">{yearData.fieldValue?.toLocaleString() ?? 'N/A'}</span>
          </div>
        )}
        {configName && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Structure</span>
            <span className="font-medium">{yearData.overrideConfigName || yearData.resolvedConfigName || configName}</span>
          </div>
        )}
        {!isFlat && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Tier</span>
            <Badge variant="secondary">{yearData.tierLabel || 'Unmapped'}</Badge>
          </div>
        )}
        {hasOverride && yearData.overrideType === 'price' ? (
          <>
            <div className="flex items-center justify-between text-sm border-t pt-1">
              <span className="text-muted-foreground font-medium">
                {showRecordFee && currentYearRecorded ? 'Recorded Cost' : 'Final Cost'}
              </span>
              <span className="font-semibold">
                <Badge variant="outline" className="mr-1 text-xs">Override</Badge>
                {formatCost(yearData.finalCost, currency)}
              </span>
            </div>
            {yearData.vatRatePercent > 0 && yearData.vatAmount > 0 && (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">VAT ({yearData.vatRatePercent}%{yearData.taxLabel ? ` - ${yearData.taxLabel}` : ''})</span>
                  <span className="font-medium">{formatCost(yearData.vatAmount, currency)}</span>
                </div>
                <div className="flex items-center justify-between text-sm border-t pt-1">
                  <span className="text-muted-foreground font-medium">Total (incl. VAT)</span>
                  <span className="font-semibold">{formatCost(yearData.totalWithVat, currency)}</span>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{periodLabel} Cost (Gross)</span>
              <span className="font-medium">{formatCost(yearData.annualCostBeforeDiscounts ?? yearData.annualCost, currency)}</span>
            </div>
            {(yearData.customDiscountTotal > 0 || (hasOverride && yearData.overrideType === 'discount')) && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {hasOverride && yearData.overrideType === 'discount' ? (
                    <><Badge variant="outline" className="mr-1 text-xs">Override</Badge>Custom Discount</>
                  ) : 'Custom Discount'}
                </span>
                <span className={yearData.customDiscountTotal > 0 ? 'text-green-600' : 'font-medium'}>
                  {yearData.customDiscountTotal > 0 ? `-${formatCost(yearData.customDiscountTotal, currency)}` : formatCost(0, currency)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{periodLabel} Cost (Net)</span>
              <span className="font-medium">{formatCost(yearData.annualCost, currency)}</span>
            </div>
            {yearData.dailyCost != null && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Daily Cost</span>
                <span className="font-medium">{formatCost(yearData.dailyCost, currency)}</span>
              </div>
            )}
            {yearData.proRataEnabled && yearData.prorataDays !== null && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Pro-rata ({yearData.prorataDays} days {'\u00d7'} {formatCost(yearData.dailyCost, currency)})</span>
                <span className="font-medium">{formatCost(yearData.prorataCost, currency)}</span>
              </div>
            )}
            {(yearData.freeDiscount > 0 || (yearData.isNewOrg && yearData.freePeriodAmount && yearData.freePeriodUnit)) && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {yearData.freePeriodUnit === 'percent'
                    ? `New Member Discount (${yearData.freePeriodAmount}%)${yearData.yearNumber === 2 ? ' (rollover from Y1)' : ''}`
                    : yearData.yearNumber === 2 && yearData.freeDiscount > 0
                      ? `New Member Discount (${yearData.freePeriodDaysApplied} days rollover)`
                      : `New Member Discount (${yearData.freePeriodDaysApplied} free days${yearData.dailyCost ? ` ${'\u00d7'} ${formatCost(yearData.dailyCost, currency)}` : ''})`}
                </span>
                <span className={yearData.freeDiscount > 0 ? 'text-green-600' : 'font-medium'}>
                  {yearData.freeDiscount > 0 ? `-${formatCost(yearData.freeDiscount, currency)}` : formatCost(0, currency)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between text-sm border-t pt-1">
              <span className="text-muted-foreground font-medium">
                {showRecordFee && currentYearRecorded ? 'Recorded Cost' : 'Final Cost'}
              </span>
              <span className="font-semibold">{formatCost(yearData.finalCost, currency)}</span>
            </div>
            {yearData.vatRatePercent > 0 && yearData.vatAmount > 0 && (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">VAT ({yearData.vatRatePercent}%{yearData.taxLabel ? ` - ${yearData.taxLabel}` : ''})</span>
                  <span className="font-medium">{formatCost(yearData.vatAmount, currency)}</span>
                </div>
                <div className="flex items-center justify-between text-sm border-t pt-1">
                  <span className="text-muted-foreground font-medium">Total (incl. VAT)</span>
                  <span className="font-semibold">{formatCost(yearData.totalWithVat, currency)}</span>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {showRecordFee && (
        <div className="mt-2">
          {currentYearRecorded ? (
            <Badge variant="secondary">
              Recorded: {formatCost(currentYearRecorded.final_cost, currency)}
            </Badge>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => recordMutation.mutate({ organizationId, membershipYear: yearData.membershipYear })}
              disabled={recordMutation.isPending}
              data-testid="button-record-current"
            >
              {recordMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Wallet className="w-3 h-3 mr-1" />}
              Record {yearData.membershipYear} Fee
            </Button>
          )}
        </div>
      )}

      {!hasOverride && !isFlat && (
        <p className="text-xs text-muted-foreground mt-2">
          Based on current {fieldLabel.toLowerCase()} and the active tier structure. This may change if the {fieldLabel.toLowerCase()} or structure is updated.
        </p>
      )}

      {currentYearRecorded ? (
        <>
          <Separator className="my-3" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`text-invoicing-complete-${testIdPrefix}`}>
            <FileText className="w-3 h-3" />
            <span>Fee recorded for {yearData.membershipYear} — invoicing controls hidden</span>
          </div>
        </>
      ) : hideInvoicing ? (
        <>
          <Separator className="my-3" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`text-invoicing-pending-${testIdPrefix}`}>
            <FileText className="w-3 h-3" />
            <span>Invoicing controls will be available once the current year has been processed</span>
          </div>
        </>
      ) : onlineCardPayment ? (
        <>
          <Separator className="my-3" />
          {approvalRequired && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              {feesApproved ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onUnapprove}
                  disabled={approvePending}
                  data-testid={`button-unapprove-${testIdPrefix}`}
                >
                  {approvePending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <XCircle className="w-3 h-3 mr-1" />}
                  Unapprove
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="default"
                  onClick={onApprove}
                  disabled={approvePending}
                  data-testid={`button-approve-${testIdPrefix}`}
                >
                  {approvePending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <ShieldCheck className="w-3 h-3 mr-1" />}
                  Approve Fees
                </Button>
              )}
            </div>
          )}
          <div className="flex items-start gap-2 p-3 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800" data-testid={`text-online-card-payment-${testIdPrefix}`}>
            <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
            <p className="text-sm text-muted-foreground">
              This organisation pays by online card payment. Payment and invoicing are processed immediately when a member pays online.
            </p>
          </div>
        </>
      ) : (
        <>
          <Separator className="my-3" />
          <div>
            <p className="text-sm font-medium flex items-center gap-1 mb-2">
              <FileText className="w-3 h-3" />
              Invoicing
            </p>
            {invoiceSent && (
              <div
                className="mb-3 flex items-start gap-2 p-3 rounded-md border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30"
                data-testid={`text-advance-invoice-sent-${testIdPrefix}`}
              >
                <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <p className="font-medium text-green-800 dark:text-green-300">Invoice sent</p>
                  <p className="text-muted-foreground">
                    {advanceInvoiceNumber ? `Invoice ${advanceInvoiceNumber}` : 'Invoice'}
                    {advanceInvoiceDate ? ` sent on ${advanceInvoiceDate}` : ' sent'}.
                    {advanceActivationDate ? ` Membership will activate on ${advanceActivationDate}.` : ''}
                  </p>
                </div>
              </div>
            )}
            <RadioGroup
              value={invoicingMode}
              onValueChange={(val) => {
                onInvoicingModeChange(val);
              }}
              className="space-y-2"
              disabled={invoiceSent}
              data-testid={`radio-invoicing-mode-${testIdPrefix}`}
            >
              <div className="flex items-start gap-2">
                <RadioGroupItem value="automatic" id={`invoicing-automatic-${testIdPrefix}`} data-testid={`radio-invoicing-automatic-${testIdPrefix}`} className="mt-0.5" />
                <div>
                  <Label htmlFor={`invoicing-automatic-${testIdPrefix}`} className="text-sm cursor-pointer">Automatic</Label>
                  <p className="text-xs text-muted-foreground">
                    {isNewOrg && testIdPrefix === 'current-year'
                      ? 'Renew and invoice automatically when go-live date is set via workflow'
                      : 'Renew and invoice automatically at start of membership schedule'}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="scheduled" id={`invoicing-scheduled-${testIdPrefix}`} data-testid={`radio-invoicing-scheduled-${testIdPrefix}`} className="mt-0.5" />
                <div className="flex-1">
                  <Label htmlFor={`invoicing-scheduled-${testIdPrefix}`} className="text-sm cursor-pointer">Specify date</Label>
                  <p className="text-xs text-muted-foreground">Renew at schedule start, invoice on a specific date</p>
                  {invoicingMode === 'scheduled' && (
                    <Input
                      type="date"
                      value={invoiceDate}
                      onChange={(e) => onInvoiceDateChange(e.target.value)}
                      min={new Date().toISOString().split('T')[0]}
                      className="mt-2 w-48"
                      disabled={invoiceSent}
                      data-testid={`input-invoice-date-${testIdPrefix}`}
                    />
                  )}
                </div>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="manual" id={`invoicing-manual-${testIdPrefix}`} data-testid={`radio-invoicing-manual-${testIdPrefix}`} className="mt-0.5" />
                <div>
                  <Label htmlFor={`invoicing-manual-${testIdPrefix}`} className="text-sm cursor-pointer">Manual</Label>
                  <p className="text-xs text-muted-foreground">Manually trigger renewal and invoice when ready</p>
                </div>
              </div>
            </RadioGroup>

            <div className="mt-3">
              <Label className="text-xs text-muted-foreground">Purchase Order Number (optional)</Label>
              <div className="flex items-center gap-1 mt-1">
                <Input
                  value={purchaseOrderNumber || ''}
                  onChange={(e) => onPurchaseOrderChange(e.target.value)}
                  placeholder="e.g. PO-12345"
                  className="w-48"
                  disabled={isPoLocked || invoiceSent}
                  data-testid={`input-po-number-${testIdPrefix}`}
                />
                {poSuppliedByMember && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setPoUnlocked(!poUnlocked)}
                    data-testid={`button-toggle-po-lock-${testIdPrefix}`}
                  >
                    {isPoLocked ? <Lock className="w-3.5 h-3.5" /> : <LockOpen className="w-3.5 h-3.5" />}
                  </Button>
                )}
              </div>
              {poSuppliedByMember && isPoLocked && (
                <p className="text-xs text-muted-foreground mt-1">Supplied by member</p>
              )}
            </div>

            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={onSaveInvoicing}
                disabled={invoicingSaving || invoiceSent}
                data-testid={`button-save-invoicing-${testIdPrefix}`}
              >
                {invoicingSaving ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
                Save
              </Button>
              {approvalRequired && onApprove && onUnapprove && (
                feesApproved ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onUnapprove}
                    disabled={approvePending || invoiceSent}
                    data-testid={`button-unapprove-${testIdPrefix}`}
                  >
                    {approvePending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <XCircle className="w-3 h-3 mr-1" />}
                    Unapprove
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="default"
                    onClick={onApprove}
                    disabled={approvePending || invoiceSent}
                    data-testid={`button-approve-${testIdPrefix}`}
                  >
                    {approvePending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <ShieldCheck className="w-3 h-3 mr-1" />}
                    Approve Fees
                  </Button>
                )
              )}
              {onEmailFees && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onEmailFees}
                  disabled={emailFeesPending || invoiceSent || (approvalRequired && !feesApproved)}
                  data-testid={`button-email-fees-${testIdPrefix}`}
                >
                  {emailFeesPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Mail className="w-3 h-3 mr-1" />}
                  Email Fees
                </Button>
              )}
              {showAdvanceInvoice && onAdvanceInvoice && !invoiceSent && (
                <Button
                  size="sm"
                  onClick={onAdvanceInvoice}
                  disabled={advanceInvoicePending || (approvalRequired && !feesApproved)}
                  data-testid={`button-invoice-now-${testIdPrefix}`}
                >
                  {advanceInvoicePending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Send className="w-3 h-3 mr-1" />}
                  Invoice Now
                </Button>
              )}
              {invoicingMode === 'manual' && onManualRenewal && (
                <Button
                  size="sm"
                  onClick={onManualRenewal}
                  disabled={manualRenewalPending || (approvalRequired && !feesApproved)}
                  data-testid={`button-renew-now-${testIdPrefix}`}
                >
                  {manualRenewalPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Send className="w-3 h-3 mr-1" />}
                  Renew &amp; Invoice Now
                </Button>
              )}
            </div>
            {approvalRequired && !feesApproved && (
              <p className="text-xs text-warning mt-1 flex items-center gap-1">
                <ShieldAlert className="w-3 h-3" />
                Fees must be approved before invoicing or payment actions
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function OrgMembershipTab({ organizationId, invoicingEmail }) {
  const queryClient = useQueryClient();
  const { memberLabelPlural } = useMemberTerminology();
  const [editingFieldValue, setEditingFieldValue] = useState(null);
  const [isEditingField, setIsEditingField] = useState(false);
  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [overrideTargetYear, setOverrideTargetYear] = useState(null);
  const [overrideType, setOverrideType] = useState('structure');
  const [selectedConfigId, setSelectedConfigId] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [discountType, setDiscountType] = useState('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const [invoicingModes, setInvoicingModes] = useState({});
  const [invoiceDates, setInvoiceDates] = useState({});
  const [purchaseOrderNumbers, setPurchaseOrderNumbers] = useState({});
  const [poSuppliedByMemberMap, setPoSuppliedByMemberMap] = useState({});
  const [simulationResults, setSimulationResults] = useState(null);
  const [simulationDialogOpen, setSimulationDialogOpen] = useState(false);
  const [simulatingYear, setSimulatingYear] = useState(null);
  const [emailFeesDialogOpen, setEmailFeesDialogOpen] = useState(false);
  const [emailFeesYear, setEmailFeesYear] = useState(null);
  const [emailFeesIncludeFinance, setEmailFeesIncludeFinance] = useState(true);
  const [emailFeesSelectedRoles, setEmailFeesSelectedRoles] = useState([]);
  const [emailFeesManualInput, setEmailFeesManualInput] = useState('');
  const [emailFeesManualEmails, setEmailFeesManualEmails] = useState([]);
  const [emailFeesConfirmStep, setEmailFeesConfirmStep] = useState(false);
  const [feesApprovedMap, setFeesApprovedMap] = useState({});
  const [approveFeesDialogOpen, setApproveFeesDialogOpen] = useState(false);
  const [approveFeesYearData, setApproveFeesYearData] = useState(null);
  const [approveAddonLines, setApproveAddonLines] = useState([]);
  const [loadingInvoiceRecordId, setLoadingInvoiceRecordId] = useState(null);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [currentInvoiceUrl, setCurrentInvoiceUrl] = useState(null);
  const [currentInvoiceNumber, setCurrentInvoiceNumber] = useState(null);
  const [reconcilingRecordId, setReconcilingRecordId] = useState(null);
  const [retryingInvoiceRecordId, setRetryingInvoiceRecordId] = useState(null);

  // Task #1112 — retry accounting-invoice creation when the original
  // post-payment mint failed and the row was flagged with
  // accounting_sync_status='failed'.
  const handleRetryInvoice = async (recordId) => {
    setRetryingInvoiceRecordId(recordId);
    try {
      const response = await fetch('/api/admin/membership-invoice-retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ recordId, table: 'organisation_membership_history' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data?.error || 'Invoice retry failed');
      }
      toast.success(`Invoice ${data.invoice_number || ''} created`);
      if (queryClient) queryClient.invalidateQueries({ queryKey: ['org-membership', organizationId] });
    } catch (err) {
      console.error('[OrgMembershipTab] retry invoice failed:', err);
      toast.error(err.message || 'Could not create invoice');
    } finally {
      setRetryingInvoiceRecordId(null);
    }
  };

  const handleReconcilePayment = async (recordId) => {
    setReconcilingRecordId(recordId);
    try {
      const response = await fetch('/api/admin/membership-payment-reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ recordId, table: 'organisation_membership_history' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Reconciliation failed');
      if (data.transitioned) {
        toast.success(`Payment status updated: ${data.beforeStatus} → ${data.afterStatus}`);
        if (queryClient) queryClient.invalidateQueries({ queryKey: ['org-membership', organizationId] });
      } else {
        toast.info(`No change (${data.skippedReason || 'already up to date'})`);
      }
    } catch (err) {
      console.error('[OrgMembershipTab] reconcile failed:', err);
      toast.error(err.message || 'Could not check payment status');
    } finally {
      setReconcilingRecordId(null);
    }
  };

  const handleViewInvoice = async (recordId, invoiceNumber) => {
    setLoadingInvoiceRecordId(recordId);
    try {
      const response = await fetch(`/api/membership-invoice/${encodeURIComponent(recordId)}?inline=true`, {
        credentials: 'include',
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Failed to load invoice' }));
        throw new Error(err.error || 'Failed to load invoice');
      }
      const pdfBlob = await response.blob();
      const blobUrl = URL.createObjectURL(pdfBlob);
      const pdfUrl = `${blobUrl}#view=Fit&navpanes=0&toolbar=0`;
      setCurrentInvoiceUrl(pdfUrl);
      setCurrentInvoiceNumber(invoiceNumber || null);
      setInvoiceModalOpen(true);
    } catch (error) {
      console.error('Error loading membership invoice:', error);
      toast.error(error.message || 'Failed to load invoice');
    } finally {
      setLoadingInvoiceRecordId(null);
    }
  };

  const handleDownloadInvoice = async (recordId, invoiceNumber) => {
    setLoadingInvoiceRecordId(recordId);
    try {
      const response = await fetch(`/api/membership-invoice/${encodeURIComponent(recordId)}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Failed to download invoice' }));
        throw new Error(err.error || 'Failed to download invoice');
      }
      const pdfBlob = await response.blob();
      const blobUrl = URL.createObjectURL(pdfBlob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `membership-invoice-${invoiceNumber || recordId}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 100);
      toast.success('Downloading invoice...');
    } catch (error) {
      console.error('Error downloading membership invoice:', error);
      toast.error(error.message || 'Failed to download invoice');
    } finally {
      setLoadingInvoiceRecordId(null);
    }
  };

  const handleInvoiceModalClose = (open) => {
    if (!open && currentInvoiceUrl) {
      const baseBlobUrl = currentInvoiceUrl.split('#')[0];
      URL.revokeObjectURL(baseBlobUrl);
      setCurrentInvoiceUrl(null);
      setCurrentInvoiceNumber(null);
    }
    setInvoiceModalOpen(open);
  };

  const joinFormCard = (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Link2 className="w-4 h-4" />
          Member Join Link
        </CardTitle>
      </CardHeader>
      <CardContent>
        <MemberJoinLinkSection organizationId={organizationId} showHeading={false} />
      </CardContent>
    </Card>
  );

  const { data, isLoading, error } = useQuery({
    queryKey: ['org-membership', organizationId],
    queryFn: async () => {
      const response = await fetch(`/api/membership/org-membership?organizationId=${organizationId}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch membership data');
      return response.json();
    },
    enabled: !!organizationId,
  });

  const { data: availableConfigs, isLoading: configsLoading } = useQuery({
    queryKey: ['org-membership-configs', organizationId],
    queryFn: async () => {
      const response = await fetch(`/api/membership/org-membership-override?organizationId=${organizationId}&action=configs`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch configs');
      return response.json();
    },
    enabled: overrideModalOpen && !!organizationId,
  });

  const { data: emailFeesRoles = [] } = useQuery({
    queryKey: ['roles-for-email-fees'],
    queryFn: async () => {
      const response = await fetch('/api/membership/roles', { credentials: 'include' });
      if (!response.ok) return [];
      const result = await response.json();
      return result.data || result.roles || [];
    },
    enabled: emailFeesDialogOpen,
    staleTime: 60000,
  });

  const { data: emailFeesRoleMembers = {}, isLoading: roleMembersLoading } = useQuery({
    queryKey: ['role-members-for-email-fees', organizationId, emailFeesSelectedRoles],
    queryFn: async () => {
      if (emailFeesSelectedRoles.length === 0) return {};
      const membersByRole = {};
      for (const roleId of emailFeesSelectedRoles) {
        const response = await fetch(`/api/admin/members/paginated?organizationId=${organizationId}&roleId=${roleId}&limit=100`, { credentials: 'include' });
        if (response.ok) {
          const result = await response.json();
          const members = result.members || result.data || [];
          membersByRole[roleId] = members.filter(m => m.email && !m.email.startsWith('deleted_')).map(m => m.email);
        } else {
          membersByRole[roleId] = [];
        }
      }
      return membersByRole;
    },
    enabled: emailFeesDialogOpen && emailFeesSelectedRoles.length > 0,
  });

  const updateFieldMutation = useMutation({
    mutationFn: async (newValue) => {
      const response = await fetch('/api/membership/org-membership', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ organizationId, fieldValue: newValue }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to update');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-membership', organizationId] });
      setIsEditingField(false);
      toast.success('Field value updated successfully');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const recordMutation = useMutation({
    mutationFn: async (payload) => {
      const response = await fetch('/api/membership/org-membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to record');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-membership', organizationId] });
      toast.success('Membership fee recorded');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const overrideMutation = useMutation({
    mutationFn: async (payload) => {
      const response = await fetch('/api/membership/org-membership-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to save override');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-membership', organizationId] });
      queryClient.invalidateQueries({ queryKey: ['org-notes'] });
      setOverrideModalOpen(false);
      resetOverrideForm();
      toast.success('Override saved');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const removeOverrideMutation = useMutation({
    mutationFn: async (membershipYear) => {
      const yearParam = membershipYear ? `&membershipYear=${encodeURIComponent(membershipYear)}` : '';
      const response = await fetch(`/api/membership/org-membership-override?organizationId=${organizationId}${yearParam}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to remove override');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-membership', organizationId] });
      queryClient.invalidateQueries({ queryKey: ['org-notes'] });
      toast.success('Override removed');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const { data: membershipSettings } = useQuery({
    queryKey: ['membership-settings'],
    queryFn: async () => {
      const response = await fetch('/api/membership/membership-settings', { credentials: 'include' });
      if (!response.ok) return { require_approval: false, custom_message: '' };
      return response.json();
    },
  });

  const approvalMutation = useMutation({
    mutationFn: async ({ membershipYear, action, addonLines }) => {
      const body = { organizationId, membershipYear, action };
      if (action === 'approve' && Array.isArray(addonLines)) {
        body.addonLines = addonLines;
      }
      const response = await fetch('/api/membership/org-membership-invoicing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to update approval');
      }
      return response.json();
    },
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['org-membership-invoicing', organizationId] });
      setFeesApprovedMap(prev => ({ ...prev, [variables.membershipYear]: result.fees_approved }));
      toast.success(result.fees_approved ? 'Fees approved' : 'Fees unapproved');
      setApproveFeesDialogOpen(false);
      setApproveFeesYearData(null);
      setApproveAddonLines([]);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // Task #2962 — invoice add-on line items. When add-ons are enabled the
  // Approve Fees action opens a modal where extra invoice lines can be
  // attached before approval.
  const addonsEnabled = !!membershipSettings?.addons_enabled &&
    (!!membershipSettings?.addon_training_fund_enabled || !!membershipSettings?.addon_freeform_enabled);

  const { data: addonSystemSettings = [] } = useQuery({
    queryKey: ['/api/entities/SystemSettings'],
    queryFn: () => base44.entities.SystemSettings.list(),
    enabled: addonsEnabled,
  });
  const addonVatRates = (() => {
    const setting = addonSystemSettings.find(s => s.setting_key === 'xero_vat_rates');
    if (setting?.setting_value) {
      try {
        return JSON.parse(setting.setting_value).rates || [];
      } catch {
        return [];
      }
    }
    return [];
  })();

  const handleApproveFees = (yearData) => {
    if (!addonsEnabled) {
      approvalMutation.mutate({ membershipYear: yearData.membershipYear, action: 'approve' });
      return;
    }
    setApproveFeesYearData(yearData);
    setApproveAddonLines([]);
    setApproveFeesDialogOpen(true);
  };

  const updateAddonLine = (index, patch) => {
    setApproveAddonLines(prev => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  const addonLineTotal = (line) => {
    const unit = parseFloat(line.unitCost);
    const qty = parseFloat(line.quantity);
    if (!isFinite(unit) || !isFinite(qty)) return 0;
    return Math.round(unit * qty * 100) / 100;
  };

  const addonSummary = (() => {
    let subtotal = 0;
    let vat = 0;
    for (const line of approveAddonLines) {
      const total = addonLineTotal(line);
      subtotal += total;
      const rate = line.type === 'training_fund'
        ? (membershipSettings?.training_fund_vat_rate?.effectiveRate ?? 0)
        : (line.vatRate?.effectiveRate ?? 0);
      vat += Math.round(total * (parseFloat(rate) || 0)) / 100;
    }
    subtotal = Math.round(subtotal * 100) / 100;
    vat = Math.round(vat * 100) / 100;
    return { subtotal, vat, total: Math.round((subtotal + vat) * 100) / 100 };
  })();

  const addonLinesValid = approveAddonLines.every(line => {
    const unit = parseFloat(line.unitCost);
    const qty = parseFloat(line.quantity);
    if (!isFinite(unit) || unit <= 0 || !isFinite(qty) || qty <= 0) return false;
    if (!String(line.description || '').trim()) return false;
    return true;
  });

  const submitApproveWithAddons = () => {
    if (!approveFeesYearData) return;
    approvalMutation.mutate({
      membershipYear: approveFeesYearData.membershipYear,
      action: 'approve',
      addonLines: approveAddonLines.map(line => ({
        type: line.type,
        description: String(line.description || '').trim(),
        nominalCode: line.type === 'training_fund' ? (membershipSettings?.training_fund_nominal_code || null) : (line.nominalCode || null),
        vatRate: line.type === 'training_fund' ? (membershipSettings?.training_fund_vat_rate || null) : (line.vatRate || null),
        unitCost: parseFloat(line.unitCost),
        quantity: parseFloat(line.quantity),
      })),
    });
  };

  const { data: invoicingData } = useQuery({
    queryKey: ['org-membership-invoicing', organizationId],
    queryFn: async () => {
      const response = await fetch(`/api/membership/org-membership-invoicing?organizationId=${organizationId}`, { credentials: 'include' });
      if (!response.ok) return { invoicing_mode: 'manual', invoice_date: null };
      return response.json();
    },
    enabled: !!organizationId,
  });

  useEffect(() => {
    if (invoicingData?.settings) {
      const modes = {};
      const dates = {};
      let legacyMode = 'manual';
      let legacyDate = '';

      if (invoicingData.settings._legacy) {
        legacyMode = invoicingData.settings._legacy.invoicing_mode || 'manual';
        legacyDate = invoicingData.settings._legacy.invoice_date || '';
      }

      const poNumbers = {};
      const poMemberFlags = {};
      const approvedFlags = {};
      for (const [yearKey, setting] of Object.entries(invoicingData.settings)) {
        if (yearKey === '_legacy') continue;
        // A row with no explicit mode (materialised by fee approval) is
        // effectively 'automatic' — that's the workflow guard's fallback.
        modes[yearKey] = setting.invoicing_mode || 'automatic';
        dates[yearKey] = setting.invoice_date || '';
        poNumbers[yearKey] = setting.purchase_order_number || '';
        if (setting.po_supplied_by_member) poMemberFlags[yearKey] = true;
        approvedFlags[yearKey] = !!setting.fees_approved;
      }

      const curYear = data?.currentYearCost?.membershipYear;
      const nxtYear = data?.nextYearPreview?.membershipYear;

      setInvoicingModes(prev => {
        const updated = { ...prev, ...modes };
        if (curYear && !updated[curYear]) {
          updated[curYear] = legacyMode;
        }
        if (nxtYear && !updated[nxtYear]) {
          updated[nxtYear] = legacyMode;
        }
        return updated;
      });
      setInvoiceDates(prev => {
        const updated = { ...prev, ...dates };
        if (curYear && !updated[curYear]) {
          updated[curYear] = legacyDate;
        }
        if (nxtYear && !updated[nxtYear]) {
          updated[nxtYear] = legacyDate;
        }
        return updated;
      });
      setPurchaseOrderNumbers(prev => ({ ...prev, ...poNumbers }));
      setPoSuppliedByMemberMap(prev => ({ ...prev, ...poMemberFlags }));
      setFeesApprovedMap(prev => ({ ...prev, ...approvedFlags }));
    }
  }, [invoicingData, data?.currentYearCost?.membershipYear, data?.nextYearPreview?.membershipYear]);

  const invoicingMutation = useMutation({
    mutationFn: async (payload) => {
      const response = await fetch('/api/membership/org-membership-invoicing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to save invoicing settings');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-membership-invoicing', organizationId] });
      toast.success('Invoicing settings saved');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // An explicit manual/scheduled invoicing mode blocks the workflow's
  // Create Membership action for that year, so the year card must always
  // expose the invoicing controls as the admin's manual path (Task #3244).
  const modeBlocksWorkflow = (year) => {
    const setting = (year && invoicingData?.settings?.[year]) || invoicingData?.settings?._legacy || null;
    return ['manual', 'scheduled'].includes(setting?.invoicing_mode);
  };

  const manualRenewalMutation = useMutation({
    mutationFn: async ({ membershipYear }) => {
      const response = await fetch('/api/membership/org-membership-invoicing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ organizationId, membershipYear }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to process renewal');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['org-membership', organizationId] });
      queryClient.invalidateQueries({ queryKey: ['org-membership-invoicing', organizationId] });
      queryClient.invalidateQueries({ queryKey: ['org-notes'] });
      toast.success(data.message || 'Membership renewed and invoice generated');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const advanceInvoiceMutation = useMutation({
    mutationFn: async ({ membershipYear, asOfDate }) => {
      const response = await fetch('/api/membership/org-membership-invoicing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ organizationId, membershipYear, asOfDate, advance: true }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to send advance invoice');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['org-membership', organizationId] });
      queryClient.invalidateQueries({ queryKey: ['org-membership-invoicing', organizationId] });
      queryClient.invalidateQueries({ queryKey: ['org-notes'] });
      toast.success(data.message || 'Advance invoice sent');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const emailFeesMutation = useMutation({
    mutationFn: async ({ membershipYear, recipientEmails }) => {
      const response = await fetch('/api/membership/email-fees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ organizationId, membershipYear, recipientEmails }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to send fee email');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['org-notes'] });
      setEmailFeesDialogOpen(false);
      setEmailFeesConfirmStep(false);
      const sentList = Array.isArray(data.sentTo) ? data.sentTo.join(', ') : data.sentTo;
      toast.success(data.message || `Fee email sent to ${sentList}`);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const simulateRenewalMutation = useMutation({
    mutationFn: async ({ mode, targetYear }) => {
      const response = await fetch('/api/membership/simulate-renewal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ organizationId, mode, targetYear }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to simulate renewal');
      }
      return response.json();
    },
    onSuccess: (data) => {
      setSimulationResults(data);
      setSimulationDialogOpen(true);
      setSimulatingYear(null);
    },
    onError: (error) => {
      toast.error(error.message);
      setSimulatingYear(null);
    },
  });

  const resetOverrideForm = () => {
    setOverrideType('structure');
    setSelectedConfigId('');
    setManualPrice('');
    setDiscountType('percentage');
    setDiscountValue('');
    setOverrideNote('');
    setOverrideTargetYear(null);
  };

  const handleOpenOverrideModal = (membershipYear) => {
    resetOverrideForm();
    setOverrideTargetYear(membershipYear);

    const yearOverride = data?.overrides?.find(o => o.membership_year === membershipYear)
      || data?.overrides?.find(o => !o.membership_year);
    if (yearOverride) {
      setOverrideType(yearOverride.override_type || 'structure');
      if (yearOverride.override_type === 'structure' && yearOverride.config_id) {
        setSelectedConfigId(yearOverride.config_id);
      }
      if (yearOverride.override_type === 'price' && yearOverride.manual_price !== null) {
        setManualPrice(yearOverride.manual_price.toString());
      }
      if (yearOverride.override_type === 'discount') {
        setDiscountType(yearOverride.discount_type || 'percentage');
        setDiscountValue(yearOverride.discount_value?.toString() || '');
      }
    }
    setOverrideModalOpen(true);
  };

  const handleSaveOverride = () => {
    if (!overrideNote.trim()) {
      toast.error('Please enter a reason for this override');
      return;
    }

    if (overrideType === 'structure' && !selectedConfigId) {
      toast.error('Please select a tier structure');
      return;
    }

    if (overrideType === 'price') {
      const price = parseFloat(manualPrice);
      if (isNaN(price) || price < 0) {
        toast.error('Please enter a valid price');
        return;
      }
    }

    if (overrideType === 'discount') {
      const val = parseFloat(discountValue);
      if (isNaN(val) || val < 0) {
        toast.error('Please enter a valid discount value');
        return;
      }
      if (discountType === 'percentage' && val > 100) {
        toast.error('Percentage discount cannot exceed 100%');
        return;
      }
    }

    overrideMutation.mutate({
      organizationId,
      overrideType,
      configId: overrideType === 'structure' ? selectedConfigId : null,
      manualPrice: overrideType === 'price' ? parseFloat(manualPrice) : null,
      discountType: overrideType === 'discount' ? discountType : null,
      discountValue: overrideType === 'discount' ? parseFloat(discountValue) : null,
      note: overrideNote,
      membershipYear: overrideTargetYear,
    });
  };

  const handleSaveFieldValue = () => {
    const val = parseFloat(editingFieldValue);
    if (isNaN(val) || val < 0) {
      toast.error('Please enter a valid number');
      return;
    }
    updateFieldMutation.mutate(val);
  };

  const handleStartEditing = () => {
    setEditingFieldValue(data?.fieldValue?.toString() || '0');
    setIsEditingField(true);
  };

  const handleCancelEditing = () => {
    setIsEditingField(false);
    setEditingFieldValue(null);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        {joinFormCard}
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        {joinFormCard}
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <AlertCircle className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p>Failed to load membership data</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data?.config) {
    return (
      <div className="space-y-4">
        {joinFormCard}
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Layers className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p>No membership tier structure has been configured yet</p>
            <p className="text-sm mt-1">Set up tier bands in Membership Tier Management to see pricing here</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { config, currentTier, fieldValue, fieldLabel, currentYear, nextYearPreview, currentYearCost, isNewOrg, goLiveDate, history, bands } = data;
  const currency = config.currency || 'GBP';
  const periodLabel = config.billing_period === 'annual' ? 'Annual' : config.billing_period === 'monthly' ? 'Monthly' : 'Quarterly';
  const isAutoField = config.field_source === 'core' && config.field_name === 'member_count';
  const isFlat = config.pricing_model === 'flat';

  const currentYearRecorded = history?.find(h => h.membership_year === currentYear?.label);

  const nextYearAdvanceRecord = history?.find(h =>
    h.membership_year === nextYearPreview?.membershipYear &&
    (h.accounting_invoice_id || h.xero_invoice_id)
  ) || null;

  const overrideTargetData = overrideTargetYear === currentYearCost?.membershipYear
    ? currentYearCost
    : overrideTargetYear === nextYearPreview?.membershipYear
      ? nextYearPreview
      : null;

  return (
    <div className="space-y-4">
      {joinFormCard}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-4 h-4" />
            Current Tier
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isFlat ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-muted-foreground">{periodLabel} Cost</p>
                <p className="text-lg font-semibold" data-testid="text-annual-cost">
                  {config.flat_cost != null ? formatCost(config.flat_cost, currency) : '-'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-muted-foreground">Structure</p>
                <p className="text-sm font-medium" data-testid="text-structure-name">{config.name || 'Default'}</p>
                <Badge variant="secondary" className="mt-1">Flat Rate</Badge>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-muted-foreground">{fieldLabel}</p>
                  {isEditingField && !isAutoField ? (
                    <div className="flex items-center gap-2 mt-1">
                      <Input
                        type="number"
                        min="0"
                        value={editingFieldValue}
                        onChange={(e) => setEditingFieldValue(e.target.value)}
                        className="w-28"
                        data-testid="input-field-value"
                      />
                      <Button
                        size="sm"
                        onClick={handleSaveFieldValue}
                        disabled={updateFieldMutation.isPending}
                        data-testid="button-save-field"
                      >
                        {updateFieldMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                      </Button>
                      <Button size="sm" variant="outline" onClick={handleCancelEditing} data-testid="button-cancel-field">
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 mt-1">
                      <p className="text-xl font-bold" data-testid="text-field-value">
                        {fieldValue !== null && fieldValue !== undefined ? fieldValue.toLocaleString() : 'N/A'}
                      </p>
                      {!isAutoField && (
                        <Button size="sm" variant="outline" onClick={handleStartEditing} data-testid="button-edit-field">
                          Edit
                        </Button>
                      )}
                      {isAutoField && (
                        <Badge variant="outline" className="text-xs">Auto</Badge>
                      )}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">Matched Tier</p>
                  {currentTier ? (
                    <Badge variant="secondary" className="mt-1" data-testid="badge-current-tier">{currentTier.label}</Badge>
                  ) : (
                    <Badge variant="outline" className="mt-1 text-muted-foreground" data-testid="badge-no-tier">Unmapped</Badge>
                  )}
                </div>
              </div>

              <Separator />

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-muted-foreground">{periodLabel} Cost</p>
                  <p className="text-lg font-semibold" data-testid="text-annual-cost">
                    {currentTier ? formatCost(currentTier.annualCost, currency) : '-'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">Structure</p>
                  <p className="text-sm font-medium" data-testid="text-structure-name">{config.name || 'Default'}</p>
                  <p className="text-xs text-muted-foreground">From {config.effective_from}</p>
                </div>
              </div>
            </>
          )}

          {currentTier && bands?.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-2">All Tier Bands</p>
                <div className="space-y-1">
                  {bands.map((band) => (
                    <div
                      key={band.id}
                      className={`flex items-center justify-between text-sm px-2 py-1 rounded ${band.id === currentTier.bandId ? 'bg-primary/10 font-medium' : ''}`}
                      data-testid={`row-band-${band.id}`}
                    >
                      <span>
                        {band.label}
                        <span className="text-muted-foreground ml-1">
                          ({band.minValue}{band.maxValue !== null ? `-${band.maxValue}` : '+'})
                        </span>
                      </span>
                      <span>{formatCost(band.annualCost, currency)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarDays className="w-4 h-4" />
              {currentYearCost?.yearNumber ? `Year ${currentYearCost.yearNumber}` : 'Current Year'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {currentYearCost ? (
              <YearCostSection
                yearData={currentYearCost}
                yearLabel={currentYearCost?.yearNumber ? `Year ${currentYearCost.yearNumber}` : 'Current Year'}
                currency={currency}
                periodLabel={periodLabel}
                fieldLabel={fieldLabel}
                configName={config.name}
                isNewOrg={isNewOrg}
                goLiveDate={goLiveDate}
                showRecordFee={true}
                currentYearRecorded={currentYearRecorded}
                recordMutation={recordMutation}
                organizationId={organizationId}
                onOpenOverride={handleOpenOverrideModal}
                onRemoveOverride={(year) => removeOverrideMutation.mutate(year)}
                removeOverridePending={removeOverrideMutation.isPending}
                onSimulate={(membershipYear) => { setSimulatingYear(membershipYear); simulateRenewalMutation.mutate({ mode: invoicingModes[currentYearCost?.membershipYear] || 'manual', targetYear: membershipYear }); }}
                simulatePending={simulateRenewalMutation.isPending && simulatingYear === currentYearCost?.membershipYear}
                testIdPrefix="current-year"
                isFlat={isFlat}
                invoicingMode={invoicingModes[currentYearCost?.membershipYear] || 'manual'}
                invoiceDate={invoiceDates[currentYearCost?.membershipYear] || ''}
                onInvoicingModeChange={(val) => {
                  setInvoicingModes(prev => ({ ...prev, [currentYearCost.membershipYear]: val }));
                  if (val !== 'scheduled') setInvoiceDates(prev => ({ ...prev, [currentYearCost.membershipYear]: '' }));
                }}
                onInvoiceDateChange={(val) => setInvoiceDates(prev => ({ ...prev, [currentYearCost.membershipYear]: val }))}
                onSaveInvoicing={() => {
                  const year = currentYearCost.membershipYear;
                  const mode = invoicingModes[year] || 'manual';
                  if (mode === 'scheduled' && !invoiceDates[year]) {
                    toast.error('Please select an invoice date');
                    return;
                  }
                  invoicingMutation.mutate({
                    organizationId,
                    invoicingMode: mode,
                    invoiceDate: mode === 'scheduled' ? invoiceDates[year] : null,
                    membershipYear: year,
                    purchaseOrderNumber: purchaseOrderNumbers[year] || null,
                  });
                }}
                invoicingSaving={invoicingMutation.isPending}
                onManualRenewal={() => manualRenewalMutation.mutate({ membershipYear: currentYearCost?.membershipYear })}
                manualRenewalPending={manualRenewalMutation.isPending}
                purchaseOrderNumber={purchaseOrderNumbers[currentYearCost?.membershipYear] || ''}
                onPurchaseOrderChange={(val) => setPurchaseOrderNumbers(prev => ({ ...prev, [currentYearCost.membershipYear]: val }))}
                poSuppliedByMember={!!poSuppliedByMemberMap[currentYearCost?.membershipYear]}
                onEmailFees={() => {
                  setEmailFeesYear(currentYearCost.membershipYear);
                  setEmailFeesIncludeFinance(!!invoicingEmail);
                  setEmailFeesSelectedRoles([]);
                  setEmailFeesManualInput('');
                  setEmailFeesManualEmails([]);
                  setEmailFeesConfirmStep(false);
                  setEmailFeesDialogOpen(true);
                }}
                emailFeesPending={emailFeesMutation.isPending}
                onlineCardPayment={!!config?.online_card_payment}
                approvalRequired={!!membershipSettings?.require_approval}
                feesApproved={!!feesApprovedMap[currentYearCost?.membershipYear]}
                onApprove={() => handleApproveFees(currentYearCost)}
                onUnapprove={() => approvalMutation.mutate({ membershipYear: currentYearCost.membershipYear, action: 'unapprove' })}
                approvePending={approvalMutation.isPending}
              />
            ) : (
              <div className="text-center py-4 text-muted-foreground">
                <p className="text-sm">No tier matched for the current year. Check that the organisation has a valid {fieldLabel?.toLowerCase() || 'field value'} and an active tier structure exists.</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowRight className="w-4 h-4" />
              {nextYearPreview?.yearNumber ? `Year ${nextYearPreview.yearNumber}` : 'Next Year'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {nextYearPreview ? (
              <YearCostSection
                yearData={nextYearPreview}
                yearLabel={nextYearPreview?.yearNumber ? `Year ${nextYearPreview.yearNumber}` : 'Next Year'}
                currency={currency}
                periodLabel={periodLabel}
                fieldLabel={fieldLabel}
                configName={config.name}
                isNewOrg={false}
                goLiveDate={null}
                showRecordFee={false}
                currentYearRecorded={null}
                recordMutation={recordMutation}
                organizationId={organizationId}
                onOpenOverride={handleOpenOverrideModal}
                onRemoveOverride={(year) => removeOverrideMutation.mutate(year)}
                removeOverridePending={removeOverrideMutation.isPending}
                onSimulate={(membershipYear) => { setSimulatingYear(membershipYear); simulateRenewalMutation.mutate({ mode: invoicingModes[nextYearPreview?.membershipYear] || 'manual', targetYear: membershipYear }); }}
                simulatePending={simulateRenewalMutation.isPending && simulatingYear === nextYearPreview?.membershipYear}
                testIdPrefix="next-year"
                isFlat={isFlat}
                invoicingMode={invoicingModes[nextYearPreview?.membershipYear] || 'manual'}
                invoiceDate={invoiceDates[nextYearPreview?.membershipYear] || ''}
                onInvoicingModeChange={(val) => {
                  setInvoicingModes(prev => ({ ...prev, [nextYearPreview.membershipYear]: val }));
                  if (val !== 'scheduled') setInvoiceDates(prev => ({ ...prev, [nextYearPreview.membershipYear]: '' }));
                }}
                onInvoiceDateChange={(val) => setInvoiceDates(prev => ({ ...prev, [nextYearPreview.membershipYear]: val }))}
                onSaveInvoicing={() => {
                  const year = nextYearPreview.membershipYear;
                  const mode = invoicingModes[year] || 'manual';
                  if (mode === 'scheduled' && !invoiceDates[year]) {
                    toast.error('Please select an invoice date');
                    return;
                  }
                  invoicingMutation.mutate({
                    organizationId,
                    invoicingMode: mode,
                    invoiceDate: mode === 'scheduled' ? invoiceDates[year] : null,
                    membershipYear: year,
                    purchaseOrderNumber: purchaseOrderNumbers[year] || null,
                  });
                }}
                invoicingSaving={invoicingMutation.isPending}
                onManualRenewal={modeBlocksWorkflow(nextYearPreview?.membershipYear)
                  ? () => manualRenewalMutation.mutate({ membershipYear: nextYearPreview?.membershipYear })
                  : null}
                manualRenewalPending={manualRenewalMutation.isPending}
                purchaseOrderNumber={purchaseOrderNumbers[nextYearPreview?.membershipYear] || ''}
                onPurchaseOrderChange={(val) => setPurchaseOrderNumbers(prev => ({ ...prev, [nextYearPreview.membershipYear]: val }))}
                poSuppliedByMember={!!poSuppliedByMemberMap[nextYearPreview?.membershipYear]}
                onEmailFees={() => {
                  setEmailFeesYear(nextYearPreview.membershipYear);
                  setEmailFeesIncludeFinance(!!invoicingEmail);
                  setEmailFeesSelectedRoles([]);
                  setEmailFeesManualInput('');
                  setEmailFeesManualEmails([]);
                  setEmailFeesConfirmStep(false);
                  setEmailFeesDialogOpen(true);
                }}
                emailFeesPending={emailFeesMutation.isPending}
                hideInvoicing={!currentYearRecorded && !modeBlocksWorkflow(nextYearPreview?.membershipYear)}
                onlineCardPayment={!!config?.online_card_payment}
                approvalRequired={!!membershipSettings?.require_approval}
                feesApproved={!!feesApprovedMap[nextYearPreview?.membershipYear]}
                onApprove={() => handleApproveFees(nextYearPreview)}
                onUnapprove={() => approvalMutation.mutate({ membershipYear: nextYearPreview.membershipYear, action: 'unapprove' })}
                approvePending={approvalMutation.isPending}
                showAdvanceInvoice={true}
                onAdvanceInvoice={() => advanceInvoiceMutation.mutate({ membershipYear: nextYearPreview.membershipYear, asOfDate: nextYearPreview.startDate })}
                advanceInvoicePending={advanceInvoiceMutation.isPending}
                advanceInvoiceRecord={nextYearAdvanceRecord}
              />
            ) : (
              <div className="text-center py-4 text-muted-foreground">
                <p className="text-sm">No tier matched for the next year. Check that the organisation has a valid {fieldLabel?.toLowerCase() || 'field value'} and an active tier structure exists.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <History className="w-4 h-4" />
            Membership Fee History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!history || history.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="text-no-history">
              <History className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p>No membership fee history recorded yet</p>
              <p className="text-sm mt-1">Use the "Record Fee" button above to log this year's membership cost</p>
            </div>
          ) : (
            <div className="border rounded-md overflow-auto">
              <table className="w-full text-sm" data-testid="table-history">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-3 font-medium">Year</th>
                    <th className="text-left p-3 font-medium">Tier</th>
                    <th className="text-right p-3 font-medium">{fieldLabel}</th>
                    <th className="text-right p-3 font-medium">{periodLabel} Cost</th>
                    <th className="text-right p-3 font-medium">Adjustments</th>
                    <th className="text-right p-3 font-medium">Final Cost</th>
                    <th className="text-left p-3 font-medium">Status</th>
                    <th className="text-center p-3 font-medium">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((record) => {
                    const hasAdjustments = (record.free_period_discount > 0) || (record.prorata_cost !== null) || (record.rollover_discount > 0);
                    const invoiceId = record.accounting_invoice_id || record.xero_invoice_id;
                    const invoiceNumber = record.accounting_invoice_number || record.xero_invoice_number;
                    const lifecycle = getMembershipHistoryLifecycle(record, currentYear?.label);
                    return (
                    <tr key={record.id} className="border-b last:border-0" data-testid={`row-history-${record.id}`}>
                      <td className="p-3 font-medium">{record.membership_year}</td>
                      <td className="p-3">
                        <Badge variant="secondary">{record.tier_label || '-'}</Badge>
                      </td>
                      <td className="p-3 text-right">{record.field_value?.toLocaleString() ?? '-'}</td>
                      <td className="p-3 text-right">{formatCost(record.annual_cost, record.currency)}</td>
                      <td className="p-3 text-right text-xs space-y-0.5">
                        {hasAdjustments ? (
                          <>
                            {record.free_period_discount > 0 && (
                              <div className="text-green-600">Free: -{formatCost(record.free_period_discount, record.currency)}</div>
                            )}
                            {record.prorata_cost !== null && (
                              <div className="text-blue-600">Pro-rata: {formatCost(record.prorata_cost, record.currency)}</div>
                            )}
                            {record.rollover_discount > 0 && (
                              <div className="text-green-600">Rollover: -{formatCost(record.rollover_discount, record.currency)}</div>
                            )}
                          </>
                        ) : '-'}
                      </td>
                      <td className="p-3 text-right font-semibold">{formatCost(record.final_cost, record.currency)}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-1 flex-wrap">
                          <Badge variant={lifecycle.variant} data-testid={`badge-lifecycle-${lifecycle.key}`}>
                            {lifecycle.label}
                          </Badge>
                          <PaymentStatusBadge paymentStatus={record.payment_status} />
                        </div>
                      </td>
                      <td className="p-3">
                        {!invoiceId && record.accounting_sync_status === 'failed' ? (
                          <div className="flex items-center justify-center gap-2" data-testid={`cell-invoice-failed-${record.id}`}>
                            <Badge variant="warning" title={record.accounting_sync_error || 'Invoice creation failed'}>
                              <AlertTriangle className="w-3 h-3 mr-1" />
                              Invoice failed
                            </Badge>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleRetryInvoice(record.id)}
                              disabled={retryingInvoiceRecordId === record.id}
                              data-testid={`button-retry-invoice-${record.id}`}
                            >
                              {retryingInvoiceRecordId === record.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                'Retry'
                              )}
                            </Button>
                          </div>
                        ) : invoiceId ? (
                          <div className="flex items-center justify-center gap-1">
                            {loadingInvoiceRecordId === record.id ? (
                              <Loader2
                                className="w-4 h-4 animate-spin text-muted-foreground"
                                data-testid={`spinner-invoice-${record.id}`}
                              />
                            ) : (
                              <>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => handleViewInvoice(record.id, invoiceNumber)}
                                  title={`View invoice ${invoiceNumber || ''}`.trim()}
                                  data-testid={`button-view-invoice-${record.id}`}
                                >
                                  <Eye className="w-4 h-4" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => handleDownloadInvoice(record.id, invoiceNumber)}
                                  title={`Download invoice ${invoiceNumber || ''}`.trim()}
                                  data-testid={`button-download-invoice-${record.id}`}
                                >
                                  <Download className="w-4 h-4" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => handleReconcilePayment(record.id)}
                                  disabled={reconcilingRecordId === record.id}
                                  title="Check payment status now"
                                  data-testid={`button-reconcile-payment-${record.id}`}
                                >
                                  {reconcilingRecordId === record.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <RefreshCw className="w-4 h-4" />
                                  )}
                                </Button>
                              </>
                            )}
                          </div>
                        ) : (
                          <div className="text-center text-muted-foreground" data-testid={`text-no-invoice-${record.id}`}>—</div>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={approveFeesDialogOpen} onOpenChange={(open) => {
        if (!open) {
          setApproveFeesDialogOpen(false);
          setApproveFeesYearData(null);
          setApproveAddonLines([]);
        }
      }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Approve Fees{approveFeesYearData?.membershipYear ? ` — ${approveFeesYearData.membershipYear}` : ''}</DialogTitle>
            <DialogDescription>
              Optionally add extra line items to this organisation's membership invoice before approving.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {approveAddonLines.length > 0 && (
              <div className="space-y-3">
                {approveAddonLines.map((line, index) => (
                  <div key={index} className="p-3 rounded-md border space-y-3" data-testid={`addon-line-${index}`}>
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline">
                        {line.type === 'training_fund' ? 'Training Fund top-up' : 'Add-on'}
                      </Badge>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setApproveAddonLines(prev => prev.filter((_, i) => i !== index))}
                        data-testid={`button-remove-addon-${index}`}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Description</Label>
                      <Input
                        value={line.description}
                        onChange={(e) => updateAddonLine(index, { description: e.target.value })}
                        data-testid={`input-addon-description-${index}`}
                      />
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Unit cost (ex VAT)</Label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.unitCost}
                          onChange={(e) => updateAddonLine(index, { unitCost: e.target.value })}
                          data-testid={`input-addon-unit-cost-${index}`}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Quantity</Label>
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          value={line.quantity}
                          onChange={(e) => updateAddonLine(index, { quantity: e.target.value })}
                          data-testid={`input-addon-quantity-${index}`}
                        />
                      </div>
                      {line.type === 'training_fund' ? (
                        <>
                          <div className="space-y-1">
                            <Label className="text-xs">Nominal code</Label>
                            <Input value={membershipSettings?.training_fund_nominal_code || ''} disabled readOnly />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">VAT rate</Label>
                            <Input value={membershipSettings?.training_fund_vat_rate?.name || 'Provider default'} disabled readOnly />
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="space-y-1">
                            <Label className="text-xs">Nominal code</Label>
                            <Input
                              value={line.nominalCode || ''}
                              onChange={(e) => updateAddonLine(index, { nominalCode: e.target.value })}
                              placeholder="Default"
                              data-testid={`input-addon-nominal-${index}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">VAT rate</Label>
                            <Select
                              value={line.vatRate?.taxType || 'none'}
                              onValueChange={(value) => {
                                if (value === 'none') {
                                  updateAddonLine(index, { vatRate: null });
                                } else {
                                  const rate = addonVatRates.find(r => r.taxType === value);
                                  updateAddonLine(index, { vatRate: rate ? { taxType: rate.taxType, name: rate.name, effectiveRate: rate.effectiveRate } : null });
                                }
                              }}
                            >
                              <SelectTrigger data-testid={`select-addon-vat-${index}`}>
                                <SelectValue placeholder="VAT rate" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">Provider default</SelectItem>
                                {addonVatRates.map((rate) => (
                                  <SelectItem key={rate.taxType} value={rate.taxType}>
                                    {rate.name}{rate.effectiveRate != null ? ` (${rate.effectiveRate}%)` : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="flex justify-end text-sm">
                      <span className="text-muted-foreground mr-2">Line total (ex VAT):</span>
                      <span className="font-medium" data-testid={`text-addon-line-total-${index}`}>{formatCost(addonLineTotal(line), currency)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 flex-wrap">
              {membershipSettings?.addon_training_fund_enabled && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={approveAddonLines.some(l => l.type === 'training_fund')}
                  onClick={() => setApproveAddonLines(prev => ([...prev, {
                    type: 'training_fund',
                    description: 'Training Fund top-up',
                    unitCost: '',
                    quantity: '1',
                  }]))}
                  data-testid="button-add-training-fund-line"
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Add Training Fund top-up
                </Button>
              )}
              {membershipSettings?.addon_freeform_enabled && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setApproveAddonLines(prev => ([...prev, {
                    type: 'freeform',
                    description: '',
                    nominalCode: '',
                    vatRate: null,
                    unitCost: '',
                    quantity: '1',
                  }]))}
                  data-testid="button-add-freeform-line"
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Add line item
                </Button>
              )}
            </div>

            <Separator />
            <div className="space-y-1 text-sm" data-testid="addon-invoice-summary">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Membership fee (ex VAT)</span>
                <span className="font-medium">{formatCost(approveFeesYearData?.finalCost || 0, currency)}</span>
              </div>
              {approveAddonLines.length > 0 && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Add-ons (ex VAT)</span>
                  <span className="font-medium">{formatCost(addonSummary.subtotal, currency)}</span>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">VAT</span>
                <span className="font-medium">{formatCost((approveFeesYearData?.vatAmount || 0) + addonSummary.vat, currency)}</span>
              </div>
              <div className="flex justify-between gap-2 pt-1 border-t">
                <span className="font-semibold">Invoice total</span>
                <span className="font-semibold" data-testid="text-addon-invoice-total">
                  {formatCost((approveFeesYearData?.totalWithVat ?? approveFeesYearData?.finalCost ?? 0) + addonSummary.total, currency)}
                </span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setApproveFeesDialogOpen(false);
                setApproveFeesYearData(null);
                setApproveAddonLines([]);
              }}
              data-testid="button-cancel-approve-fees"
            >
              Cancel
            </Button>
            <Button
              onClick={submitApproveWithAddons}
              disabled={approvalMutation.isPending || !addonLinesValid}
              data-testid="button-confirm-approve-fees"
            >
              {approvalMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
              Approve Fees
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={overrideModalOpen} onOpenChange={setOverrideModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle data-testid="text-override-title">Override {overrideTargetYear || ''} Cost</DialogTitle>
            <DialogDescription>
              Override the automatically calculated membership cost for {overrideTargetYear || 'this year'}.
              A note will be added to the organisation's Notes tab.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-3">
              <Label className="text-sm font-medium">Override Type</Label>
              <RadioGroup
                value={overrideType}
                onValueChange={(val) => {
                  setOverrideType(val);
                  setSelectedConfigId('');
                  setManualPrice('');
                  setDiscountType('percentage');
                  setDiscountValue('');
                }}
                data-testid="radio-override-type"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="structure" id="override-structure" data-testid="radio-structure" />
                  <Label htmlFor="override-structure" className="text-sm cursor-pointer">
                    Use a different tier structure
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="price" id="override-price" data-testid="radio-price" />
                  <Label htmlFor="override-price" className="text-sm cursor-pointer">
                    Set a manual price
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="discount" id="override-discount" data-testid="radio-discount" />
                  <Label htmlFor="override-discount" className="text-sm cursor-pointer">
                    Set a discount override
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {overrideType === 'structure' && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">Select Tier Structure</Label>
                {configsLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading structures...
                  </div>
                ) : (
                  <Select value={selectedConfigId} onValueChange={setSelectedConfigId}>
                    <SelectTrigger data-testid="select-config">
                      <SelectValue placeholder="Choose a tier structure..." />
                    </SelectTrigger>
                    <SelectContent>
                      {availableConfigs?.map((cfg) => (
                        <SelectItem key={cfg.id} value={cfg.id} data-testid={`option-config-${cfg.id}`}>
                          {cfg.name || 'Unnamed'} (from {cfg.effective_from})
                          {cfg.effective_to ? ` to ${cfg.effective_to}` : ' - Current'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {selectedConfigId && availableConfigs && (
                  <div className="p-2 bg-muted/50 rounded-md">
                    <p className="text-xs text-muted-foreground mb-1">Bands in selected structure:</p>
                    <div className="space-y-0.5">
                      {availableConfigs
                        .find(c => c.id === selectedConfigId)
                        ?.bands?.map((band) => (
                          <div key={band.id} className="flex items-center justify-between text-xs">
                            <span>{band.label} ({band.min_value}{band.max_value !== null ? `-${band.max_value}` : '+'})</span>
                            <span>{formatCost(band.annual_cost, currency)}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {overrideType === 'price' && (
              <div className="space-y-2">
                <Label htmlFor="manual-price" className="text-sm font-medium">
                  Manual Price ({getCurrencySymbol(currency)})
                </Label>
                <Input
                  id="manual-price"
                  type="number"
                  min="0"
                  step="0.01"
                  value={manualPrice}
                  onChange={(e) => setManualPrice(e.target.value)}
                  placeholder="Enter price..."
                  data-testid="input-manual-price"
                />
                {overrideTargetData && (
                  <p className="text-xs text-muted-foreground">
                    Auto-calculated price: {formatCost(
                      overrideTargetData.originalAnnualCost ?? overrideTargetData.finalCost,
                      currency
                    )}
                  </p>
                )}
              </div>
            )}

            {overrideType === 'discount' && (
              <div className="space-y-3">
                <Label className="text-sm font-medium">Discount Type</Label>
                <RadioGroup
                  value={discountType}
                  onValueChange={(val) => {
                    setDiscountType(val);
                    setDiscountValue('');
                  }}
                  data-testid="radio-discount-type"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="percentage" id="discount-percentage" data-testid="radio-discount-percentage" />
                    <Label htmlFor="discount-percentage" className="text-sm cursor-pointer">
                      Percentage (%)
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="fixed" id="discount-fixed" data-testid="radio-discount-fixed" />
                    <Label htmlFor="discount-fixed" className="text-sm cursor-pointer">
                      Fixed amount ({getCurrencySymbol(currency)})
                    </Label>
                  </div>
                </RadioGroup>

                <div className="space-y-2">
                  <Label htmlFor="discount-value" className="text-sm font-medium">
                    {discountType === 'percentage' ? 'Discount Percentage' : `Discount Amount (${getCurrencySymbol(currency)})`}
                  </Label>
                  <Input
                    id="discount-value"
                    type="number"
                    min="0"
                    max={discountType === 'percentage' ? '100' : undefined}
                    step={discountType === 'percentage' ? '0.1' : '0.01'}
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    placeholder={discountType === 'percentage' ? 'e.g. 10' : 'e.g. 100.00'}
                    data-testid="input-discount-value"
                  />
                </div>

                {overrideTargetData && discountValue && (
                  <div className="p-2 bg-muted/50 rounded-md">
                    <p className="text-xs text-muted-foreground">
                      {(() => {
                        const gross = overrideTargetData.annualCostBeforeDiscounts ?? overrideTargetData.annualCost;
                        const val = parseFloat(discountValue) || 0;
                        const discountAmt = discountType === 'percentage'
                          ? parseFloat((gross * val / 100).toFixed(2))
                          : Math.min(val, gross);
                        const net = Math.max(0, gross - discountAmt);
                        return `Gross: ${formatCost(gross, currency)} - Discount: ${formatCost(discountAmt, currency)} = Net: ${formatCost(net, currency)}`;
                      })()}
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="override-note" className="text-sm font-medium">
                Reason for Override <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="override-note"
                value={overrideNote}
                onChange={(e) => setOverrideNote(e.target.value)}
                placeholder="Explain why this override is being applied..."
                rows={3}
                data-testid="textarea-override-note"
              />
              <p className="text-xs text-muted-foreground">
                This note will be added to the organisation's Notes tab for audit purposes.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setOverrideModalOpen(false)}
              data-testid="button-cancel-override"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveOverride}
              disabled={overrideMutation.isPending}
              data-testid="button-save-override"
            >
              {overrideMutation.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              Save Override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={simulationDialogOpen} onOpenChange={setSimulationDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlayCircle className="w-4 h-4" />
              Renewal Simulation Results
            </DialogTitle>
            <DialogDescription>
              {simulationResults && (
                <span>
                  Mode: <span className="font-medium capitalize">{simulationResults.mode}</span>
                  {' | '}Organisation: <span className="font-medium">{simulationResults.organization}</span>
                  {' | '}Year: <span className="font-medium">{simulationResults.membershipYear}</span>
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {simulationResults?.steps && (
            <div className="space-y-1">
              {simulationResults.steps.map((step, idx) => {
                const StatusIcon = step.status === 'error' ? XCircle
                  : step.status === 'warning' ? AlertTriangle
                  : step.status === 'info' ? Info
                  : CheckCircle2;
                const statusColor = step.status === 'error' ? 'text-destructive'
                  : step.status === 'warning' ? 'text-warning dark:text-warning'
                  : step.status === 'info' ? 'text-blue-600 dark:text-blue-400'
                  : 'text-green-600 dark:text-green-500';

                return (
                  <div key={idx} className="flex items-start gap-2 py-1.5 border-b last:border-b-0" data-testid={`simulation-step-${idx}`}>
                    <StatusIcon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${statusColor}`} />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{step.step}</span>
                      <p className="text-xs text-muted-foreground break-words">{step.detail}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {simulationResults && (
            <div className="mt-3 p-3 rounded-md bg-muted/50 space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Final Cost</span>
                <span className="font-semibold">
                  {formatCost(simulationResults.finalCost, simulationResults.currency)}
                </span>
              </div>
              {simulationResults.vatRatePercent > 0 && simulationResults.vatAmount > 0 && (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">VAT ({simulationResults.vatRatePercent}%{simulationResults.taxLabel ? ` - ${simulationResults.taxLabel}` : ''})</span>
                    <span className="font-medium">{formatCost(simulationResults.vatAmount, simulationResults.currency)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm border-t pt-1">
                    <span className="text-muted-foreground font-medium">Total (incl. VAT)</span>
                    <span className="font-semibold">{formatCost(simulationResults.totalWithVat, simulationResults.currency)}</span>
                  </div>
                </>
              )}
              {simulationResults.overrideApplied && (
                <p className="text-xs text-muted-foreground mt-1">Override was applied to this calculation</p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSimulationDialogOpen(false)}
              data-testid="button-close-simulation"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={emailFeesDialogOpen} onOpenChange={(open) => {
        setEmailFeesDialogOpen(open);
        if (!open) setEmailFeesConfirmStep(false);
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="w-4 h-4" />
              Email Membership Fees
            </DialogTitle>
            <DialogDescription>
              {emailFeesConfirmStep
                ? 'Please confirm the recipients before sending.'
                : `Send the fee breakdown and payment link for ${emailFeesYear}.`}
            </DialogDescription>
          </DialogHeader>

          {!emailFeesConfirmStep ? (
            <>
              <div className="space-y-4">
                {invoicingEmail && (
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">Finance Email</Label>
                    <div className="flex items-center gap-2 p-2 rounded-md border">
                      <Checkbox
                        id="include-finance-email"
                        checked={emailFeesIncludeFinance}
                        onCheckedChange={setEmailFeesIncludeFinance}
                        data-testid="checkbox-include-finance"
                      />
                      <label htmlFor="include-finance-email" className="text-sm cursor-pointer flex-1">
                        {invoicingEmail}
                      </label>
                      <Badge variant="secondary" className="text-xs">Finance</Badge>
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <Label className="text-sm font-medium flex items-center gap-1">
                    <Users className="w-3.5 h-3.5" />
                    Add by Role
                  </Label>
                  <div className="max-h-40 overflow-y-auto border rounded-md p-2 space-y-1">
                    {emailFeesRoles.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-1">Loading roles...</p>
                    ) : (
                      emailFeesRoles.map(role => {
                        const isSelected = emailFeesSelectedRoles.includes(role.id);
                        const roleEmails = emailFeesRoleMembers[role.id] || [];
                        return (
                          <div key={role.id}>
                            <div className="flex items-center gap-2">
                              <Checkbox
                                id={`role-${role.id}`}
                                checked={isSelected}
                                onCheckedChange={(checked) => {
                                  setEmailFeesSelectedRoles(prev =>
                                    checked ? [...prev, role.id] : prev.filter(id => id !== role.id)
                                  );
                                }}
                                data-testid={`checkbox-role-${role.id}`}
                              />
                              <label htmlFor={`role-${role.id}`} className="text-sm cursor-pointer flex-1">
                                {role.name}
                              </label>
                            </div>
                            {isSelected && roleEmails.length > 0 && (
                              <div className="ml-6 mt-1 mb-1 flex flex-wrap gap-1">
                                {roleEmails.map(email => (
                                  <Badge key={email} variant="outline" className="text-xs">{email}</Badge>
                                ))}
                              </div>
                            )}
                            {isSelected && roleEmails.length === 0 && (
                              <p className="ml-6 text-xs text-muted-foreground mt-1 mb-1">
                                {roleMembersLoading ? `Loading ${memberLabelPlural.toLowerCase()}...` : `No ${memberLabelPlural.toLowerCase()} with this role in this organisation`}
                              </p>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="space-y-1">
                  <Label className="text-sm font-medium">Additional Emails</Label>
                  <div className="flex gap-2">
                    <Input
                      value={emailFeesManualInput}
                      onChange={(e) => setEmailFeesManualInput(e.target.value)}
                      placeholder="Enter email address"
                      className="flex-1"
                      data-testid="input-manual-email"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          const raw = emailFeesManualInput.trim().replace(/,+$/, '');
                          if (raw && raw.includes('@')) {
                            setEmailFeesManualEmails(prev => [...new Set([...prev, raw.toLowerCase()])]);
                            setEmailFeesManualInput('');
                          }
                        }
                      }}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        const raw = emailFeesManualInput.trim().replace(/,+$/, '');
                        if (raw && raw.includes('@')) {
                          setEmailFeesManualEmails(prev => [...new Set([...prev, raw.toLowerCase()])]);
                          setEmailFeesManualInput('');
                        }
                      }}
                      data-testid="button-add-manual-email"
                    >
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                  {emailFeesManualEmails.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {emailFeesManualEmails.map(email => (
                        <Badge key={email} variant="secondary" className="text-xs gap-1">
                          {email}
                          <button
                            onClick={() => setEmailFeesManualEmails(prev => prev.filter(e => e !== email))}
                            className="ml-0.5"
                            data-testid={`button-remove-email-${email}`}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                {(() => {
                  const allEmails = [
                    ...(emailFeesIncludeFinance && invoicingEmail ? [invoicingEmail.toLowerCase()] : []),
                    ...Object.values(emailFeesRoleMembers).flat().map(e => e.toLowerCase()),
                    ...emailFeesManualEmails,
                  ];
                  const uniqueEmails = [...new Set(allEmails)];
                  return uniqueEmails.length > 0 ? (
                    <div className="bg-muted/50 rounded-md p-3">
                      <p className="text-xs font-medium text-muted-foreground mb-1">
                        {uniqueEmails.length} recipient{uniqueEmails.length !== 1 ? 's' : ''} selected
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {uniqueEmails.map(email => (
                          <Badge key={email} variant="outline" className="text-xs">{email}</Badge>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No recipients selected. Select at least one recipient to continue.</p>
                  );
                })()}
              </div>

              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => setEmailFeesDialogOpen(false)}
                  data-testid="button-cancel-email-fees"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => setEmailFeesConfirmStep(true)}
                  disabled={(() => {
                    const allEmails = [
                      ...(emailFeesIncludeFinance && invoicingEmail ? [invoicingEmail.toLowerCase()] : []),
                      ...Object.values(emailFeesRoleMembers).flat().map(e => e.toLowerCase()),
                      ...emailFeesManualEmails,
                    ];
                    return [...new Set(allEmails)].length === 0;
                  })()}
                  data-testid="button-review-email-fees"
                >
                  <Send className="w-3 h-3 mr-1" />
                  Review & Send
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              {(() => {
                const allEmails = [
                  ...(emailFeesIncludeFinance && invoicingEmail ? [invoicingEmail.toLowerCase()] : []),
                  ...Object.values(emailFeesRoleMembers).flat().map(e => e.toLowerCase()),
                  ...emailFeesManualEmails,
                ];
                const uniqueEmails = [...new Set(allEmails)];
                return (
                  <div className="space-y-4">
                    <div className="bg-warning/10 border border-warning/30 rounded-md p-4 text-sm">
                      <div className="flex items-center gap-2 font-medium text-warning mb-2">
                        <AlertTriangle className="w-4 h-4" />
                        Confirm Send
                      </div>
                      <p className="text-warning mb-3">
                        You are about to send the membership fee notification for <strong>{emailFeesYear}</strong> to {uniqueEmails.length} recipient{uniqueEmails.length !== 1 ? 's' : ''}:
                      </p>
                      <div className="space-y-1">
                        {uniqueEmails.map(email => (
                          <div key={email} className="flex items-center gap-2 text-warning">
                            <Mail className="w-3 h-3 shrink-0" />
                            <span>{email}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <DialogFooter className="gap-2">
                      <Button
                        variant="outline"
                        onClick={() => setEmailFeesConfirmStep(false)}
                        data-testid="button-back-email-fees"
                      >
                        <ArrowLeft className="w-3 h-3 mr-1" />
                        Back
                      </Button>
                      <Button
                        onClick={() => emailFeesMutation.mutate({ membershipYear: emailFeesYear, recipientEmails: uniqueEmails })}
                        disabled={emailFeesMutation.isPending}
                        data-testid="button-confirm-send-email-fees"
                      >
                        {emailFeesMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Send className="w-3 h-3 mr-1" />}
                        Confirm & Send
                      </Button>
                    </DialogFooter>
                  </div>
                );
              })()}
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={invoiceModalOpen} onOpenChange={handleInvoiceModalClose}>
        <DialogContent className="max-w-4xl h-[90vh] p-0 flex flex-col">
          <DialogHeader className="p-6 pb-4 border-b shrink-0">
            <DialogTitle data-testid="text-invoice-modal-title">
              Invoice {currentInvoiceNumber || 'Preview'}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            {currentInvoiceUrl ? (
              <iframe
                src={currentInvoiceUrl}
                className="w-full h-full border-0"
                title="Invoice PDF"
                data-testid="iframe-invoice-pdf"
              />
            ) : (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
