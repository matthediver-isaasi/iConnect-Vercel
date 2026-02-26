import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Layers, Save, Loader2, CalendarDays, TrendingUp,
  History, AlertCircle, Wallet, ArrowRight,
  FileText, Send, PlayCircle, ShieldAlert,
  Lock, LockOpen, ShieldCheck, XCircle, Mail
} from "lucide-react";
import { toast } from "sonner";

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
          {approvalRequired && feesApproved && (
            <Badge variant="outline" className="text-xs text-green-700 border-green-300 dark:text-green-400 dark:border-green-700" data-testid={`badge-member-approved-${testIdPrefix}`}>
              <ShieldCheck className="w-3 h-3 mr-1" />
              Approved
            </Badge>
          )}
        </div>
      </div>
      <p className="font-semibold" data-testid={`text-member-year-${testIdPrefix}`}>{yearData.membershipYear}</p>

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
            {showRecordFee && currentYearRecorded ? 'Recorded Cost' : 'Final Cost'}
          </span>
          <span className="font-semibold">{formatCost(yearData.finalCost, currency)}</span>
        </div>
      </div>

      {showRecordFee && currentYearRecorded && (
        <div className="mt-2">
          <Badge variant="secondary">
            Recorded: {formatCost(currentYearRecorded.final_cost, currency)}
          </Badge>
        </div>
      )}

      {currentYearRecorded ? (
        <>
          <Separator className="my-3" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`text-member-invoicing-complete-${testIdPrefix}`}>
            <FileText className="w-3 h-3" />
            <span>Fee recorded for {yearData.membershipYear}</span>
          </div>
        </>
      ) : hideInvoicing ? (
        <>
          <Separator className="my-3" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`text-member-invoicing-pending-${testIdPrefix}`}>
            <FileText className="w-3 h-3" />
            <span>Invoicing controls will be available once the current year has been processed</span>
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
              <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
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

  useEffect(() => {
    if (invoicingData?.settings) {
      const modes = {};
      const dates = {};
      const poNumbers = {};
      const poMemberFlags = {};
      const approvedFlags = {};
      for (const [yearKey, setting] of Object.entries(invoicingData.settings)) {
        if (yearKey === '_legacy') continue;
        modes[yearKey] = setting.invoicing_mode || 'manual';
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

  const history = Array.isArray(data?.history) ? data.history : [];
  const currentYearData = data?.currentYearCost || null;
  const nextYearData = data?.nextYearPreview || null;
  const config = data?.config || null;
  const currency = config?.currency || 'GBP';
  const periodLabel = config?.billing_period === 'monthly' ? 'Monthly' : config?.billing_period === 'quarterly' ? 'Quarterly' : 'Annual';

  const currentYearRecorded = currentYearData
    ? history.find(h => h.membership_year === currentYearData.membershipYear)
    : null;

  if (!config && !isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <Layers className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p data-testid="text-member-no-config">No member-scoped membership tier structure has been configured</p>
          <p className="text-sm mt-1">Set up member-scoped tier bands in Membership Tier Management to see pricing here</p>
        </CardContent>
      </Card>
    );
  }

  const makeInvoicingHandlers = (yearData, testIdPrefix) => {
    if (!yearData) return {};
    const year = yearData.membershipYear;
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
      feesApproved: !!feesApprovedMap[year],
      onApprove: () => approvalMutation.mutate({ membershipYear: year, action: 'approve' }),
      onUnapprove: () => approvalMutation.mutate({ membershipYear: year, action: 'unapprove' }),
      approvePending: approvalMutation.isPending,
    };
  };

  return (
    <div className="space-y-4">
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
                testIdPrefix="current-year"
                onManualRenewal={() => manualRenewalMutation.mutate({ membershipYear: currentYearData?.membershipYear })}
                manualRenewalPending={manualRenewalMutation.isPending}
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
                showRecordFee={false}
                currentYearRecorded={null}
                testIdPrefix="next-year"
                onManualRenewal={null}
                manualRenewalPending={false}
                hideInvoicing={!currentYearRecorded}
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
                    <th className="text-right p-3 font-medium">Final Cost</th>
                    <th className="text-left p-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((record) => {
                    const hasAdjustments = (record.free_period_discount > 0) || (record.prorata_cost !== null) || (record.rollover_discount > 0);
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
                        <td className="p-3 text-right font-semibold">{formatCost(record.final_cost, record.currency)}</td>
                        <td className="p-3">
                          <Badge variant={record.status === 'active' ? 'secondary' : 'outline'}>
                            {record.status || 'active'}
                          </Badge>
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
    </div>
  );
}
