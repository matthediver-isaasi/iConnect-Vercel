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
  History, AlertCircle, Wallet, ArrowRight, Pencil, X, ShieldAlert,
  FileText, Send, PlayCircle, CheckCircle2, XCircle, Info, AlertTriangle
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

function YearCostSection({
  yearData,
  yearLabel,
  currency,
  periodLabel,
  fieldLabel,
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
}) {
  if (!yearData) return null;

  const hasOverride = !!yearData.overrideType;

  return (
    <div data-testid={`section-${testIdPrefix}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            <Wallet className="w-3 h-3" />
            {yearLabel}
          </p>
          {isNewOrg && testIdPrefix === 'current-year' && (
            <Badge variant="outline" className="text-xs">New Member</Badge>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <Button
            size="sm"
            variant={hasOverride ? "secondary" : "outline"}
            onClick={() => onOpenOverride(yearData.membershipYear)}
            data-testid={`button-override-${testIdPrefix}`}
          >
            <Pencil className="w-3 h-3 mr-1" />
            {hasOverride ? 'Edit Override' : 'Override'}
          </Button>
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
        <div className="mt-2 p-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
          <div className="flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                {yearData.overrideType === 'price' ? 'Manual Price Override' : 'Structure Override'}
                {yearData.overrideConfigName && ` - ${yearData.overrideConfigName}`}
              </p>
              {yearData.overrideNote && (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">{yearData.overrideNote}</p>
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
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Based on {fieldLabel}</span>
          <span className="font-medium">{yearData.fieldValue?.toLocaleString() ?? 'N/A'}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Tier</span>
          <Badge variant="secondary">{yearData.tierLabel || 'Unmapped'}</Badge>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{hasOverride && yearData.overrideType === 'price' ? 'Override Price' : `${periodLabel} Cost`}</span>
          <span className="font-medium">{formatCost(yearData.annualCost, currency)}</span>
        </div>
        {yearData.customDiscountTotal > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Custom Discounts</span>
            <span className="text-green-600">-{formatCost(yearData.customDiscountTotal, currency)}</span>
          </div>
        )}
        {yearData.freeDiscount > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Free Period ({yearData.freePeriodDaysUsed !== null && yearData.freePeriodTotalDays !== null
                ? `${yearData.freePeriodDaysUsed} days of ${yearData.freePeriodAmount} ${yearData.freePeriodUnit} used`
                : `${yearData.freePeriodAmount} ${yearData.freePeriodUnit}`})
            </span>
            <span className="text-green-600">-{formatCost(yearData.freeDiscount, currency)}</span>
          </div>
        )}
        {yearData.proRataEnabled && yearData.remainingDays !== null && (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">After Free Period</span>
              <span className="font-medium">{formatCost(yearData.costAfterFreeDiscount, currency)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Pro-rata ({yearData.remainingDays} of {yearData.totalDays} days)</span>
              <span className="font-medium">{formatCost(yearData.prorataCost, currency)}</span>
            </div>
          </>
        )}
        {yearData.rolloverDiscount > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Rollover Discount</span>
            <span className="text-green-600">-{formatCost(yearData.rolloverDiscount, currency)}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-sm border-t pt-1">
          <span className="text-muted-foreground font-medium">
            {showRecordFee && currentYearRecorded ? 'Recorded Cost' : 'Final Cost'}
          </span>
          <span className="font-semibold">{formatCost(yearData.finalCost, currency)}</span>
        </div>
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

      {!hasOverride && (
        <p className="text-xs text-muted-foreground mt-2">
          Based on current {fieldLabel.toLowerCase()} and the active tier structure. This may change if the {fieldLabel.toLowerCase()} or structure is updated.
        </p>
      )}
    </div>
  );
}

export default function OrgMembershipTab({ organizationId }) {
  const queryClient = useQueryClient();
  const [editingFieldValue, setEditingFieldValue] = useState(null);
  const [isEditingField, setIsEditingField] = useState(false);
  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [overrideTargetYear, setOverrideTargetYear] = useState(null);
  const [overrideType, setOverrideType] = useState('structure');
  const [selectedConfigId, setSelectedConfigId] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const [invoicingMode, setInvoicingMode] = useState('manual');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [simulationResults, setSimulationResults] = useState(null);
  const [simulationDialogOpen, setSimulationDialogOpen] = useState(false);

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
    if (invoicingData?.invoicing_mode) setInvoicingMode(invoicingData.invoicing_mode);
    if (invoicingData?.invoice_date) setInvoiceDate(invoicingData.invoice_date);
  }, [invoicingData]);

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

  const manualRenewalMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/membership/org-membership-invoicing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ organizationId }),
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
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const resetOverrideForm = () => {
    setOverrideType('structure');
    setSelectedConfigId('');
    setManualPrice('');
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

    overrideMutation.mutate({
      organizationId,
      overrideType,
      configId: overrideType === 'structure' ? selectedConfigId : null,
      manualPrice: overrideType === 'price' ? parseFloat(manualPrice) : null,
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
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <AlertCircle className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p>Failed to load membership data</p>
        </CardContent>
      </Card>
    );
  }

  if (!data?.config) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <Layers className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p>No membership tier structure has been configured yet</p>
          <p className="text-sm mt-1">Set up tier bands in Membership Tier Management to see pricing here</p>
        </CardContent>
      </Card>
    );
  }

  const { config, currentTier, fieldValue, fieldLabel, currentYear, nextYearPreview, currentYearCost, isNewOrg, goLiveDate, history, bands } = data;
  const currency = config.currency || 'GBP';
  const periodLabel = config.billing_period === 'annual' ? 'Annual' : config.billing_period === 'monthly' ? 'Monthly' : 'Quarterly';
  const isAutoField = config.field_source === 'core' && config.field_name === 'member_count';

  const currentYearRecorded = history?.find(h => h.membership_year === currentYear?.label);

  const overrideTargetData = overrideTargetYear === currentYearCost?.membershipYear
    ? currentYearCost
    : overrideTargetYear === nextYearPreview?.membershipYear
      ? nextYearPreview
      : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-4 h-4" />
            Current Tier
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
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
                isNewOrg={isNewOrg}
                goLiveDate={goLiveDate}
                showRecordFee={true}
                currentYearRecorded={currentYearRecorded}
                recordMutation={recordMutation}
                organizationId={organizationId}
                onOpenOverride={handleOpenOverrideModal}
                onRemoveOverride={(year) => removeOverrideMutation.mutate(year)}
                removeOverridePending={removeOverrideMutation.isPending}
                onSimulate={(membershipYear) => simulateRenewalMutation.mutate({ mode: invoicingMode, targetYear: membershipYear })}
                simulatePending={simulateRenewalMutation.isPending}
                testIdPrefix="current-year"
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
                isNewOrg={false}
                goLiveDate={null}
                showRecordFee={false}
                currentYearRecorded={null}
                recordMutation={recordMutation}
                organizationId={organizationId}
                onOpenOverride={handleOpenOverrideModal}
                onRemoveOverride={(year) => removeOverrideMutation.mutate(year)}
                removeOverridePending={removeOverrideMutation.isPending}
                onSimulate={(membershipYear) => simulateRenewalMutation.mutate({ mode: invoicingMode, targetYear: membershipYear })}
                simulatePending={simulateRenewalMutation.isPending}
                testIdPrefix="next-year"
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
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="w-4 h-4" />
            Invoicing
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div>
            <RadioGroup
              value={invoicingMode}
              onValueChange={(val) => {
                setInvoicingMode(val);
                if (val !== 'scheduled') setInvoiceDate('');
              }}
              className="space-y-2"
              data-testid="radio-invoicing-mode"
            >
              <div className="flex items-start gap-2">
                <RadioGroupItem value="automatic" id="invoicing-automatic" data-testid="radio-invoicing-automatic" className="mt-0.5" />
                <div>
                  <Label htmlFor="invoicing-automatic" className="text-sm cursor-pointer">Automatic</Label>
                  <p className="text-xs text-muted-foreground">Renew membership and generate invoice automatically at start of schedule</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="scheduled" id="invoicing-scheduled" data-testid="radio-invoicing-scheduled" className="mt-0.5" />
                <div className="flex-1">
                  <Label htmlFor="invoicing-scheduled" className="text-sm cursor-pointer">Specify date</Label>
                  <p className="text-xs text-muted-foreground">Renew membership at start of schedule but generate and send invoice on a specific date</p>
                  {invoicingMode === 'scheduled' && (
                    <Input
                      type="date"
                      value={invoiceDate}
                      onChange={(e) => setInvoiceDate(e.target.value)}
                      min={new Date().toISOString().split('T')[0]}
                      className="mt-2 w-48"
                      data-testid="input-invoice-date"
                    />
                  )}
                </div>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="manual" id="invoicing-manual" data-testid="radio-invoicing-manual" className="mt-0.5" />
                <div>
                  <Label htmlFor="invoicing-manual" className="text-sm cursor-pointer">Manual</Label>
                  <p className="text-xs text-muted-foreground">Manually trigger renewal and invoice generation when ready</p>
                </div>
              </div>
            </RadioGroup>

            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (invoicingMode === 'scheduled' && !invoiceDate) {
                    toast.error('Please select an invoice date');
                    return;
                  }
                  invoicingMutation.mutate({
                    organizationId,
                    invoicingMode,
                    invoiceDate: invoicingMode === 'scheduled' ? invoiceDate : null,
                  });
                }}
                disabled={invoicingMutation.isPending}
                data-testid="button-save-invoicing"
              >
                {invoicingMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
                Save
              </Button>
              {invoicingMode === 'manual' && (
                <Button
                  size="sm"
                  onClick={() => manualRenewalMutation.mutate()}
                  disabled={manualRenewalMutation.isPending}
                  data-testid="button-renew-now"
                >
                  {manualRenewalMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Send className="w-3 h-3 mr-1" />}
                  Renew &amp; Invoice Now
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

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
                  </tr>
                </thead>
                <tbody>
                  {history.map((record) => {
                    const hasAdjustments = (record.free_period_discount > 0) || (record.prorata_cost !== null) || (record.rollover_discount > 0);
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
                  : step.status === 'warning' ? 'text-yellow-600 dark:text-yellow-500'
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
            <div className="mt-3 p-3 rounded-md bg-muted/50">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Final Cost</span>
                <span className="font-semibold">
                  {formatCost(simulationResults.finalCost, simulationResults.currency)}
                </span>
              </div>
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
    </div>
  );
}
