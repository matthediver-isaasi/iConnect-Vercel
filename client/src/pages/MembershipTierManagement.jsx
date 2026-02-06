import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Layers, Plus, Trash2, Save, Building2, AlertCircle,
  Search, Download, History, CalendarDays, ChevronRight, Eye, PlusCircle
} from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const MONTHS = [
  { value: 1, label: 'January' }, { value: 2, label: 'February' }, { value: 3, label: 'March' },
  { value: 4, label: 'April' }, { value: 5, label: 'May' }, { value: 6, label: 'June' },
  { value: 7, label: 'July' }, { value: 8, label: 'August' }, { value: 9, label: 'September' },
  { value: 10, label: 'October' }, { value: 11, label: 'November' }, { value: 12, label: 'December' },
];

const FREE_PERIOD_UNITS = [
  { value: 'days', label: 'Days' },
  { value: 'weeks', label: 'Weeks' },
  { value: 'months', label: 'Months' },
];

function getDaysInMonth(month) {
  return new Date(2024, month, 0).getDate();
}

const CURRENCIES = [
  { value: 'GBP', label: 'GBP (\u00a3)', symbol: '\u00a3' },
  { value: 'USD', label: 'USD ($)', symbol: '$' },
  { value: 'EUR', label: 'EUR (\u20ac)', symbol: '\u20ac' },
  { value: 'AUD', label: 'AUD (A$)', symbol: 'A$' },
  { value: 'NZD', label: 'NZD (NZ$)', symbol: 'NZ$' },
];

const BILLING_PERIODS = [
  { value: 'annual', label: 'Annual' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
];

function getCurrencySymbol(code) {
  return CURRENCIES.find(c => c.value === code)?.symbol || code;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

export default function MembershipTierManagement() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const queryClient = useQueryClient();

  const [config, setConfig] = useState({
    id: null,
    name: 'Default',
    field_source: '',
    field_id: null,
    field_name: null,
    currency: 'GBP',
    billing_period: 'annual',
    is_active: true,
    effective_from: getTodayStr(),
    membership_start_month: 1,
    membership_start_day: 1,
    prorata_enabled: false,
    free_period_amount: null,
    free_period_unit: null,
    rollover_enabled: false,
  });

  const [bands, setBands] = useState([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewSearch, setPreviewSearch] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [viewingHistorical, setViewingHistorical] = useState(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_MembershipTierManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: tierData, isLoading: loadingConfig } = useQuery({
    queryKey: ['membership-tiers'],
    queryFn: async () => {
      const response = await fetch('/api/membership/tiers', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch tier configuration');
      return response.json();
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: availableFields = [], isLoading: loadingFields } = useQuery({
    queryKey: ['membership-tier-fields'],
    queryFn: async () => {
      const response = await fetch('/api/membership/tiers?action=fields', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch available fields');
      return response.json();
    },
  });

  const { data: historicalData, isLoading: loadingHistorical } = useQuery({
    queryKey: ['membership-tier-historical', viewingHistorical],
    queryFn: async () => {
      const response = await fetch(`/api/membership/tiers?configId=${viewingHistorical}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch historical config');
      return response.json();
    },
    enabled: !!viewingHistorical,
  });

  const { data: previewData, isLoading: loadingPreview, refetch: refetchPreview } = useQuery({
    queryKey: ['membership-tier-preview', viewingHistorical],
    queryFn: async () => {
      const url = viewingHistorical
        ? `/api/membership/tiers?action=preview&configId=${viewingHistorical}`
        : '/api/membership/tiers?action=preview';
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch preview');
      return response.json();
    },
    enabled: showPreview,
    staleTime: 0,
  });

  useEffect(() => {
    if (viewingHistorical && historicalData?.config) {
      const c = historicalData.config;
      setConfig({
        id: c.id,
        name: c.name || 'Default',
        field_source: c.field_source || '',
        field_id: c.field_id || null,
        field_name: c.field_name || null,
        currency: c.currency || 'GBP',
        billing_period: c.billing_period || 'annual',
        is_active: c.is_active !== false,
        effective_from: c.effective_from || '',
        membership_start_month: c.membership_start_month ?? 1,
        membership_start_day: c.membership_start_day ?? 1,
        prorata_enabled: c.prorata_enabled ?? false,
        free_period_amount: c.free_period_amount ?? null,
        free_period_unit: c.free_period_unit ?? null,
        rollover_enabled: c.rollover_enabled ?? false,
      });
      setBands((historicalData.bands || []).map(b => ({
        ...b,
        min_value: b.min_value?.toString() || '0',
        max_value: b.max_value?.toString() || '',
        annual_cost: b.annual_cost?.toString() || '0',
      })));
      setHasChanges(false);
      setIsCreatingNew(false);
    }
  }, [viewingHistorical, historicalData]);

  useEffect(() => {
    if (tierData && !viewingHistorical && !isCreatingNew) {
      if (tierData.config) {
        const c = tierData.config;
        setConfig({
          id: c.id,
          name: c.name || 'Default',
          field_source: c.field_source || '',
          field_id: c.field_id || null,
          field_name: c.field_name || null,
          currency: c.currency || 'GBP',
          billing_period: c.billing_period || 'annual',
          is_active: c.is_active !== false,
          effective_from: c.effective_from || '',
          membership_start_month: c.membership_start_month ?? 1,
          membership_start_day: c.membership_start_day ?? 1,
          prorata_enabled: c.prorata_enabled ?? false,
          free_period_amount: c.free_period_amount ?? null,
          free_period_unit: c.free_period_unit ?? null,
          rollover_enabled: c.rollover_enabled ?? false,
        });
      }
      if (tierData.bands?.length > 0) {
        setBands(tierData.bands.map(b => ({
          ...b,
          min_value: b.min_value?.toString() || '0',
          max_value: b.max_value?.toString() || '',
          annual_cost: b.annual_cost?.toString() || '0',
        })));
      } else if (!tierData.config) {
        setBands([]);
      }
      setHasChanges(false);
    }
  }, [tierData, viewingHistorical, isCreatingNew]);

  const saveMutation = useMutation({
    mutationFn: async (payload) => {
      const response = await fetch('/api/membership/tiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to save');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['membership-tiers'] });
      queryClient.invalidateQueries({ queryKey: ['membership-tier-preview'] });
      setHasChanges(false);
      setIsCreatingNew(false);
      setViewingHistorical(null);
      if (data.config) {
        setConfig(prev => ({ ...prev, id: data.config.id }));
      }
      toast.success(isCreatingNew ? 'New tier structure created successfully' : 'Membership tier structure saved successfully');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to save tier structure');
    },
  });

  const handleFieldChange = (fieldKey) => {
    if (fieldKey.startsWith('core:')) {
      const coreName = fieldKey.replace('core:', '');
      setConfig(prev => ({
        ...prev,
        field_source: 'core',
        field_id: null,
        field_name: coreName,
      }));
    } else {
      const field = availableFields.find(f => f.id === fieldKey);
      setConfig(prev => ({
        ...prev,
        field_source: 'custom',
        field_id: fieldKey,
        field_name: field?.label || field?.name || null,
      }));
    }
    setHasChanges(true);
  };

  const handleConfigChange = (key, value) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const addBand = () => {
    const lastBand = bands[bands.length - 1];
    const nextMin = lastBand ? (parseFloat(lastBand.max_value) + 1 || parseFloat(lastBand.min_value) + 100) : 0;

    setBands(prev => [...prev, {
      id: `new-${Date.now()}`,
      label: `Tier ${prev.length + 1}`,
      min_value: nextMin.toString(),
      max_value: '',
      annual_cost: '0',
    }]);
    setHasChanges(true);
  };

  const updateBand = (index, key, value) => {
    setBands(prev => prev.map((b, i) => i === index ? { ...b, [key]: value } : b));
    setHasChanges(true);
  };

  const removeBand = (index) => {
    setBands(prev => prev.filter((_, i) => i !== index));
    setHasChanges(true);
  };

  const handleSave = () => {
    if (!config.field_source) {
      toast.error('Please select a field to base tiers on');
      return;
    }

    if (!config.effective_from) {
      toast.error('Please set an effective from date');
      return;
    }

    if (bands.length === 0) {
      toast.error('Please add at least one tier band');
      return;
    }

    for (let i = 0; i < bands.length; i++) {
      const band = bands[i];
      if (!band.label?.trim()) {
        toast.error(`Tier ${i + 1} needs a label`);
        return;
      }
      if (isNaN(parseFloat(band.min_value))) {
        toast.error(`Tier "${band.label}" has an invalid minimum value`);
        return;
      }
      if (isNaN(parseFloat(band.annual_cost))) {
        toast.error(`Tier "${band.label}" has an invalid cost`);
        return;
      }
    }

    const payload = {
      config: {
        ...config,
        id: isCreatingNew ? undefined : config.id,
      },
      bands: bands.map(b => ({
        label: b.label,
        min_value: parseFloat(b.min_value) || 0,
        max_value: b.max_value !== '' && b.max_value !== null && b.max_value !== undefined ? parseFloat(b.max_value) : null,
        annual_cost: parseFloat(b.annual_cost) || 0,
      })),
    };

    saveMutation.mutate(payload);
  };

  const handleCreateNew = () => {
    const currentConfig = tierData?.config;
    setIsCreatingNew(true);
    setViewingHistorical(null);
    setConfig({
      id: null,
      name: '',
      field_source: currentConfig?.field_source || '',
      field_id: currentConfig?.field_id || null,
      field_name: currentConfig?.field_name || null,
      currency: currentConfig?.currency || 'GBP',
      billing_period: currentConfig?.billing_period || 'annual',
      is_active: true,
      effective_from: getTodayStr(),
      membership_start_month: currentConfig?.membership_start_month ?? 1,
      membership_start_day: currentConfig?.membership_start_day ?? 1,
      prorata_enabled: currentConfig?.prorata_enabled ?? false,
      free_period_amount: currentConfig?.free_period_amount ?? null,
      free_period_unit: currentConfig?.free_period_unit ?? null,
      rollover_enabled: currentConfig?.rollover_enabled ?? false,
    });
    if (tierData?.bands?.length > 0) {
      setBands(tierData.bands.map(b => ({
        ...b,
        id: `new-${Date.now()}-${Math.random()}`,
        min_value: b.min_value?.toString() || '0',
        max_value: b.max_value?.toString() || '',
        annual_cost: b.annual_cost?.toString() || '0',
      })));
    } else {
      setBands([]);
    }
    setHasChanges(true);
    setShowHistory(false);
  };

  const handleViewHistorical = (configId) => {
    setViewingHistorical(configId);
    setIsCreatingNew(false);
    setShowHistory(false);
    setShowPreview(false);
  };

  const handleBackToCurrent = () => {
    setViewingHistorical(null);
    setIsCreatingNew(false);
    setHasChanges(false);
  };

  const selectedFieldKey = config.field_source === 'core'
    ? `core:${config.field_name}`
    : config.field_id || '';

  const selectedFieldLabel = useMemo(() => {
    if (config.field_source === 'core') return config.field_name === 'member_count' ? 'Member Count' : config.field_name;
    const field = availableFields.find(f => f.id === config.field_id);
    return field?.label || field?.name || config.field_name || '';
  }, [config, availableFields]);

  const filteredPreviewOrgs = useMemo(() => {
    const all = [...(previewData?.organizations || []), ...(previewData?.unmapped || [])];
    if (!previewSearch) return all;
    const q = previewSearch.toLowerCase();
    return all.filter(o => o.name.toLowerCase().includes(q));
  }, [previewData, previewSearch]);

  const handleExportCsv = () => {
    if (!previewData) return;

    const allOrgs = [...(previewData.organizations || []), ...(previewData.unmapped || [])];
    const symbol = getCurrencySymbol(config.currency);
    const periodLabel = config.billing_period === 'annual' ? 'Annual' : config.billing_period === 'monthly' ? 'Monthly' : 'Quarterly';
    const headers = ['Organisation', 'Status', selectedFieldLabel || 'Field Value', 'Tier', `${periodLabel} Cost (${symbol})`];
    const rows = allOrgs.map(org => [
      org.name,
      org.status || '',
      org.fieldValue ?? 'N/A',
      org.tierLabel || 'Unmapped',
      org.annualCost != null ? org.annualCost.toFixed(2) : '',
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `membership-tiers-preview-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!accessChecked) {
    return <div className="p-6 flex items-center justify-center h-full"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  const currencySymbol = getCurrencySymbol(config.currency);
  const isHistoricalView = viewingHistorical && historicalData?.isHistorical;
  const isEditable = !isHistoricalView;
  const historyItems = tierData?.history || [];
  const currentConfigId = tierData?.config?.id;
  const periodLabel = config.billing_period === 'annual' ? 'Annual' : config.billing_period === 'monthly' ? 'Monthly' : 'Quarterly';

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <Layers className="w-6 h-6" />
            Membership Tier Structure
          </h1>
          <p className="text-muted-foreground mt-1">
            {isCreatingNew
              ? 'Creating a new tier structure'
              : isHistoricalView
                ? 'Viewing historical tier structure (read-only)'
                : 'Define pricing tiers based on organisation attributes'
            }
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {(viewingHistorical || isCreatingNew) && (
            <Button variant="outline" onClick={handleBackToCurrent} data-testid="button-back-current">
              <ChevronRight className="w-4 h-4 mr-1 rotate-180" />
              Back to Current
            </Button>
          )}
          {historyItems.length > 0 && !isCreatingNew && (
            <Button
              variant="outline"
              onClick={() => setShowHistory(!showHistory)}
              data-testid="button-toggle-history"
            >
              <History className="w-4 h-4 mr-2" />
              History ({historyItems.length})
            </Button>
          )}
          {!isHistoricalView && !isCreatingNew && tierData?.config && (
            <Button variant="outline" onClick={handleCreateNew} data-testid="button-create-new">
              <PlusCircle className="w-4 h-4 mr-2" />
              New Structure
            </Button>
          )}
          {!isHistoricalView && (
            <Button
              variant="outline"
              onClick={() => {
                setShowPreview(!showPreview);
                if (!showPreview) refetchPreview();
              }}
              data-testid="button-toggle-preview"
            >
              <Building2 className="w-4 h-4 mr-2" />
              {showPreview ? 'Hide Preview' : 'Preview'}
            </Button>
          )}
          {isEditable && (
            <Button
              onClick={handleSave}
              disabled={!hasChanges || saveMutation.isPending}
              data-testid="button-save-tiers"
            >
              <Save className="w-4 h-4 mr-2" />
              {saveMutation.isPending ? 'Saving...' : isCreatingNew ? 'Create' : 'Save'}
            </Button>
          )}
        </div>
      </div>

      {isHistoricalView && (
        <div className="p-3 bg-muted/50 border rounded-md flex items-center gap-2">
          <History className="w-4 h-4 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            This is a historical tier structure effective from <strong>{formatDate(config.effective_from)}</strong>
            {historicalData?.config?.effective_to && <> to <strong>{formatDate(historicalData.config.effective_to)}</strong></>}.
            It is read-only. To make changes, create a new tier structure.
          </p>
        </div>
      )}

      {isCreatingNew && tierData?.config && (
        <div className="p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <p className="text-sm text-blue-700 dark:text-blue-300">
            Creating a new tier structure will automatically close the current one (effective since {formatDate(tierData.config.effective_from)}).
            The current structure's end date will be set to the day before this new structure starts.
          </p>
        </div>
      )}

      {showHistory && historyItems.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Tier Structure History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {historyItems.map((item) => {
                const isCurrent = item.effective_to === null;
                const isViewing = viewingHistorical === item.id || (!viewingHistorical && !isCreatingNew && isCurrent);
                return (
                  <div
                    key={item.id}
                    className={`flex items-center justify-between gap-3 p-3 rounded-md border ${isViewing ? 'border-primary bg-primary/5' : ''}`}
                    data-testid={`row-history-${item.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <CalendarDays className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium truncate">{item.name || 'Tier Structure'}</p>
                        <p className="text-sm text-muted-foreground">
                          {formatDate(item.effective_from) || 'No start date'}
                          {item.effective_to ? ` - ${formatDate(item.effective_to)}` : ' - Present'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {isCurrent && <Badge variant="secondary">Current</Badge>}
                      {!isViewing && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => isCurrent ? handleBackToCurrent() : handleViewHistorical(item.id)}
                          data-testid={`button-view-history-${item.id}`}
                        >
                          <Eye className="w-3 h-3 mr-1" />
                          View
                        </Button>
                      )}
                      {isViewing && (
                        <Badge>Viewing</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label data-testid="label-field-selector">Based On Field</Label>
              <Select
                value={selectedFieldKey}
                onValueChange={handleFieldChange}
                disabled={!isEditable}
              >
                <SelectTrigger data-testid="select-field">
                  <SelectValue placeholder={loadingFields ? "Loading fields..." : "Select a numerical field"} />
                </SelectTrigger>
                <SelectContent>
                  {availableFields.map(field => (
                    <SelectItem
                      key={field.is_core ? `core:${field.name}` : field.id}
                      value={field.is_core ? `core:${field.name}` : field.id}
                      data-testid={`option-field-${field.name}`}
                    >
                      {field.label || field.name}
                      {field.is_core && <span className="text-muted-foreground ml-1">(Core)</span>}
                    </SelectItem>
                  ))}
                  {availableFields.length === 0 && !loadingFields && (
                    <SelectItem value="__none" disabled>
                      No numerical fields found
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              {selectedFieldLabel && (
                <p className="text-sm text-muted-foreground">
                  Tiers will be based on each organisation's "{selectedFieldLabel}" value
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Currency</Label>
                <Select
                  value={config.currency}
                  onValueChange={(v) => handleConfigChange('currency', v)}
                  disabled={!isEditable}
                >
                  <SelectTrigger data-testid="select-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map(c => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Billing Period</Label>
                <Select
                  value={config.billing_period}
                  onValueChange={(v) => handleConfigChange('billing_period', v)}
                  disabled={!isEditable}
                >
                  <SelectTrigger data-testid="select-billing-period">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BILLING_PERIODS.map(p => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Structure Name</Label>
              <Input
                value={config.name}
                onChange={(e) => handleConfigChange('name', e.target.value)}
                placeholder="e.g. 2025/26 Pricing"
                disabled={!isEditable}
                data-testid="input-config-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Effective From</Label>
              <Input
                type="date"
                value={config.effective_from}
                onChange={(e) => handleConfigChange('effective_from', e.target.value)}
                disabled={!isEditable}
                data-testid="input-effective-from"
              />
              {!isCreatingNew && tierData?.config?.effective_to === null && config.effective_from && (
                <p className="text-sm text-muted-foreground">
                  This structure has been active since {formatDate(config.effective_from)}
                </p>
              )}
            </div>
          </div>

          <div className="border-t pt-4 mt-2">
            <h3 className="text-sm font-medium mb-3">Membership Year & Pro-rata Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Membership Year Start</Label>
                <div className="flex gap-2">
                  <Select
                    value={String(config.membership_start_month)}
                    onValueChange={(v) => {
                      const newMonth = parseInt(v);
                      const maxDay = getDaysInMonth(newMonth);
                      handleConfigChange('membership_start_month', newMonth);
                      if (config.membership_start_day > maxDay) {
                        handleConfigChange('membership_start_day', maxDay);
                      }
                    }}
                    disabled={!isEditable}
                  >
                    <SelectTrigger className="flex-1" data-testid="select-start-month">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTHS.map(m => (
                        <SelectItem key={m.value} value={String(m.value)}>{m.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={String(config.membership_start_day)}
                    onValueChange={(v) => handleConfigChange('membership_start_day', parseInt(v))}
                    disabled={!isEditable}
                  >
                    <SelectTrigger className="w-20" data-testid="select-start-day">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: getDaysInMonth(config.membership_start_month) }, (_, i) => i + 1).map(d => (
                        <SelectItem key={d} value={String(d)}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-sm text-muted-foreground">
                  The date each membership year begins (e.g. 1 April)
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>Pro-rata Year</Label>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Calculate fee based on remaining days in the membership year
                    </p>
                  </div>
                  <Switch
                    checked={config.prorata_enabled}
                    onCheckedChange={(v) => handleConfigChange('prorata_enabled', v)}
                    disabled={!isEditable}
                    data-testid="switch-prorata"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <div className="space-y-2">
                <Label>Free Period for New Members</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min="0"
                    value={config.free_period_amount ?? ''}
                    onChange={(e) => {
                      const val = e.target.value === '' ? null : parseInt(e.target.value);
                      handleConfigChange('free_period_amount', val);
                      if (val && !config.free_period_unit) {
                        handleConfigChange('free_period_unit', 'months');
                      }
                      if (!val) {
                        handleConfigChange('free_period_unit', null);
                      }
                    }}
                    placeholder="0"
                    className="w-24"
                    disabled={!isEditable}
                    data-testid="input-free-period-amount"
                  />
                  <Select
                    value={config.free_period_unit || 'months'}
                    onValueChange={(v) => handleConfigChange('free_period_unit', v)}
                    disabled={!isEditable || !config.free_period_amount}
                  >
                    <SelectTrigger className="w-28" data-testid="select-free-period-unit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FREE_PERIOD_UNITS.map(u => (
                        <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-sm text-muted-foreground">
                  Deducted from the annual fee for new members
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>Rollover Discount</Label>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      If free period extends beyond the current year, apply remaining discount to the next full year
                    </p>
                  </div>
                  <Switch
                    checked={config.rollover_enabled}
                    onCheckedChange={(v) => handleConfigChange('rollover_enabled', v)}
                    disabled={!isEditable || !config.free_period_amount}
                    data-testid="switch-rollover"
                  />
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-lg">Tier Bands</CardTitle>
          {isEditable && (
            <Button size="sm" onClick={addBand} data-testid="button-add-band">
              <Plus className="w-4 h-4 mr-1" />
              Add Tier
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {bands.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="text-no-bands">
              <Layers className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p>No tiers defined yet</p>
              <p className="text-sm mt-1">Add tier bands to define your membership pricing structure</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="hidden md:grid md:grid-cols-[1fr_120px_120px_140px_40px] gap-2 text-sm font-medium text-muted-foreground px-2">
                <span>Label</span>
                <span>Min Value</span>
                <span>Max Value</span>
                <span>{periodLabel} Cost ({currencySymbol})</span>
                <span></span>
              </div>

              {bands.map((band, index) => (
                <div
                  key={band.id || index}
                  className="grid grid-cols-1 md:grid-cols-[1fr_120px_120px_140px_40px] gap-2 items-center p-2 rounded-md border"
                  data-testid={`row-band-${index}`}
                >
                  <Input
                    value={band.label || ''}
                    onChange={(e) => updateBand(index, 'label', e.target.value)}
                    placeholder="e.g. Small School"
                    disabled={!isEditable}
                    data-testid={`input-band-label-${index}`}
                  />
                  <Input
                    type="number"
                    value={band.min_value || ''}
                    onChange={(e) => updateBand(index, 'min_value', e.target.value)}
                    placeholder="0"
                    disabled={!isEditable}
                    data-testid={`input-band-min-${index}`}
                  />
                  <Input
                    type="number"
                    value={band.max_value || ''}
                    onChange={(e) => updateBand(index, 'max_value', e.target.value)}
                    placeholder="No limit"
                    disabled={!isEditable}
                    data-testid={`input-band-max-${index}`}
                  />
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{currencySymbol}</span>
                    <Input
                      type="number"
                      value={band.annual_cost || ''}
                      onChange={(e) => updateBand(index, 'annual_cost', e.target.value)}
                      placeholder="0.00"
                      className="pl-7"
                      step="0.01"
                      disabled={!isEditable}
                      data-testid={`input-band-cost-${index}`}
                    />
                  </div>
                  {isEditable ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => removeBand(index)}
                      className="text-destructive"
                      data-testid={`button-remove-band-${index}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  ) : (
                    <div />
                  )}
                </div>
              ))}

              {bands.length > 0 && (
                <div className="mt-2 p-3 bg-muted/50 rounded-md">
                  <p className="text-sm text-muted-foreground">
                    {bands.length} tier{bands.length !== 1 ? 's' : ''} defined.
                    {bands.some(b => !b.max_value && b.max_value !== 0) && (
                      <span> Tiers without a max value will match any value above their minimum.</span>
                    )}
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {showPreview && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-lg">Organisation Preview</CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={previewSearch}
                  onChange={(e) => setPreviewSearch(e.target.value)}
                  placeholder="Search organisations..."
                  className="pl-9 w-60"
                  data-testid="input-preview-search"
                />
              </div>
              <Button size="sm" variant="outline" onClick={handleExportCsv} disabled={!previewData} data-testid="button-export-csv">
                <Download className="w-4 h-4 mr-1" />
                CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loadingPreview ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
              </div>
            ) : !previewData?.config ? (
              <div className="text-center py-8 text-muted-foreground" data-testid="text-save-first">
                <AlertCircle className="w-10 h-10 mx-auto mb-2 opacity-50" />
                <p>Save your tier configuration first to see a preview</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  <div className="p-3 bg-muted/50 rounded-md" data-testid="card-total-orgs">
                    <p className="text-xs text-muted-foreground">Total Organisations</p>
                    <p className="text-xl font-bold">{previewData.summary?.totalOrgs || 0}</p>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-md" data-testid="card-mapped-orgs">
                    <p className="text-xs text-muted-foreground">Mapped to Tiers</p>
                    <p className="text-xl font-bold">{previewData.summary?.mappedOrgs || 0}</p>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-md" data-testid="card-unmapped-orgs">
                    <p className="text-xs text-muted-foreground">Unmapped</p>
                    <p className="text-xl font-bold">{previewData.summary?.unmappedOrgs || 0}</p>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-md" data-testid="card-total-revenue">
                    <p className="text-xs text-muted-foreground">Total {periodLabel} Revenue</p>
                    <p className="text-xl font-bold">{currencySymbol}{(previewData.summary?.totalAnnualRevenue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                  </div>
                </div>

                <div className="border rounded-md overflow-auto">
                  <table className="w-full text-sm" data-testid="table-preview">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left p-3 font-medium">Organisation</th>
                        <th className="text-left p-3 font-medium">{selectedFieldLabel || 'Value'}</th>
                        <th className="text-left p-3 font-medium">Tier</th>
                        <th className="text-right p-3 font-medium">Cost ({currencySymbol})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPreviewOrgs.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="p-6 text-center text-muted-foreground">
                            No organisations found
                          </td>
                        </tr>
                      ) : (
                        filteredPreviewOrgs.map((org) => (
                          <tr key={org.id} className="border-b last:border-0" data-testid={`row-preview-${org.id}`}>
                            <td className="p-3">
                              <span className="font-medium">{org.name}</span>
                              {org.status && org.status !== 'active' && (
                                <Badge variant="outline" className="ml-2 text-xs">{org.status}</Badge>
                              )}
                            </td>
                            <td className="p-3">
                              {org.fieldValue !== null && org.fieldValue !== undefined
                                ? org.fieldValue.toLocaleString()
                                : <span className="text-muted-foreground">N/A</span>
                              }
                            </td>
                            <td className="p-3">
                              {org.tierLabel
                                ? <Badge variant="secondary">{org.tierLabel}</Badge>
                                : <Badge variant="outline" className="text-muted-foreground">Unmapped</Badge>
                              }
                            </td>
                            <td className="p-3 text-right">
                              {org.annualCost != null
                                ? `${currencySymbol}${org.annualCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                : <span className="text-muted-foreground">-</span>
                              }
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
