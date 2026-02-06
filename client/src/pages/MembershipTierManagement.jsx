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
  DollarSign, ChevronDown, ChevronUp, Search, Download,
  GripVertical, ArrowUpDown
} from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

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

export default function MembershipTierManagement() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const queryClient = useQueryClient();

  const [config, setConfig] = useState({
    name: 'Default',
    field_source: '',
    field_id: null,
    field_name: null,
    currency: 'GBP',
    billing_period: 'annual',
    is_active: true,
  });

  const [bands, setBands] = useState([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewSearch, setPreviewSearch] = useState('');

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

  const { data: previewData, isLoading: loadingPreview, refetch: refetchPreview } = useQuery({
    queryKey: ['membership-tier-preview'],
    queryFn: async () => {
      const response = await fetch('/api/membership/tiers?action=preview', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch preview');
      return response.json();
    },
    enabled: showPreview,
    staleTime: 0,
  });

  useEffect(() => {
    if (tierData) {
      if (tierData.config) {
        setConfig({
          name: tierData.config.name || 'Default',
          field_source: tierData.config.field_source || '',
          field_id: tierData.config.field_id || null,
          field_name: tierData.config.field_name || null,
          currency: tierData.config.currency || 'GBP',
          billing_period: tierData.config.billing_period || 'annual',
          is_active: tierData.config.is_active !== false,
        });
      }
      if (tierData.bands?.length > 0) {
        setBands(tierData.bands.map(b => ({
          ...b,
          min_value: b.min_value?.toString() || '0',
          max_value: b.max_value?.toString() || '',
          annual_cost: b.annual_cost?.toString() || '0',
        })));
      }
      setHasChanges(false);
    }
  }, [tierData]);

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['membership-tiers'] });
      queryClient.invalidateQueries({ queryKey: ['membership-tier-preview'] });
      setHasChanges(false);
      toast.success('Membership tier structure saved successfully');
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
      config,
      bands: bands.map(b => ({
        label: b.label,
        min_value: parseFloat(b.min_value) || 0,
        max_value: b.max_value !== '' && b.max_value !== null && b.max_value !== undefined ? parseFloat(b.max_value) : null,
        annual_cost: parseFloat(b.annual_cost) || 0,
      })),
    };

    saveMutation.mutate(payload);
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
    const headers = ['Organisation', 'Status', selectedFieldLabel || 'Field Value', 'Tier', `${config.billing_period === 'annual' ? 'Annual' : config.billing_period === 'monthly' ? 'Monthly' : 'Quarterly'} Cost (${symbol})`];
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

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <Layers className="w-6 h-6" />
            Membership Tier Structure
          </h1>
          <p className="text-muted-foreground mt-1">
            Define pricing tiers based on organisation attributes
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saveMutation.isPending}
            data-testid="button-save-tiers"
          >
            <Save className="w-4 h-4 mr-2" />
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="tier-field" data-testid="label-field-selector">Based On Field</Label>
              <Select
                value={selectedFieldKey}
                onValueChange={handleFieldChange}
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
                <Label htmlFor="currency">Currency</Label>
                <Select
                  value={config.currency}
                  onValueChange={(v) => handleConfigChange('currency', v)}
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
                <Label htmlFor="billing-period">Billing Period</Label>
                <Select
                  value={config.billing_period}
                  onValueChange={(v) => handleConfigChange('billing_period', v)}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-lg">Tier Bands</CardTitle>
          <Button size="sm" onClick={addBand} data-testid="button-add-band">
            <Plus className="w-4 h-4 mr-1" />
            Add Tier
          </Button>
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
                <span>{config.billing_period === 'annual' ? 'Annual' : config.billing_period === 'monthly' ? 'Monthly' : 'Quarterly'} Cost ({currencySymbol})</span>
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
                    data-testid={`input-band-label-${index}`}
                  />
                  <Input
                    type="number"
                    value={band.min_value || ''}
                    onChange={(e) => updateBand(index, 'min_value', e.target.value)}
                    placeholder="0"
                    data-testid={`input-band-min-${index}`}
                  />
                  <Input
                    type="number"
                    value={band.max_value || ''}
                    onChange={(e) => updateBand(index, 'max_value', e.target.value)}
                    placeholder="No limit"
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
                      data-testid={`input-band-cost-${index}`}
                    />
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => removeBand(index)}
                    className="text-destructive"
                    data-testid={`button-remove-band-${index}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
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
                    <p className="text-xs text-muted-foreground">Total {config.billing_period === 'annual' ? 'Annual' : config.billing_period === 'monthly' ? 'Monthly' : 'Quarterly'} Revenue</p>
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
