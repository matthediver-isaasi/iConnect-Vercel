import { useState, useEffect } from "react";
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
  History, AlertCircle, Wallet, ArrowRight, Pencil, X,
  FileText, Send, PlayCircle, ShieldAlert, CheckCircle2,
  XCircle, Info, AlertTriangle, CreditCard,
  Lock, LockOpen, ShieldCheck, Mail, RefreshCw,
  Eye, Download, PauseCircle
} from "lucide-react";
import { toast } from "sonner";

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

function MemberYearCostSection({
  yearData,
  yearLabel,
  currency,
  periodLabel,
  showRecordFee,
  currentYearRecorded,
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
  hideInvoicing,
  approvalRequired,
  feesApproved,
  onApprove,
  onUnapprove,
  approvePending,
  onSimulate,
  simulatePending,
  onOpenOverride,
  hasOverride,
  onRemoveOverride,
  removeOverridePending,
  onlineCardPayment,
  onEmailFees,
  emailFeesPending,
  memberEmail,
}) {
  const [poUnlocked, setPoUnlocked] = useState(false);
  const isPoLocked = poSuppliedByMember && !poUnlocked;

  if (!yearData) return null;

  return (
    <div data-testid={`section-member-${testIdPrefix}`} className={approvalRequired && feesApproved ? 'rounded-md border border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/30 p-3 -m-1' : ''}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            <Wallet className="w-3 h-3" />
            {yearLabel}
          </p>
          {!currentYearRecorded && (
            <Badge
              variant="outline"
              className="text-xs text-amber-700 border-amber-300 dark:text-amber-400 dark:border-amber-700"
              data-testid={`badge-member-preview-${testIdPrefix}`}
            >
              Calculated preview
            </Badge>
          )}
          {approvalRequired && feesApproved && (
            <Badge variant="outline" className="text-xs text-green-700 border-green-300 dark:text-green-400 dark:border-green-700" data-testid={`badge-member-approved-${testIdPrefix}`}>
              <ShieldCheck className="w-3 h-3 mr-1" />
              Approved
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {!currentYearRecorded && onEmailFees && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onEmailFees(yearData.membershipYear)}
              disabled={emailFeesPending || !memberEmail || (approvalRequired && !feesApproved) || yearData.finalCost == null}
              title={!memberEmail
                ? 'Add an email address before sending fees'
                : (approvalRequired && !feesApproved ? 'Approve fees before sending' : 'Email the calculated fee')}
              data-testid={`button-member-email-fees-${testIdPrefix}`}
            >
              {emailFeesPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Mail className="w-3 h-3 mr-1" />}
              Email Fees
            </Button>
          )}
          {!currentYearRecorded && !feesApproved && (
            <Button
              size="sm"
              variant={hasOverride ? "secondary" : "outline"}
              onClick={() => onOpenOverride(yearData.membershipYear)}
              data-testid={`button-member-override-${testIdPrefix}`}
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
            data-testid={`button-member-simulate-${testIdPrefix}`}
          >
            {simulatePending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <PlayCircle className="w-3 h-3 mr-1" />}
            Simulate
          </Button>
        </div>
      </div>
      <p className="font-semibold" data-testid={`text-member-year-${testIdPrefix}`}>{yearData.membershipYear}</p>

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
              data-testid={`button-member-remove-override-${testIdPrefix}`}
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
        {yearData.fieldValue != null && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Field Value</span>
            <span className="font-medium">{yearData.fieldValue}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Tier</span>
          <Badge variant="secondary">{yearData.tierLabel || 'Unmapped'}</Badge>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{periodLabel} Cost</span>
          <span className="font-medium">{formatCost(yearData.annualCost, currency)}</span>
        </div>
        {yearData.customDiscountTotal > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Custom Discount</span>
            <span className="text-green-600">-{formatCost(yearData.customDiscountTotal, currency)}</span>
          </div>
        )}
        {yearData.proRataEnabled && yearData.prorataDays !== null && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Pro-rata ({yearData.prorataDays} days)</span>
            <span className="font-medium">{formatCost(yearData.prorataCost, currency)}</span>
          </div>
        )}
        {yearData.freeDiscount > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {yearData.freePeriodUnit === 'percent'
                ? `New Member Discount (${yearData.freePeriodAmount}%)`
                : `New Member Discount (${yearData.freePeriodDaysApplied} free days)`}
            </span>
            <span className="text-green-600">-{formatCost(yearData.freeDiscount, currency)}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-sm border-t pt-1">
          <span className="text-muted-foreground font-medium">
            {showRecordFee && currentYearRecorded ? 'Recorded Cost' : currentYearRecorded ? 'Final Cost' : 'Preview Cost'}
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
      </div>
      {!currentYearRecorded && !memberEmail && (
        <p className="text-xs text-warning mt-2 flex items-center gap-1" data-testid={`text-member-email-missing-${testIdPrefix}`}>
          <AlertTriangle className="w-3 h-3" />
          Add an email address before sending this fee preview.
        </p>
      )}
      {!currentYearRecorded && approvalRequired && !feesApproved && (
        <p className="text-xs text-warning mt-2 flex items-center gap-1" data-testid={`text-member-email-approval-required-${testIdPrefix}`}>
          <ShieldAlert className="w-3 h-3" />
          Fees must be approved before the fee email can be sent.
        </p>
      )}

      {currentYearRecorded ? (
        <>
          <Separator className="my-3" />
          {currentYearRecorded.payment_method === 'stripe' ? (
            <div className="flex items-start gap-3 p-3 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800" data-testid={`card-member-payment-info-${testIdPrefix}`}>
              <CreditCard className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm font-medium">Paid by card</p>
                <p className="text-sm text-muted-foreground">
                  {formatCost(currentYearRecorded.total_with_vat || currentYearRecorded.final_cost, currency)} inc. VAT
                </p>
                {(currentYearRecorded.accounting_invoice_number || currentYearRecorded.xero_invoice_number) && (
                  <p className="text-xs text-muted-foreground">
                    Invoice: {currentYearRecorded.accounting_invoice_number || currentYearRecorded.xero_invoice_number}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 p-3 rounded-md bg-muted/50 border" data-testid={`card-member-payment-info-${testIdPrefix}`}>
              <FileText className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm font-medium">Invoiced</p>
                <p className="text-sm text-muted-foreground">
                  {formatCost(currentYearRecorded.final_cost, currency)} excl. VAT
                </p>
                {(currentYearRecorded.accounting_invoice_number || currentYearRecorded.xero_invoice_number) && (
                  <p className="text-xs text-muted-foreground">
                    Invoice: {currentYearRecorded.accounting_invoice_number || currentYearRecorded.xero_invoice_number}
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      ) : hideInvoicing ? (
        <>
          <Separator className="my-3" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`text-member-invoicing-pending-${testIdPrefix}`}>
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
                  data-testid={`button-member-unapprove-${testIdPrefix}`}
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
                  data-testid={`button-member-approve-${testIdPrefix}`}
                >
                  {approvePending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <ShieldCheck className="w-3 h-3 mr-1" />}
                  Approve Fees
                </Button>
              )}
            </div>
          )}
          <div className="flex items-start gap-2 p-3 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800" data-testid={`text-member-online-card-payment-${testIdPrefix}`}>
            <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
            <p className="text-sm text-muted-foreground">
              This member pays by online card payment. Payment and invoicing are processed immediately when the member pays online.
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
            <RadioGroup
              value={invoicingMode}
              onValueChange={onInvoicingModeChange}
              className="space-y-2"
              data-testid={`radio-member-invoicing-mode-${testIdPrefix}`}
            >
              <div className="flex items-start gap-2">
                <RadioGroupItem value="automatic" id={`member-invoicing-automatic-${testIdPrefix}`} data-testid={`radio-member-invoicing-automatic-${testIdPrefix}`} className="mt-0.5" />
                <div>
                  <Label htmlFor={`member-invoicing-automatic-${testIdPrefix}`} className="text-sm cursor-pointer">Automatic</Label>
                  <p className="text-xs text-muted-foreground">Renew and invoice automatically at start of membership schedule</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="scheduled" id={`member-invoicing-scheduled-${testIdPrefix}`} data-testid={`radio-member-invoicing-scheduled-${testIdPrefix}`} className="mt-0.5" />
                <div className="flex-1">
                  <Label htmlFor={`member-invoicing-scheduled-${testIdPrefix}`} className="text-sm cursor-pointer">Specify date</Label>
                  <p className="text-xs text-muted-foreground">Renew at schedule start, invoice on a specific date</p>
                  {invoicingMode === 'scheduled' && (
                    <Input
                      type="date"
                      value={invoiceDate}
                      onChange={(e) => onInvoiceDateChange(e.target.value)}
                      min={new Date().toISOString().split('T')[0]}
                      className="mt-2 w-48"
                      data-testid={`input-member-invoice-date-${testIdPrefix}`}
                    />
                  )}
                </div>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="manual" id={`member-invoicing-manual-${testIdPrefix}`} data-testid={`radio-member-invoicing-manual-${testIdPrefix}`} className="mt-0.5" />
                <div>
                  <Label htmlFor={`member-invoicing-manual-${testIdPrefix}`} className="text-sm cursor-pointer">Manual</Label>
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
                  disabled={isPoLocked}
                  data-testid={`input-member-po-number-${testIdPrefix}`}
                />
                {poSuppliedByMember && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setPoUnlocked(!poUnlocked)}
                    data-testid={`button-member-toggle-po-lock-${testIdPrefix}`}
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
                disabled={invoicingSaving}
                data-testid={`button-member-save-invoicing-${testIdPrefix}`}
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
                    disabled={approvePending}
                    data-testid={`button-member-unapprove-${testIdPrefix}`}
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
                    data-testid={`button-member-approve-${testIdPrefix}`}
                  >
                    {approvePending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <ShieldCheck className="w-3 h-3 mr-1" />}
                    Approve Fees
                  </Button>
                )
              )}
              {invoicingMode === 'manual' && onManualRenewal && (
                <Button
                  size="sm"
                  onClick={onManualRenewal}
                  disabled={manualRenewalPending || (approvalRequired && !feesApproved)}
                  data-testid={`button-member-renew-now-${testIdPrefix}`}
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

export default function MemberMembershipTab({ memberId, memberEmail }) {
  const queryClient = useQueryClient();
  const [invoicingModes, setInvoicingModes] = useState({});
  const [invoiceDates, setInvoiceDates] = useState({});
  const [purchaseOrderNumbers, setPurchaseOrderNumbers] = useState({});
  const [poSuppliedByMemberMap, setPoSuppliedByMemberMap] = useState({});
  const [feesApprovedMap, setFeesApprovedMap] = useState({});
  const [emailFeesTargetYear, setEmailFeesTargetYear] = useState(null);
  const [emailFeesDialogOpen, setEmailFeesDialogOpen] = useState(false);

  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [overrideTargetYear, setOverrideTargetYear] = useState(null);
  const [overrideType, setOverrideType] = useState('structure');
  const [selectedConfigId, setSelectedConfigId] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [discountType, setDiscountType] = useState('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const [simulationResults, setSimulationResults] = useState(null);
  const [simulationDialogOpen, setSimulationDialogOpen] = useState(false);
  const [simulatingYear, setSimulatingYear] = useState(null);
  const [reconcilingRecordId, setReconcilingRecordId] = useState(null);
  const [retryingInvoiceRecordId, setRetryingInvoiceRecordId] = useState(null);
  const [loadingInvoiceRecordId, setLoadingInvoiceRecordId] = useState(null);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [currentInvoiceUrl, setCurrentInvoiceUrl] = useState(null);
  const [currentInvoiceNumber, setCurrentInvoiceNumber] = useState(null);
  const [pauseModalOpen, setPauseModalOpen] = useState(false);
  const [pauseReason, setPauseReason] = useState('');
  const [pauseRestartDate, setPauseRestartDate] = useState('');

  const handleRetryInvoice = async (recordId) => {
    setRetryingInvoiceRecordId(recordId);
    try {
      const response = await fetch('/api/admin/membership-invoice-retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ recordId, table: 'member_membership_history' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data?.error || 'Invoice retry failed');
      }
      toast.success(`Invoice ${data.invoice_number || ''} created`);
      queryClient.invalidateQueries({ queryKey: ['member-membership', memberId] });
    } catch (err) {
      console.error('[MemberMembershipTab] retry invoice failed:', err);
      toast.error(err.message || 'Could not create invoice');
    } finally {
      setRetryingInvoiceRecordId(null);
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

  const handleReconcilePayment = async (recordId) => {
    setReconcilingRecordId(recordId);
    try {
      const response = await fetch('/api/admin/membership-payment-reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ recordId, table: 'member_membership_history' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Reconciliation failed');
      if (data.transitioned) {
        toast.success(`Payment status updated: ${data.beforeStatus} → ${data.afterStatus}`);
        queryClient.invalidateQueries({ queryKey: ['member-membership', memberId] });
      } else {
        toast.info(`No change (${data.skippedReason || 'already up to date'})`);
      }
    } catch (err) {
      console.error('[MemberMembershipTab] reconcile failed:', err);
      toast.error(err.message || 'Could not check payment status');
    } finally {
      setReconcilingRecordId(null);
    }
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['member-membership', memberId],
    queryFn: async () => {
      const response = await fetch(`/api/membership/member-membership?memberId=${memberId}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch membership data');
      return response.json();
    },
    enabled: !!memberId,
  });

  const { data: membershipSettings } = useQuery({
    queryKey: ['membership-settings'],
    queryFn: async () => {
      const response = await fetch('/api/membership/membership-settings', { credentials: 'include' });
      if (!response.ok) return { require_approval: false };
      return response.json();
    },
  });

  const { data: invoicingData } = useQuery({
    queryKey: ['member-membership-invoicing-settings', memberId],
    queryFn: async () => {
      const response = await fetch(`/api/membership/member-membership-invoicing?memberId=${memberId}`, { credentials: 'include' });
      if (!response.ok) return { settings: {} };
      return response.json();
    },
    enabled: !!memberId,
  });

  const { data: availableConfigs, isLoading: configsLoading } = useQuery({
    queryKey: ['member-membership-configs', memberId],
    queryFn: async () => {
      const response = await fetch(`/api/membership/member-membership-override?memberId=${memberId}&action=configs`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch configs');
      return response.json();
    },
    enabled: overrideModalOpen && !!memberId,
  });

  const { data: currentOverride } = useQuery({
    queryKey: ['member-membership-override', memberId, overrideTargetYear],
    queryFn: async () => {
      const yearParam = overrideTargetYear ? `&membershipYear=${encodeURIComponent(overrideTargetYear)}` : '';
      const response = await fetch(`/api/membership/member-membership-override?memberId=${memberId}${yearParam}`, { credentials: 'include' });
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!memberId,
  });

  useEffect(() => {
    if (invoicingData?.settings) {
      const modes = {};
      const dates = {};
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
      setInvoicingModes(prev => ({ ...prev, ...modes }));
      setInvoiceDates(prev => ({ ...prev, ...dates }));
      setPurchaseOrderNumbers(prev => ({ ...prev, ...poNumbers }));
      setPoSuppliedByMemberMap(prev => ({ ...prev, ...poMemberFlags }));
      setFeesApprovedMap(prev => ({ ...prev, ...approvedFlags }));
    }
  }, [invoicingData]);

  const invoicingMutation = useMutation({
    mutationFn: async (payload) => {
      const response = await fetch('/api/membership/member-membership-invoicing', {
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
      queryClient.invalidateQueries({ queryKey: ['member-membership-invoicing-settings', memberId] });
      toast.success('Invoicing settings saved');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const manualRenewalMutation = useMutation({
    mutationFn: async ({ membershipYear }) => {
      const response = await fetch('/api/membership/member-membership-invoicing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberId, membershipYear }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to process renewal');
      }
      return response.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['member-membership', memberId] });
      queryClient.invalidateQueries({ queryKey: ['member-membership-invoicing-settings', memberId] });
      toast.success(result.message || 'Membership renewed and invoice generated');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const approvalMutation = useMutation({
    mutationFn: async ({ membershipYear, action }) => {
      const response = await fetch('/api/membership/member-membership-invoicing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberId, membershipYear, action }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to update approval');
      }
      return response.json();
    },
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['member-membership-invoicing-settings', memberId] });
      setFeesApprovedMap(prev => ({ ...prev, [variables.membershipYear]: result.fees_approved }));
      toast.success(result.fees_approved ? 'Fees approved' : 'Fees unapproved');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const emailFeesMutation = useMutation({
    mutationFn: async ({ membershipYear }) => {
      const response = await fetch('/api/membership/email-fees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberId, membershipYear }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Failed to send fee email');
      return result;
    },
    onSuccess: (result) => {
      setEmailFeesDialogOpen(false);
      setEmailFeesTargetYear(null);
      toast.success(result.message || 'Fee email sent');
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
        body: JSON.stringify({ memberId, mode, targetYear }),
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

  const overrideMutation = useMutation({
    mutationFn: async (payload) => {
      const response = await fetch('/api/membership/member-membership-override', {
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
      queryClient.invalidateQueries({ queryKey: ['member-membership', memberId] });
      queryClient.invalidateQueries({ queryKey: ['member-membership-override', memberId] });
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
      const response = await fetch(`/api/membership/member-membership-override?memberId=${memberId}${yearParam}`, {
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
      queryClient.invalidateQueries({ queryKey: ['member-membership', memberId] });
      queryClient.invalidateQueries({ queryKey: ['member-membership-override', memberId] });
      toast.success('Override removed');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const pauseMutation = useMutation({
    mutationFn: async (payload) => {
      const response = await fetch(`/api/admin/members/${memberId}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Failed to update pause state');
      return result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['member-membership', memberId] });
      queryClient.invalidateQueries({ queryKey: ['member-notes', memberId] });
      setPauseModalOpen(false);
      setPauseReason('');
      setPauseRestartDate('');
      if (result.warnings?.length) {
        toast.warning(result.warnings.join('; '));
      }
      toast.success(result.paused ? 'Membership paused — access and payments suspended' : 'Membership resumed — access and payments restored');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const handleConfirmPause = () => {
    if (!pauseReason.trim()) {
      toast.error('Please provide a reason for pausing this membership');
      return;
    }
    pauseMutation.mutate({
      action: 'pause',
      reason: pauseReason.trim(),
      restartDate: pauseRestartDate || null,
    });
  };

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

    if (currentOverride && (currentOverride.membership_year === membershipYear || !currentOverride.membership_year)) {
      setOverrideType(currentOverride.override_type || 'structure');
      if (currentOverride.override_type === 'structure' && currentOverride.config_id) {
        setSelectedConfigId(currentOverride.config_id);
      }
      if (currentOverride.override_type === 'price' && currentOverride.manual_price != null) {
        setManualPrice(String(currentOverride.manual_price));
      }
      if (currentOverride.override_type === 'discount') {
        setDiscountType(currentOverride.discount_type || 'percentage');
        setDiscountValue(String(currentOverride.discount_value || ''));
      }
      if (currentOverride.note) setOverrideNote(currentOverride.note);
    }

    setOverrideModalOpen(true);
  };

  const handleSaveOverride = () => {
    if (!overrideNote.trim()) {
      toast.error('Please provide a reason for the override');
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
      memberId,
      overrideType,
      configId: overrideType === 'structure' ? selectedConfigId : null,
      manualPrice: overrideType === 'price' ? parseFloat(manualPrice) : null,
      discountType: overrideType === 'discount' ? discountType : null,
      discountValue: overrideType === 'discount' ? parseFloat(discountValue) : null,
      note: overrideNote,
      membershipYear: overrideTargetYear,
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin" data-testid="loader-member-membership" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <AlertCircle className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p data-testid="text-member-membership-error">Failed to load membership data</p>
        </CardContent>
      </Card>
    );
  }

  const pause = data?.pause || null;
  const isPaused = !!pause?.paused;

  const pauseControls = (
    <>
      {isPaused ? (
        <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/30" data-testid="card-membership-paused">
          <CardContent className="py-4 flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3">
              <PauseCircle className="w-5 h-5 text-amber-600 mt-0.5" />
              <div>
                <p className="text-sm font-medium" data-testid="text-membership-paused">Membership paused</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Access and recurring payments are suspended.
                  {pause.pausedAt ? ` Paused ${new Date(pause.pausedAt).toLocaleDateString()}` : ''}
                  {pause.pausedBy ? ` by ${pause.pausedBy}` : ''}.
                  {pause.restartDate
                    ? ` Scheduled to restart automatically on ${new Date(`${pause.restartDate}T00:00:00`).toLocaleDateString()}.`
                    : ' No restart date set — resume manually when ready.'}
                </p>
                {pause.reason && (
                  <p className="text-xs text-muted-foreground mt-1" data-testid="text-pause-reason">Reason: {pause.reason}</p>
                )}
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => pauseMutation.mutate({ action: 'resume' })}
              disabled={pauseMutation.isPending}
              data-testid="button-resume-membership"
            >
              {pauseMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-1" />}
              Resume
            </Button>
          </CardContent>
        </Card>
      ) : (
        pause && (
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPauseModalOpen(true)}
              data-testid="button-pause-membership"
            >
              <PauseCircle className="w-4 h-4 mr-1" />
              Pause membership
            </Button>
          </div>
        )
      )}

      <Dialog open={pauseModalOpen} onOpenChange={setPauseModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pause membership</DialogTitle>
            <DialogDescription>
              Pausing suspends this member's system access and recurring membership payments
              (including any active Direct Debit subscription) until resumed. The reason is
              saved as a note on the member's record.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pause-reason">Reason (required)</Label>
              <Textarea
                id="pause-reason"
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
                placeholder="e.g. Maternity leave until next spring"
                rows={3}
                data-testid="input-pause-reason"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pause-restart-date">Restart date (optional)</Label>
              <Input
                id="pause-restart-date"
                type="date"
                value={pauseRestartDate}
                onChange={(e) => setPauseRestartDate(e.target.value)}
                data-testid="input-pause-restart-date"
              />
              <p className="text-xs text-muted-foreground">
                If set, access and payments are automatically restored on this date.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPauseModalOpen(false)} data-testid="button-cancel-pause">
              Cancel
            </Button>
            <Button onClick={handleConfirmPause} disabled={pauseMutation.isPending} data-testid="button-confirm-pause">
              {pauseMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Pause membership
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  const history = Array.isArray(data?.history) ? data.history : [];
  const currentYearData = data?.currentYearCost || null;
  const nextYearData = data?.nextYearPreview || null;
  const config = data?.config || null;
  const currency = config?.currency || 'GBP';
  const periodLabel = config?.billing_period === 'monthly' ? 'Monthly' : config?.billing_period === 'quarterly' ? 'Quarterly' : 'Annual';

  const currentYearRecorded = currentYearData
    ? history.find(h => h.membership_year === currentYearData.membershipYear)
    : null;
  const nextYearRecorded = nextYearData
    ? history.find(h => h.membership_year === nextYearData.membershipYear)
    : null;
  const effectiveMemberEmail = data?.member?.email || memberEmail || '';

  const openEmailFeesDialog = (membershipYear) => {
    setEmailFeesTargetYear(membershipYear);
    setEmailFeesDialogOpen(true);
  };

  const hasOverrideForYear = (membershipYear) => {
    if (membershipYear === currentYearData?.membershipYear) {
      return !!currentYearData?.overrideApplied;
    }
    if (membershipYear === nextYearData?.membershipYear) {
      return !!nextYearData?.overrideApplied;
    }
    return false;
  };

  const overrideTargetData = overrideTargetYear === currentYearData?.membershipYear
    ? currentYearData
    : nextYearData;

  if (!config && !isLoading) {
    return (
      <div className="space-y-4">
        {pauseControls}
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Layers className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p data-testid="text-member-no-config">No member-scoped membership tier structure has been configured</p>
            <p className="text-sm mt-1">Set up member-scoped tier bands in Membership Tier Management to see pricing here</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // An explicit manual/scheduled invoicing mode blocks the workflow's
  // Create Membership action for that year, so the year card must always
  // expose the invoicing controls as the admin's manual path (Task #3244).
  const modeBlocksWorkflow = (year) => {
    const setting = (year && invoicingData?.settings?.[year]) || invoicingData?.settings?._legacy || null;
    return ['manual', 'scheduled'].includes(setting?.invoicing_mode);
  };

  const makeInvoicingHandlers = (yearData, testIdPrefix) => {
    if (!yearData) return {};
    const year = yearData.membershipYear;
    const savedSetting = invoicingData?.settings?.[year] || invoicingData?.settings?._legacy || null;
    const hasLocalApproval = Object.prototype.hasOwnProperty.call(feesApprovedMap, year);
    return {
      invoicingMode: invoicingModes[year] || 'manual',
      invoiceDate: invoiceDates[year] || '',
      onInvoicingModeChange: (val) => {
        setInvoicingModes(prev => ({ ...prev, [year]: val }));
        if (val !== 'scheduled') setInvoiceDates(prev => ({ ...prev, [year]: '' }));
      },
      onInvoiceDateChange: (val) => setInvoiceDates(prev => ({ ...prev, [year]: val })),
      onSaveInvoicing: () => {
        const mode = invoicingModes[year] || 'manual';
        if (mode === 'scheduled' && !invoiceDates[year]) {
          toast.error('Please select an invoice date');
          return;
        }
        invoicingMutation.mutate({
          memberId,
          invoicingMode: mode,
          invoiceDate: mode === 'scheduled' ? invoiceDates[year] : null,
          membershipYear: year,
          purchaseOrderNumber: purchaseOrderNumbers[year] || null,
        });
      },
      invoicingSaving: invoicingMutation.isPending,
      purchaseOrderNumber: purchaseOrderNumbers[year] || '',
      onPurchaseOrderChange: (val) => setPurchaseOrderNumbers(prev => ({ ...prev, [year]: val })),
      poSuppliedByMember: !!poSuppliedByMemberMap[year],
      approvalRequired: !!membershipSettings?.require_approval,
      feesApproved: hasLocalApproval ? !!feesApprovedMap[year] : !!savedSetting?.fees_approved,
      onApprove: () => approvalMutation.mutate({ membershipYear: year, action: 'approve' }),
      onUnapprove: () => approvalMutation.mutate({ membershipYear: year, action: 'unapprove' }),
      approvePending: approvalMutation.isPending,
    };
  };

  return (
    <div className="space-y-4">
      {pauseControls}
      {config && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              Membership Tier
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-muted-foreground">Structure</p>
                <p className="text-sm font-medium" data-testid="text-member-structure-name">{config.name || 'Default'}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-muted-foreground">Currency</p>
                <p className="text-sm font-medium">{currency}</p>
              </div>
            </div>
            {currentYearData?.tierLabel && (
              <>
                <Separator />
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-muted-foreground">Current Tier</p>
                    <Badge variant="secondary" className="mt-1" data-testid="badge-member-current-tier">{currentYearData.tierLabel}</Badge>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">{periodLabel} Cost</p>
                    <p className="text-lg font-semibold" data-testid="text-member-annual-cost">{formatCost(currentYearData.annualCost, currency)}</p>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarDays className="w-4 h-4" />
              {currentYearData?.yearNumber ? `Year ${currentYearData.yearNumber}` : 'Current Year'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {currentYearData ? (
              <MemberYearCostSection
                yearData={currentYearData}
                yearLabel={currentYearData?.yearNumber ? `Year ${currentYearData.yearNumber}` : 'Current Year'}
                currency={currency}
                periodLabel={periodLabel}
                showRecordFee={true}
                currentYearRecorded={currentYearRecorded}
                memberEmail={effectiveMemberEmail}
                onEmailFees={openEmailFeesDialog}
                emailFeesPending={emailFeesMutation.isPending && emailFeesTargetYear === currentYearData?.membershipYear}
                testIdPrefix="current-year"
                onManualRenewal={() => manualRenewalMutation.mutate({ membershipYear: currentYearData?.membershipYear })}
                manualRenewalPending={manualRenewalMutation.isPending}
                onSimulate={(membershipYear) => { setSimulatingYear(membershipYear); simulateRenewalMutation.mutate({ mode: invoicingModes[currentYearData?.membershipYear] || 'manual', targetYear: membershipYear }); }}
                simulatePending={simulateRenewalMutation.isPending && simulatingYear === currentYearData?.membershipYear}
                onOpenOverride={handleOpenOverrideModal}
                hasOverride={hasOverrideForYear(currentYearData?.membershipYear)}
                onRemoveOverride={(year) => removeOverrideMutation.mutate(year)}
                removeOverridePending={removeOverrideMutation.isPending}
                onlineCardPayment={!!config?.online_card_payment}
                {...makeInvoicingHandlers(currentYearData, 'current-year')}
              />
            ) : (
              <div className="text-center py-4 text-muted-foreground">
                <p className="text-sm" data-testid="text-member-no-current-tier">No tier matched for the current year</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowRight className="w-4 h-4" />
              {nextYearData?.yearNumber ? `Year ${nextYearData.yearNumber}` : 'Next Year'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {nextYearData ? (
              <MemberYearCostSection
                yearData={nextYearData}
                yearLabel={nextYearData?.yearNumber ? `Year ${nextYearData.yearNumber}` : 'Next Year'}
                currency={currency}
                periodLabel={periodLabel}
                showRecordFee={true}
                currentYearRecorded={nextYearRecorded}
                memberEmail={effectiveMemberEmail}
                onEmailFees={openEmailFeesDialog}
                emailFeesPending={emailFeesMutation.isPending && emailFeesTargetYear === nextYearData?.membershipYear}
                testIdPrefix="next-year"
                onManualRenewal={modeBlocksWorkflow(nextYearData?.membershipYear)
                  ? () => manualRenewalMutation.mutate({ membershipYear: nextYearData?.membershipYear })
                  : null}
                manualRenewalPending={manualRenewalMutation.isPending}
                hideInvoicing={!nextYearRecorded && !modeBlocksWorkflow(nextYearData?.membershipYear)}
                onSimulate={(membershipYear) => { setSimulatingYear(membershipYear); simulateRenewalMutation.mutate({ mode: invoicingModes[nextYearData?.membershipYear] || 'manual', targetYear: membershipYear }); }}
                simulatePending={simulateRenewalMutation.isPending && simulatingYear === nextYearData?.membershipYear}
                onOpenOverride={handleOpenOverrideModal}
                hasOverride={hasOverrideForYear(nextYearData?.membershipYear)}
                onRemoveOverride={(year) => removeOverrideMutation.mutate(year)}
                removeOverridePending={removeOverrideMutation.isPending}
                onlineCardPayment={!!config?.online_card_payment}
                {...makeInvoicingHandlers(nextYearData, 'next-year')}
              />
            ) : (
              <div className="text-center py-4 text-muted-foreground">
                <p className="text-sm" data-testid="text-member-no-next-tier">No tier matched for the next year</p>
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
            <div className="text-center py-8 text-muted-foreground" data-testid="text-member-no-history">
              <History className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p>No membership fee history recorded yet</p>
            </div>
          ) : (
            <div className="border rounded-md overflow-auto">
              <table className="w-full text-sm" data-testid="table-member-history">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-3 font-medium">Year</th>
                    <th className="text-left p-3 font-medium">Tier</th>
                    <th className="text-right p-3 font-medium">{periodLabel} Cost</th>
                    <th className="text-right p-3 font-medium">Adjustments</th>
                    <th className="text-center p-3 font-medium">Method</th>
                    <th className="text-right p-3 font-medium">Net Cost</th>
                    <th className="text-right p-3 font-medium">Gross Cost</th>
                    <th className="text-left p-3 font-medium">Status</th>
                    <th className="text-center p-3 font-medium">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((record) => {
                    const hasAdjustments = (record.free_period_discount > 0) || (record.prorata_cost !== null) || (record.rollover_discount > 0);
                    const invoiceId = record.accounting_invoice_id || record.xero_invoice_id;
                    const invoiceNumber = record.accounting_invoice_number || record.xero_invoice_number;
                    return (
                      <tr key={record.id} className="border-b last:border-0" data-testid={`row-member-history-${record.id}`}>
                        <td className="p-3 font-medium">{record.membership_year}</td>
                        <td className="p-3">
                          <Badge variant="secondary">{record.tier_label || '-'}</Badge>
                        </td>
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
                        <td className="p-3 text-center" data-testid={`cell-member-history-method-${record.id}`}>
                          {record.payment_method === 'stripe' ? (
                            <CreditCard className="w-4 h-4 text-blue-600 dark:text-blue-400 inline-block" />
                          ) : record.payment_method ? (
                            <FileText className="w-4 h-4 text-muted-foreground inline-block" />
                          ) : '-'}
                        </td>
                        <td className="p-3 text-right font-semibold">{formatCost(record.final_cost, record.currency)}</td>
                        <td className="p-3 text-right font-semibold">{formatCost(record.total_with_vat || record.final_cost, record.currency)}</td>
                        <td className="p-3">
                          <div className="flex items-center gap-1 flex-wrap">
                            <Badge variant={record.status === 'active' ? 'secondary' : 'outline'}>
                              {record.status || 'active'}
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
                            <div className="text-center text-muted-foreground" data-testid={`cell-no-invoice-${record.id}`}>-</div>
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

      <Dialog open={overrideModalOpen} onOpenChange={setOverrideModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle data-testid="text-member-override-title">Override {overrideTargetYear || ''} Cost</DialogTitle>
            <DialogDescription>
              Override the automatically calculated membership cost for {overrideTargetYear || 'this year'}.
              A note will be added to the member's Notes tab.
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
                data-testid="radio-member-override-type"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="structure" id="member-override-structure" data-testid="radio-member-structure" />
                  <Label htmlFor="member-override-structure" className="text-sm cursor-pointer">
                    Use a different tier structure
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="price" id="member-override-price" data-testid="radio-member-price" />
                  <Label htmlFor="member-override-price" className="text-sm cursor-pointer">
                    Set a manual price
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="discount" id="member-override-discount" data-testid="radio-member-discount" />
                  <Label htmlFor="member-override-discount" className="text-sm cursor-pointer">
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
                    <SelectTrigger data-testid="select-member-config">
                      <SelectValue placeholder="Choose a tier structure..." />
                    </SelectTrigger>
                    <SelectContent>
                      {availableConfigs?.map((cfg) => (
                        <SelectItem key={cfg.id} value={cfg.id} data-testid={`option-member-config-${cfg.id}`}>
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
                <Label htmlFor="member-manual-price" className="text-sm font-medium">
                  Manual Price ({getCurrencySymbol(currency)})
                </Label>
                <Input
                  id="member-manual-price"
                  type="number"
                  min="0"
                  step="0.01"
                  value={manualPrice}
                  onChange={(e) => setManualPrice(e.target.value)}
                  placeholder="Enter price..."
                  data-testid="input-member-manual-price"
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
                  data-testid="radio-member-discount-type"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="percentage" id="member-discount-percentage" data-testid="radio-member-discount-percentage" />
                    <Label htmlFor="member-discount-percentage" className="text-sm cursor-pointer">
                      Percentage (%)
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="fixed" id="member-discount-fixed" data-testid="radio-member-discount-fixed" />
                    <Label htmlFor="member-discount-fixed" className="text-sm cursor-pointer">
                      Fixed amount ({getCurrencySymbol(currency)})
                    </Label>
                  </div>
                </RadioGroup>

                <div className="space-y-2">
                  <Label htmlFor="member-discount-value" className="text-sm font-medium">
                    {discountType === 'percentage' ? 'Discount Percentage' : `Discount Amount (${getCurrencySymbol(currency)})`}
                  </Label>
                  <Input
                    id="member-discount-value"
                    type="number"
                    min="0"
                    max={discountType === 'percentage' ? '100' : undefined}
                    step={discountType === 'percentage' ? '0.1' : '0.01'}
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    placeholder={discountType === 'percentage' ? 'e.g. 10' : 'e.g. 100.00'}
                    data-testid="input-member-discount-value"
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
              <Label htmlFor="member-override-note" className="text-sm font-medium">
                Reason for Override <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="member-override-note"
                value={overrideNote}
                onChange={(e) => setOverrideNote(e.target.value)}
                placeholder="Explain why this override is being applied..."
                rows={3}
                data-testid="textarea-member-override-note"
              />
              <p className="text-xs text-muted-foreground">
                This note will be added to the member's Notes tab for audit purposes.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setOverrideModalOpen(false)}
              data-testid="button-member-cancel-override"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveOverride}
              disabled={overrideMutation.isPending}
              data-testid="button-member-save-override"
            >
              {overrideMutation.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              Save Override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={emailFeesDialogOpen}
        onOpenChange={(open) => {
          setEmailFeesDialogOpen(open);
          if (!open && !emailFeesMutation.isPending) setEmailFeesTargetYear(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="w-4 h-4" />
              Email Membership Fees
            </DialogTitle>
            <DialogDescription>
              Send the calculated {emailFeesTargetYear || ''} fee to {effectiveMemberEmail || 'this member'}.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/40 p-3 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Recipient</span>
              <span className="font-medium break-all text-right" data-testid="text-member-email-fees-recipient">
                {effectiveMemberEmail || 'No email address'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              The email links to the member payment page, where the payment, Direct Debit, and purchase-order options configured for this membership tier are shown. Sending does not create a membership record.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEmailFeesDialogOpen(false)}
              disabled={emailFeesMutation.isPending}
              data-testid="button-member-email-fees-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => emailFeesMutation.mutate({ membershipYear: emailFeesTargetYear })}
              disabled={emailFeesMutation.isPending || !emailFeesTargetYear || !effectiveMemberEmail}
              data-testid="button-member-email-fees-confirm"
            >
              {emailFeesMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
              Send Fee Email
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
                  {' | '}Member: <span className="font-medium">{simulationResults.member}</span>
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
                  <div key={idx} className="flex items-start gap-2 py-1.5 border-b last:border-b-0" data-testid={`member-simulation-step-${idx}`}>
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
              data-testid="button-member-close-simulation"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
