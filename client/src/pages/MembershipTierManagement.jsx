import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Layers, Plus, Trash2, Save, Building2, AlertCircle,
  Search, Download, History, CalendarDays, ChevronRight, ChevronDown, Eye, PlusCircle, Percent, Tag,
  CheckCircle2, Check, ChevronsUpDown
} from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { base44 } from "@/api/base44Client";
import { COUNTRIES } from "@/data/countries";

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

const WIZARD_STEPS = [
  { number: 1, label: 'Scope', subtitle: 'Define the structure name and scope' },
  { number: 2, label: 'Tier Model', subtitle: 'Choose tiered or flat pricing' },
  { number: 3, label: 'Period', subtitle: 'Set membership year settings' },
  { number: 4, label: 'Discounts', subtitle: 'Configure discounts and free periods' },
  { number: 5, label: 'Pricing', subtitle: 'Set currency and pricing details' },
  { number: 6, label: 'Summary', subtitle: 'Review and save your configuration' },
];

function StepIndicator({ currentStep, onStepClick }) {
  return (
    <div className="flex items-center justify-between w-full mb-8">
      {WIZARD_STEPS.map((step, idx) => {
        const isCompleted = currentStep > step.number;
        const isActive = currentStep === step.number;
        const isFuture = currentStep < step.number;
        return (
          <div key={step.number} className="flex items-center flex-1 last:flex-none">
            <button
              type="button"
              onClick={() => onStepClick(step.number)}
              className="flex flex-col items-center gap-1 cursor-pointer group"
              data-testid={`wizard-step-${step.number}`}
            >
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors
                  ${isActive ? 'bg-primary text-primary-foreground' : ''}
                  ${isCompleted ? 'bg-primary/10 text-primary' : ''}
                  ${isFuture ? 'bg-muted text-muted-foreground' : ''}
                `}
              >
                {isCompleted ? <CheckCircle2 className="w-5 h-5" /> : step.number}
              </div>
              <span className={`text-xs hidden sm:block ${isActive ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                {step.label}
              </span>
            </button>
            {idx < WIZARD_STEPS.length - 1 && (
              <div className={`flex-1 h-px mx-2 ${currentStep > step.number ? 'bg-primary/40' : 'bg-border'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function getCountryOptionsForField(field) {
  if (!field || (field.field_type !== 'country' && field.field_type !== 'countries')) return null;
  if (field.all_countries !== false) return COUNTRIES;
  let selected = field.selected_countries || [];
  if (typeof selected === 'string') {
    try { selected = JSON.parse(selected); } catch { selected = []; }
  }
  if (!Array.isArray(selected) || selected.length === 0) return COUNTRIES;
  return COUNTRIES.filter(c => selected.includes(c.code));
}

function parseMatchValueArray(matchValue) {
  if (!matchValue) return [];
  try {
    const parsed = JSON.parse(matchValue);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return matchValue ? [matchValue] : [];
}

function CountryMultiSelect({ value, onChange, countries, disabled, testId }) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => parseMatchValueArray(value), [value]);
  const selectedLabels = useMemo(() => {
    if (selected.length === 0) return '';
    return selected.map(code => {
      const c = COUNTRIES.find(ct => ct.code === code);
      return c ? c.name : code;
    }).join(', ');
  }, [selected]);

  const allSelected = selected.length === countries.length && countries.length > 0;

  const toggleCountry = useCallback((code) => {
    const next = selected.includes(code)
      ? selected.filter(c => c !== code)
      : [...selected, code];
    onChange(next.length > 0 ? JSON.stringify(next) : '');
  }, [selected, onChange]);

  const selectAll = useCallback(() => {
    onChange(JSON.stringify(countries.map(c => c.code)));
  }, [countries, onChange]);

  const deselectAll = useCallback(() => {
    onChange('');
  }, [onChange]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="justify-between font-normal w-full min-h-9"
          data-testid={testId}
        >
          <span className="truncate text-left flex-1">
            {selected.length > 0
              ? `${selected.length} ${selected.length === 1 ? 'country' : 'countries'} selected`
              : 'Select countries...'}
          </span>
          <ChevronsUpDown className="ml-1 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <div className="flex items-center justify-between gap-2 flex-wrap border-b px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {selected.length} / {countries.length} selected
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={allSelected ? deselectAll : selectAll}
            data-testid={`${testId}-toggle-all`}
          >
            {allSelected ? 'Deselect All' : 'Select All'}
          </Button>
        </div>
        <Command>
          <CommandInput placeholder="Search countries..." />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup className="max-h-[200px] overflow-auto">
              {countries.map(c => (
                <CommandItem
                  key={c.code}
                  value={c.name}
                  onSelect={() => toggleCountry(c.code)}
                >
                  <Check className={`mr-2 h-4 w-4 ${selected.includes(c.code) ? 'opacity-100' : 'opacity-0'}`} />
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {selected.length > 0 && (
          <div className="border-t p-2">
            <p className="text-xs text-muted-foreground">{selectedLabels}</p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
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
    free_period_enabled: false,
    free_period_amount: null,
    free_period_unit: null,
    rollover_enabled: false,
    structure_field_id: null,
    structure_match_value: null,
    structure_scope_type: 'organization',
    pricing_model: 'tiered',
    start_mode: 'fixed_date',
    flat_cost: null,
    flat_vat_rate: null,
    auto_approve_fees: false,
    online_card_payment: false,
  });

  const [selectedActiveConfigId, setSelectedActiveConfigId] = useState(null);
  const [bands, setBands] = useState([]);
  const [discounts, setDiscounts] = useState([]);
  const [vatOverrides, setVatOverrides] = useState([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewSearch, setPreviewSearch] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [viewingHistorical, setViewingHistorical] = useState(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [wizardStep, setWizardStep] = useState(6);

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

  const { data: discountFields = [] } = useQuery({
    queryKey: ['membership-discount-fields', config.structure_scope_type],
    queryFn: async () => {
      const scopeType = config.structure_scope_type || 'organization';
      const response = await fetch(`/api/membership/tiers?action=discount_fields&scope_type=${scopeType}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch discount fields');
      return response.json();
    },
  });

  const { data: structureFields = [] } = useQuery({
    queryKey: ['membership-structure-fields', config.structure_scope_type],
    queryFn: async () => {
      const scopeType = config.structure_scope_type || 'organization';
      const response = await fetch(`/api/membership/tiers?action=structure_fields&scope_type=${scopeType}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch structure fields');
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

  const { data: systemSettings = [] } = useQuery({
    queryKey: ['/api/entities/SystemSettings'],
    queryFn: () => base44.entities.SystemSettings.list()
  });

  const availableVatRates = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'xero_vat_rates');
    if (setting?.setting_value) {
      try {
        const parsed = JSON.parse(setting.setting_value);
        return parsed.rates || [];
      } catch (e) {
        return [];
      }
    }
    return [];
  }, [systemSettings]);

  const { data: previewData, isLoading: loadingPreview, refetch: refetchPreview } = useQuery({
    queryKey: ['membership-tier-preview', viewingHistorical || selectedActiveConfigId],
    queryFn: async () => {
      const previewConfigId = viewingHistorical || selectedActiveConfigId;
      const url = previewConfigId
        ? `/api/membership/tiers?action=preview&configId=${previewConfigId}`
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
        free_period_enabled: !!(c.free_period_amount),
        free_period_amount: c.free_period_amount ?? null,
        free_period_unit: c.free_period_unit ?? null,
        rollover_enabled: c.rollover_enabled ?? false,
        structure_field_id: c.structure_field_id || null,
        structure_match_value: c.structure_match_value || null,
        structure_scope_type: c.structure_scope_type || 'organization',
        pricing_model: c.pricing_model || 'tiered',
        start_mode: c.start_mode || 'fixed_date',
        flat_cost: c.flat_cost ?? null,
        flat_vat_rate: c.flat_vat_rate || null,
        invoice_description: c.invoice_description || null,
        auto_approve_fees: c.auto_approve_fees ?? false,
        online_card_payment: c.online_card_payment ?? false,
      });
      setBands((historicalData.bands || []).map(b => ({
        ...b,
        min_value: b.min_value?.toString() || '0',
        max_value: b.max_value?.toString() || '',
        annual_cost: b.annual_cost?.toString() || '0',
      })));
      setDiscounts((historicalData.discounts || []).map(d => ({
        ...d,
        discount_value: d.discount_value?.toString() || '0',
      })));
      setVatOverrides(historicalData.vatOverrides || []);
      setHasChanges(false);
      setIsCreatingNew(false);
      setWizardStep(6);
    }
  }, [viewingHistorical, historicalData]);

  const loadConfigIntoState = (c, configBands, configDiscounts, configVatOverrides) => {
    const inferredPricingModel = c.pricing_model || 'tiered';
    const inferredStartMode = c.start_mode || 'fixed_date';
    const inferredFlatCost = c.flat_cost ?? null;

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
      free_period_enabled: !!(c.free_period_amount),
      free_period_amount: c.free_period_amount ?? null,
      free_period_unit: c.free_period_unit ?? null,
      rollover_enabled: c.rollover_enabled ?? false,
      structure_field_id: c.structure_field_id || null,
      structure_match_value: c.structure_match_value || null,
      structure_scope_type: c.structure_scope_type || 'organization',
      pricing_model: inferredPricingModel,
      start_mode: inferredStartMode,
      flat_cost: inferredFlatCost,
      flat_vat_rate: c.flat_vat_rate || null,
      invoice_description: c.invoice_description || null,
      auto_approve_fees: c.auto_approve_fees ?? false,
      online_card_payment: c.online_card_payment ?? false,
    });
    if (configBands?.length > 0) {
      setBands(configBands.map(b => ({
        ...b,
        min_value: b.min_value?.toString() || '0',
        max_value: b.max_value?.toString() || '',
        annual_cost: b.annual_cost?.toString() || '0',
      })));
    } else {
      setBands([]);
    }
    setDiscounts((configDiscounts || []).map(d => ({
      ...d,
      discount_value: d.discount_value?.toString() || '0',
    })));
    setVatOverrides(configVatOverrides || []);
    setHasChanges(false);
  };

  useEffect(() => {
    if (tierData && !viewingHistorical && !isCreatingNew) {
      if (tierData.config) {
        loadConfigIntoState(tierData.config, tierData.bands, tierData.discounts, tierData.vatOverrides);
        setSelectedActiveConfigId(tierData.config.id);
        setWizardStep(6);
      } else {
        setBands([]);
        setDiscounts([]);
        setVatOverrides([]);
        setHasChanges(false);
      }
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

  const addDiscount = () => {
    setDiscounts(prev => [...prev, {
      id: `new-${Date.now()}`,
      field_id: '',
      field_label: '',
      match_value: '',
      discount_type: 'percentage',
      discount_value: '0',
      label: '',
    }]);
    setHasChanges(true);
  };

  const updateDiscount = (index, key, value) => {
    setDiscounts(prev => prev.map((d, i) => i === index ? { ...d, [key]: value } : d));
    setHasChanges(true);
  };

  const removeDiscount = (index) => {
    setDiscounts(prev => prev.filter((_, i) => i !== index));
    setHasChanges(true);
  };

  const addVatOverride = () => {
    setVatOverrides(prev => [...prev, {
      id: `new-${Date.now()}`,
      field_id: '',
      field_label: '',
      match_value: '',
      vat_rate: null,
      label: '',
    }]);
    setHasChanges(true);
  };

  const updateVatOverride = (index, key, value) => {
    setVatOverrides(prev => prev.map((d, i) => i === index ? { ...d, [key]: value } : d));
    setHasChanges(true);
  };

  const removeVatOverride = (index) => {
    setVatOverrides(prev => prev.filter((_, i) => i !== index));
    setHasChanges(true);
  };

  const validateStep = (step) => {
    switch (step) {
      case 1:
        if (!config.name?.trim()) { toast.error('Please enter a structure name'); return false; }
        if (!config.effective_from) { toast.error('Please set an effective from date'); return false; }
        if (config.structure_field_id && !config.structure_match_value?.trim()) {
          toast.error('Please enter a match value for the structure scope, or remove the scope');
          return false;
        }
        return true;
      case 2:
        if (config.pricing_model === 'tiered' && !config.field_source) {
          toast.error('Please select a field to base tiers on');
          return false;
        }
        return true;
      case 3:
        return true;
      case 4:
        return true;
      case 5:
        if (config.pricing_model === 'tiered') {
          if (bands.length === 0) { toast.error('Please add at least one tier band'); return false; }
          for (let i = 0; i < bands.length; i++) {
            const band = bands[i];
            if (!band.label?.trim()) { toast.error(`Tier ${i + 1} needs a label`); return false; }
            if (isNaN(parseFloat(band.min_value))) { toast.error(`Tier "${band.label}" has an invalid minimum value`); return false; }
            if (isNaN(parseFloat(band.annual_cost))) { toast.error(`Tier "${band.label}" has an invalid cost`); return false; }
          }
        } else {
          if (!config.flat_cost || parseFloat(config.flat_cost) <= 0) {
            toast.error('Please enter a flat membership cost greater than 0');
            return false;
          }
        }
        return true;
      case 6:
        return true;
      default:
        return true;
    }
  };

  const handleNext = () => {
    if (validateStep(wizardStep)) {
      setWizardStep(prev => Math.min(prev + 1, 6));
    }
  };

  const handleBack = () => {
    setWizardStep(prev => Math.max(prev - 1, 1));
  };

  const handleStepClick = (step) => {
    if (step < wizardStep) {
      setWizardStep(step);
    } else if (step === wizardStep + 1) {
      if (validateStep(wizardStep)) {
        setWizardStep(step);
      }
    } else if (step <= wizardStep) {
      setWizardStep(step);
    }
  };

  const handleSave = () => {
    const isFlat = config.pricing_model === 'flat';
    const isImmediate = config.start_mode === 'immediate';

    const { free_period_enabled: _fpe, ...configWithoutUiFlags } = config;
    const payload = {
      config: {
        ...configWithoutUiFlags,
        id: isCreatingNew ? undefined : config.id,
        prorata_enabled: isImmediate ? false : config.prorata_enabled,
        rollover_enabled: isImmediate ? false : config.rollover_enabled,
        pricing_model: config.pricing_model,
        start_mode: config.start_mode,
        flat_cost: isFlat ? parseFloat(config.flat_cost) || 0 : undefined,
        flat_vat_rate: isFlat ? (config.flat_vat_rate || null) : null,
      },
      bands: isFlat ? [] : bands.map(b => ({
        label: b.label,
        min_value: parseFloat(b.min_value) || 0,
        max_value: b.max_value !== '' && b.max_value !== null && b.max_value !== undefined ? parseFloat(b.max_value) : null,
        annual_cost: parseFloat(b.annual_cost) || 0,
        vat_rate: b.vat_rate || null,
      })),
      discounts: discounts.map(d => ({
        field_id: d.field_id,
        field_label: d.field_label || null,
        match_value: d.match_value || '',
        discount_type: d.discount_type || 'percentage',
        discount_value: parseFloat(d.discount_value) || 0,
        label: d.label || null,
      })),
      vatOverrides: vatOverrides.map(v => ({
        field_id: v.field_id,
        field_label: v.field_label || null,
        match_value: v.match_value || '',
        vat_rate: v.vat_rate || null,
        label: v.label || null,
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
      free_period_enabled: !!(currentConfig?.free_period_amount),
      free_period_amount: currentConfig?.free_period_amount ?? null,
      free_period_unit: currentConfig?.free_period_unit ?? null,
      rollover_enabled: currentConfig?.rollover_enabled ?? false,
      structure_field_id: null,
      structure_match_value: null,
      structure_scope_type: 'organization',
      pricing_model: currentConfig?.pricing_model || 'tiered',
      start_mode: currentConfig?.start_mode || 'fixed_date',
      flat_cost: currentConfig?.flat_cost ?? null,
      invoice_description: currentConfig?.invoice_description || null,
      auto_approve_fees: false,
      online_card_payment: false,
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
    if (tierData?.discounts?.length > 0) {
      setDiscounts(tierData.discounts.map(d => ({
        ...d,
        id: `new-${Date.now()}-${Math.random()}`,
        discount_value: d.discount_value?.toString() || '0',
      })));
    } else {
      setDiscounts([]);
    }
    if (tierData?.vatOverrides?.length > 0) {
      setVatOverrides(tierData.vatOverrides.map(v => ({
        ...v,
        id: `new-${Date.now()}-${Math.random()}`,
      })));
    } else {
      setVatOverrides([]);
    }
    setHasChanges(true);
    setShowHistory(false);
    setWizardStep(1);
  };

  const handleSwitchActiveConfig = async (configId) => {
    if (configId === selectedActiveConfigId) return;
    try {
      const response = await fetch(`/api/membership/tiers?configId=${configId}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch config');
      const data = await response.json();
      if (data.config) {
        loadConfigIntoState(data.config, data.bands, data.discounts, data.vatOverrides);
        setSelectedActiveConfigId(configId);
        setViewingHistorical(null);
        setIsCreatingNew(false);
        setWizardStep(6);
      }
    } catch (err) {
      toast.error('Failed to load this tier structure');
    }
  };

  const handleViewHistorical = (configId) => {
    setViewingHistorical(configId);
    setIsCreatingNew(false);
    setShowHistory(false);
    setShowPreview(false);
    setWizardStep(6);
  };

  const handleBackToCurrent = () => {
    setViewingHistorical(null);
    setIsCreatingNew(false);
    setHasChanges(false);
    setWizardStep(6);
  };

  const selectedFieldKey = config.field_source === 'core'
    ? `core:${config.field_name}`
    : config.field_id || '';

  const selectedFieldLabel = useMemo(() => {
    if (config.field_source === 'core') return config.field_name === 'member_count' ? 'Member Count' : config.field_name;
    const field = availableFields.find(f => f.id === config.field_id);
    return field?.label || field?.name || config.field_name || '';
  }, [config, availableFields]);

  const isMemberScoped = config.structure_scope_type === 'member';

  const filteredPreviewOrgs = useMemo(() => {
    const items = isMemberScoped
      ? [...(previewData?.members || []), ...(previewData?.unmapped || [])]
      : [...(previewData?.organizations || []), ...(previewData?.unmapped || [])];
    if (!previewSearch) return items;
    const q = previewSearch.toLowerCase();
    return items.filter(o => o.name.toLowerCase().includes(q));
  }, [previewData, previewSearch, isMemberScoped]);

  const selectedStructureField = useMemo(() => {
    if (!config.structure_field_id) return null;
    return structureFields.find(f => f.id === config.structure_field_id);
  }, [config.structure_field_id, structureFields]);

  const structureFieldOptions = useMemo(() => {
    if (!selectedStructureField) return [];
    if (selectedStructureField.options) {
      try {
        const opts = typeof selectedStructureField.options === 'string'
          ? JSON.parse(selectedStructureField.options)
          : selectedStructureField.options;
        if (Array.isArray(opts)) return opts.map(o => typeof o === 'string' ? o : o.label || o.value || '');
      } catch {}
    }
    return [];
  }, [selectedStructureField]);

  const handleExportCsv = () => {
    if (!previewData) return;
    const allItems = isMemberScoped
      ? [...(previewData.members || []), ...(previewData.unmapped || [])]
      : [...(previewData.organizations || []), ...(previewData.unmapped || [])];
    const symbol = getCurrencySymbol(config.currency);
    const periodLabel = config.billing_period === 'annual' ? 'Annual' : config.billing_period === 'monthly' ? 'Monthly' : 'Quarterly';
    const entityLabel = isMemberScoped ? 'Member' : 'Organisation';
    const headers = [entityLabel, 'Status', selectedFieldLabel || 'Field Value', 'Tier', `${periodLabel} Cost (${symbol})`];
    const rows = allItems.map(item => [
      item.name,
      item.status || '',
      item.fieldValue ?? 'N/A',
      item.tierLabel || 'Unmapped',
      item.annualCost != null ? item.annualCost.toFixed(2) : '',
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
  const activeConfigs = tierData?.activeConfigs || [];

  const renderStep1 = () => (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Structure Scope</CardTitle>
        <p className="text-sm text-muted-foreground">Define the name, start date, and scope of this tier structure</p>
      </CardHeader>
      <CardContent className="space-y-4">
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
          </div>
        </div>

        <div className="space-y-2">
          <Label>Description for invoice</Label>
          <Input
            value={config.invoice_description || ''}
            onChange={(e) => handleConfigChange('invoice_description', e.target.value)}
            placeholder='e.g. Annual membership fees for {year}'
            disabled={!isEditable}
            data-testid="input-invoice-description"
          />
          <p className="text-xs text-muted-foreground">
            Replaces the default "Membership subscription for ..." line on Xero invoices. Use {'{year}'} to insert the membership year. Leave blank to use the default.
          </p>
        </div>

        <div className="border-t pt-4 mt-2">
          <h3 className="text-sm font-medium mb-3">Structure Scope</h3>
          <p className="text-sm text-muted-foreground mb-3">
            Optionally scope this tier structure to {config.structure_scope_type === 'member' ? 'members' : 'organisations'} with a specific field value. This allows multiple active tier structures for different {config.structure_scope_type === 'member' ? 'member' : 'organisation'} types.
          </p>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Scope Type</Label>
              <Select
                value={config.structure_scope_type || 'organization'}
                onValueChange={(v) => {
                  handleConfigChange('structure_scope_type', v);
                  handleConfigChange('structure_field_id', null);
                  handleConfigChange('structure_match_value', null);
                }}
                disabled={!isEditable}
              >
                <SelectTrigger data-testid="select-structure-scope-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="organization">Organisation Field</SelectItem>
                  <SelectItem value="member">Member Field</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Scope by {config.structure_scope_type === 'member' ? 'Member' : 'Organisation'} Field</Label>
                <Select
                  value={config.structure_field_id || '__none'}
                  onValueChange={(v) => {
                    if (v === '__none') {
                      handleConfigChange('structure_field_id', null);
                      handleConfigChange('structure_match_value', null);
                    } else {
                      handleConfigChange('structure_field_id', v);
                      handleConfigChange('structure_match_value', null);
                    }
                  }}
                  disabled={!isEditable}
                >
                  <SelectTrigger data-testid="select-structure-field">
                    <SelectValue placeholder="No scope (applies to all)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No scope (applies to all)</SelectItem>
                    {structureFields.map(field => (
                      <SelectItem key={field.id || field.name} value={field.id} data-testid={`option-structure-field-${field.name}`}>
                        {field.label || field.name}
                        {field.is_core && <span className="text-muted-foreground ml-1">(Core)</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {config.structure_field_id && (
                <div className="space-y-2">
                  <Label>Match Value</Label>
                  {structureFieldOptions.length > 0 ? (
                    <Select
                      value={config.structure_match_value || ''}
                      onValueChange={(v) => handleConfigChange('structure_match_value', v)}
                      disabled={!isEditable}
                    >
                      <SelectTrigger data-testid="select-structure-match-value">
                        <SelectValue placeholder="Select a value" />
                      </SelectTrigger>
                      <SelectContent>
                        {structureFieldOptions.map(opt => (
                          <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={config.structure_match_value || ''}
                      onChange={(e) => handleConfigChange('structure_match_value', e.target.value)}
                      placeholder="Enter the value to match"
                      disabled={!isEditable}
                      data-testid="input-structure-match-value"
                    />
                  )}
                  <p className="text-sm text-muted-foreground">
                    Only {config.structure_scope_type === 'member' ? 'members' : 'organisations'} whose "{selectedStructureField?.label || selectedStructureField?.name || 'field'}" matches this value will use this tier structure
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {config.structure_scope_type === 'member' && (
          <div className="border-t pt-4 mt-2 space-y-4">
            <h3 className="text-sm font-medium mb-3">Member Payment Settings</h3>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label>Auto-approve fees</Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Automatically approve membership fees when a member matching this scope is created, allowing immediate payment without admin review.
                </p>
              </div>
              <Switch
                checked={config.auto_approve_fees}
                onCheckedChange={(v) => handleConfigChange('auto_approve_fees', v)}
                disabled={!isEditable}
                data-testid="switch-auto-approve-fees"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label>Online card payment</Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Members pay by card online. Hides renewal scheduling and purchase order controls in the admin view.
                </p>
              </div>
              <Switch
                checked={config.online_card_payment}
                onCheckedChange={(v) => handleConfigChange('online_card_payment', v)}
                disabled={!isEditable}
                data-testid="switch-online-card-payment"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );

  const renderStep2 = () => (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Tier Model</CardTitle>
        <p className="text-sm text-muted-foreground">Choose how membership pricing is determined</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card
            className={`cursor-pointer transition-colors ${config.pricing_model === 'tiered' ? 'border-primary ring-1 ring-primary' : ''}`}
            onClick={() => { handleConfigChange('pricing_model', 'tiered'); }}
            data-testid="radio-pricing-tiered"
          >
            <CardContent className="p-4 flex items-start gap-3">
              <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${config.pricing_model === 'tiered' ? 'border-primary' : 'border-muted-foreground'}`}>
                {config.pricing_model === 'tiered' && <div className="w-2 h-2 rounded-full bg-primary" />}
              </div>
              <div>
                <p className="font-medium">Tiered (based on field value)</p>
                <p className="text-sm text-muted-foreground mt-1">Pricing varies based on an organisation attribute such as member count or revenue</p>
              </div>
            </CardContent>
          </Card>
          <Card
            className={`cursor-pointer transition-colors ${config.pricing_model === 'flat' ? 'border-primary ring-1 ring-primary' : ''}`}
            onClick={() => { handleConfigChange('pricing_model', 'flat'); }}
            data-testid="radio-pricing-flat"
          >
            <CardContent className="p-4 flex items-start gap-3">
              <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${config.pricing_model === 'flat' ? 'border-primary' : 'border-muted-foreground'}`}>
                {config.pricing_model === 'flat' && <div className="w-2 h-2 rounded-full bg-primary" />}
              </div>
              <div>
                <p className="font-medium">Flat cost</p>
                <p className="text-sm text-muted-foreground mt-1">All {isMemberScoped ? 'members' : 'organisations'} pay the same fixed membership fee</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {config.pricing_model === 'tiered' && (
          <div className="space-y-2 mt-4">
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
                Tiers will be based on each {isMemberScoped ? "member's" : "organisation's"} "{selectedFieldLabel}" value
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );

  const renderStep3 = () => (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Membership Period</CardTitle>
        <p className="text-sm text-muted-foreground">Configure when memberships start and how the year is calculated</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card
            className={`cursor-pointer transition-colors ${config.start_mode === 'fixed_date' ? 'border-primary ring-1 ring-primary' : ''}`}
            onClick={() => { handleConfigChange('start_mode', 'fixed_date'); }}
            data-testid="radio-start-fixed"
          >
            <CardContent className="p-4 flex items-start gap-3">
              <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${config.start_mode === 'fixed_date' ? 'border-primary' : 'border-muted-foreground'}`}>
                {config.start_mode === 'fixed_date' && <div className="w-2 h-2 rounded-full bg-primary" />}
              </div>
              <div>
                <p className="font-medium">Fixed membership year</p>
                <p className="text-sm text-muted-foreground mt-1">All memberships follow a set annual cycle starting on a specific date</p>
              </div>
            </CardContent>
          </Card>
          <Card
            className={`cursor-pointer transition-colors ${config.start_mode === 'immediate' ? 'border-primary ring-1 ring-primary' : ''}`}
            onClick={() => {
              handleConfigChange('start_mode', 'immediate');
              handleConfigChange('prorata_enabled', false);
              handleConfigChange('rollover_enabled', false);
            }}
            data-testid="radio-start-immediate"
          >
            <CardContent className="p-4 flex items-start gap-3">
              <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${config.start_mode === 'immediate' ? 'border-primary' : 'border-muted-foreground'}`}>
                {config.start_mode === 'immediate' && <div className="w-2 h-2 rounded-full bg-primary" />}
              </div>
              <div>
                <p className="font-medium">Start immediately</p>
                <p className="text-sm text-muted-foreground mt-1">Membership starts immediately upon creation with no fixed cycle</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {config.start_mode === 'fixed_date' && (
          <div className="space-y-4 mt-4">
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
        )}

        {config.start_mode === 'immediate' && (
          <div className="mt-4 p-3 bg-muted/50 border rounded-md">
            <p className="text-sm text-muted-foreground">
              Membership starts immediately upon creation. Pro-rata and rollover discount are not applicable.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );

  const renderStep4 = () => (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Discounts</CardTitle>
        <p className="text-sm text-muted-foreground">Configure free periods, rollover discounts, and discount rules</p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label>New Member Incentive</Label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Offer new members a free period or a percentage discount when they join
              </p>
            </div>
            <Switch
              checked={config.free_period_enabled !== false && !!config.free_period_amount}
              onCheckedChange={(enabled) => {
                if (enabled) {
                  handleConfigChange('free_period_enabled', true);
                  if (!config.free_period_amount) {
                    handleConfigChange('free_period_amount', 3);
                    handleConfigChange('free_period_unit', 'months');
                  }
                } else {
                  handleConfigChange('free_period_enabled', false);
                  handleConfigChange('free_period_amount', null);
                  handleConfigChange('free_period_unit', null);
                  handleConfigChange('rollover_enabled', false);
                }
              }}
              disabled={!isEditable}
              data-testid="switch-free-period"
            />
          </div>
          {!!config.free_period_amount && (
            <div className="space-y-4 pl-4 border-l-2 border-muted">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Card
                  className={`cursor-pointer transition-colors ${config.free_period_unit !== 'percent' ? 'border-primary ring-1 ring-primary' : ''}`}
                  onClick={() => {
                    if (!isEditable) return;
                    if (config.free_period_unit === 'percent') {
                      handleConfigChange('free_period_unit', 'months');
                      handleConfigChange('free_period_amount', 3);
                    }
                  }}
                  data-testid="radio-incentive-free-period"
                >
                  <CardContent className="p-4 flex items-start gap-3">
                    <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${config.free_period_unit !== 'percent' ? 'border-primary' : 'border-muted-foreground'}`}>
                      {config.free_period_unit !== 'percent' && <div className="w-2 h-2 rounded-full bg-primary" />}
                    </div>
                    <div>
                      <p className="font-medium">Free Period</p>
                      <p className="text-sm text-muted-foreground mt-1">Give new members a set number of days, weeks, or months free</p>
                    </div>
                  </CardContent>
                </Card>
                <Card
                  className={`cursor-pointer transition-colors ${config.free_period_unit === 'percent' ? 'border-primary ring-1 ring-primary' : ''}`}
                  onClick={() => {
                    if (!isEditable) return;
                    if (config.free_period_unit !== 'percent') {
                      handleConfigChange('free_period_unit', 'percent');
                      handleConfigChange('free_period_amount', 30);
                    }
                  }}
                  data-testid="radio-incentive-percentage"
                >
                  <CardContent className="p-4 flex items-start gap-3">
                    <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${config.free_period_unit === 'percent' ? 'border-primary' : 'border-muted-foreground'}`}>
                      {config.free_period_unit === 'percent' && <div className="w-2 h-2 rounded-full bg-primary" />}
                    </div>
                    <div>
                      <p className="font-medium">Percentage Discount</p>
                      <p className="text-sm text-muted-foreground mt-1">Give new members a percentage off for a full year, pro-rated if they join mid-year</p>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {config.free_period_unit !== 'percent' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Duration</Label>
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        min="1"
                        value={config.free_period_amount ?? ''}
                        onChange={(e) => {
                          const val = e.target.value === '' ? 1 : Math.max(1, parseInt(e.target.value) || 1);
                          handleConfigChange('free_period_amount', val);
                        }}
                        className="w-24"
                        disabled={!isEditable}
                        data-testid="input-free-period-amount"
                      />
                      <Select
                        value={config.free_period_unit || 'months'}
                        onValueChange={(v) => handleConfigChange('free_period_unit', v)}
                        disabled={!isEditable}
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
                  </div>
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
                      disabled={!isEditable || config.start_mode === 'immediate'}
                      data-testid="switch-rollover"
                    />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Discount Percentage</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min="1"
                        max="100"
                        value={config.free_period_amount ?? ''}
                        onChange={(e) => {
                          const val = e.target.value === '' ? 1 : Math.min(100, Math.max(1, parseInt(e.target.value) || 1));
                          handleConfigChange('free_period_amount', val);
                        }}
                        className="w-24"
                        disabled={!isEditable}
                        data-testid="input-incentive-discount-percent"
                      />
                      <Percent className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      This discount covers a full year. If the member joins mid-year, only the proportional amount is applied in year 1 and the remainder rolls into year 2.
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Label>Rollover Discount</Label>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        If joining mid-year, carry the unused portion of the discount into the next year
                      </p>
                    </div>
                    <Switch
                      checked={config.rollover_enabled}
                      onCheckedChange={(v) => handleConfigChange('rollover_enabled', v)}
                      disabled={!isEditable || config.start_mode === 'immediate'}
                      data-testid="switch-rollover-percent"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t pt-4">
          <div className="flex items-center justify-between gap-2 mb-4">
            <div>
              <h3 className="text-sm font-medium">Discount Rules</h3>
              <p className="text-sm text-muted-foreground mt-0.5">Apply discounts based on {config.structure_scope_type === 'member' ? 'member' : 'organisation'} custom field values</p>
            </div>
            {isEditable && (
              <Button size="sm" onClick={addDiscount} data-testid="button-add-discount">
                <Plus className="w-4 h-4 mr-1" />
                Add Discount
              </Button>
            )}
          </div>

          {discounts.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground" data-testid="text-no-discounts">
              <Tag className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No discounts defined yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="hidden md:grid md:grid-cols-[1fr_1fr_1fr_120px_120px_40px] gap-2 text-sm font-medium text-muted-foreground px-2">
                <span>Label</span>
                <span>Custom Field</span>
                <span>Match Value</span>
                <span>Type</span>
                <span>Value</span>
                <span></span>
              </div>
              {discounts.map((discount, index) => {
                const selectedField = discountFields.find(f => f.id === discount.field_id);
                const fieldOptions = selectedField?.options
                  ? (Array.isArray(selectedField.options)
                    ? selectedField.options
                    : (() => { try { return JSON.parse(selectedField.options); } catch { return []; } })())
                  : [];
                const isDropdown = ['select', 'dropdown', 'radio', 'checkbox', 'picklist', 'multiselect'].includes(selectedField?.field_type?.toLowerCase()) && fieldOptions.length > 0;
                const countryOptions = getCountryOptionsForField(selectedField);
                const isCountryField = countryOptions !== null;
                return (
                  <div
                    key={discount.id || index}
                    className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_120px_120px_40px] gap-2 items-center p-2 rounded-md border"
                    data-testid={`row-discount-${index}`}
                  >
                    <Input
                      value={discount.label || ''}
                      onChange={(e) => updateDiscount(index, 'label', e.target.value)}
                      placeholder="e.g. London Discount"
                      disabled={!isEditable}
                      data-testid={`input-discount-label-${index}`}
                    />
                    <Select
                      value={discount.field_id || ''}
                      onValueChange={(value) => {
                        const field = discountFields.find(f => f.id === value);
                        updateDiscount(index, 'field_id', value);
                        updateDiscount(index, 'field_label', field?.label || field?.name || '');
                        updateDiscount(index, 'match_value', '');
                      }}
                      disabled={!isEditable}
                    >
                      <SelectTrigger data-testid={`select-discount-field-${index}`}>
                        <SelectValue placeholder="Select field" />
                      </SelectTrigger>
                      <SelectContent>
                        {discountFields.map(f => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.label || f.name}
                          </SelectItem>
                        ))}
                        {discountFields.length === 0 && (
                          <SelectItem value="__none" disabled>No custom fields found</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    {isCountryField ? (
                      <CountryMultiSelect
                        value={discount.match_value}
                        onChange={(val) => updateDiscount(index, 'match_value', val)}
                        countries={countryOptions}
                        disabled={!isEditable}
                        testId={`select-discount-match-countries-${index}`}
                      />
                    ) : isDropdown ? (
                      <Select
                        value={discount.match_value || ''}
                        onValueChange={(value) => updateDiscount(index, 'match_value', value)}
                        disabled={!isEditable}
                      >
                        <SelectTrigger data-testid={`select-discount-match-${index}`}>
                          <SelectValue placeholder="Select value" />
                        </SelectTrigger>
                        <SelectContent>
                          {fieldOptions.map((opt, oi) => {
                            const optValue = typeof opt === 'string' ? opt : (opt.value || opt.label || '');
                            const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || '');
                            return (
                              <SelectItem key={oi} value={optValue}>{optLabel}</SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={discount.match_value || ''}
                        onChange={(e) => updateDiscount(index, 'match_value', e.target.value)}
                        placeholder="Value to match"
                        disabled={!isEditable}
                        data-testid={`input-discount-match-${index}`}
                      />
                    )}
                    <Select
                      value={discount.discount_type || 'percentage'}
                      onValueChange={(value) => updateDiscount(index, 'discount_type', value)}
                      disabled={!isEditable}
                    >
                      <SelectTrigger data-testid={`select-discount-type-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">Percentage</SelectItem>
                        <SelectItem value="fixed">Fixed ({currencySymbol})</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                        {discount.discount_type === 'percentage' ? '%' : currencySymbol}
                      </span>
                      <Input
                        type="number"
                        value={discount.discount_value || ''}
                        onChange={(e) => updateDiscount(index, 'discount_value', e.target.value)}
                        placeholder="0"
                        className="pl-7"
                        step="0.01"
                        disabled={!isEditable}
                        data-testid={`input-discount-value-${index}`}
                      />
                    </div>
                    {isEditable ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeDiscount(index)}
                        className="text-destructive"
                        data-testid={`button-remove-discount-${index}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    ) : (
                      <div />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t pt-4 mt-4">
          <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
            <div>
              <h3 className="text-sm font-medium">VAT Override Rules</h3>
              <p className="text-sm text-muted-foreground mt-0.5">Override the default tier VAT rate based on {config.structure_scope_type === 'member' ? 'member' : 'organisation'} custom field values (e.g. country)</p>
            </div>
            {isEditable && (
              <Button size="sm" onClick={addVatOverride} data-testid="button-add-vat-override">
                <Plus className="w-4 h-4 mr-1" />
                Add VAT Override
              </Button>
            )}
          </div>

          {vatOverrides.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground" data-testid="text-no-vat-overrides">
              <Percent className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No VAT overrides defined yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="hidden md:grid md:grid-cols-[1fr_1fr_1fr_1fr_40px] gap-2 text-sm font-medium text-muted-foreground px-2">
                <span>Label</span>
                <span>Custom Field</span>
                <span>Match Value</span>
                <span>VAT Rate</span>
                <span></span>
              </div>
              {vatOverrides.map((override, index) => {
                const selectedField = discountFields.find(f => f.id === override.field_id);
                const fieldOptions = selectedField?.options
                  ? (Array.isArray(selectedField.options)
                    ? selectedField.options
                    : (() => { try { return JSON.parse(selectedField.options); } catch { return []; } })())
                  : [];
                const isDropdown = ['select', 'dropdown', 'radio', 'checkbox', 'picklist', 'multiselect'].includes(selectedField?.field_type?.toLowerCase()) && fieldOptions.length > 0;
                const countryOptions = getCountryOptionsForField(selectedField);
                const isCountryField = countryOptions !== null;
                const parsedVat = override.vat_rate ? (() => { try { return JSON.parse(override.vat_rate); } catch { return null; } })() : null;
                const vatSelectValue = parsedVat?.taxType || '';
                return (
                  <div
                    key={override.id || index}
                    className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_1fr_40px] gap-2 items-center p-2 rounded-md border"
                    data-testid={`row-vat-override-${index}`}
                  >
                    <Input
                      value={override.label || ''}
                      onChange={(e) => updateVatOverride(index, 'label', e.target.value)}
                      placeholder="e.g. Ireland VAT"
                      disabled={!isEditable}
                      data-testid={`input-vat-override-label-${index}`}
                    />
                    <Select
                      value={override.field_id || ''}
                      onValueChange={(value) => {
                        const field = discountFields.find(f => f.id === value);
                        updateVatOverride(index, 'field_id', value);
                        updateVatOverride(index, 'field_label', field?.label || field?.name || '');
                        updateVatOverride(index, 'match_value', '');
                      }}
                      disabled={!isEditable}
                    >
                      <SelectTrigger data-testid={`select-vat-override-field-${index}`}>
                        <SelectValue placeholder="Select field" />
                      </SelectTrigger>
                      <SelectContent>
                        {discountFields.map(f => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.label || f.name}
                          </SelectItem>
                        ))}
                        {discountFields.length === 0 && (
                          <SelectItem value="__none" disabled>No custom fields found</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    {isCountryField ? (
                      <CountryMultiSelect
                        value={override.match_value}
                        onChange={(val) => updateVatOverride(index, 'match_value', val)}
                        countries={countryOptions}
                        disabled={!isEditable}
                        testId={`select-vat-override-match-countries-${index}`}
                      />
                    ) : isDropdown ? (
                      <Select
                        value={override.match_value || ''}
                        onValueChange={(value) => updateVatOverride(index, 'match_value', value)}
                        disabled={!isEditable}
                      >
                        <SelectTrigger data-testid={`select-vat-override-match-${index}`}>
                          <SelectValue placeholder="Select value" />
                        </SelectTrigger>
                        <SelectContent>
                          {fieldOptions.map((opt, oi) => {
                            const optValue = typeof opt === 'string' ? opt : (opt.value || opt.label || '');
                            const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || '');
                            return (
                              <SelectItem key={oi} value={optValue}>{optLabel}</SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={override.match_value || ''}
                        onChange={(e) => updateVatOverride(index, 'match_value', e.target.value)}
                        placeholder="Value to match"
                        disabled={!isEditable}
                        data-testid={`input-vat-override-match-${index}`}
                      />
                    )}
                    <Select
                      value={vatSelectValue}
                      onValueChange={(value) => {
                        if (value === '__none') {
                          updateVatOverride(index, 'vat_rate', null);
                        } else {
                          const selectedRate = availableVatRates.find(r => r.taxType === value);
                          if (selectedRate) {
                            updateVatOverride(index, 'vat_rate', JSON.stringify({ taxType: selectedRate.taxType, name: selectedRate.name }));
                          }
                        }
                      }}
                      disabled={!isEditable}
                    >
                      <SelectTrigger data-testid={`select-vat-override-rate-${index}`}>
                        <SelectValue placeholder="Select VAT rate" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">No VAT</SelectItem>
                        {availableVatRates.map(rate => (
                          <SelectItem key={rate.taxType} value={rate.taxType}>
                            {rate.name} ({rate.effectiveRate}%)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {isEditable ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeVatOverride(index)}
                        className="text-destructive"
                        data-testid={`button-remove-vat-override-${index}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    ) : (
                      <div />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );

  const renderStep5 = () => (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Pricing</CardTitle>
        <p className="text-sm text-muted-foreground">
          {config.pricing_model === 'tiered' ? 'Set currency, billing period, and define tier pricing bands' : 'Set currency, billing period, and the flat membership cost'}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
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

        {config.pricing_model === 'flat' ? (
          <div className="space-y-2 mt-4">
            <Label>Flat Membership Cost</Label>
            <div className="relative max-w-xs">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{currencySymbol}</span>
              <Input
                type="number"
                value={config.flat_cost ?? ''}
                onChange={(e) => handleConfigChange('flat_cost', e.target.value === '' ? null : e.target.value)}
                placeholder="0.00"
                className="pl-7"
                step="0.01"
                disabled={!isEditable}
                data-testid="input-flat-cost"
              />
            </div>
            <p className="text-sm text-muted-foreground">The {periodLabel.toLowerCase()} fee charged to all {isMemberScoped ? 'members' : 'organisations'}</p>
            {availableVatRates.length > 0 && (
              <div className="space-y-1 mt-3">
                <Label>VAT Rate</Label>
                <div className="max-w-xs">
                  <Select
                    value={(() => {
                      if (!config.flat_vat_rate) return '__none';
                      try {
                        const parsed = JSON.parse(config.flat_vat_rate);
                        return parsed.taxType || '__none';
                      } catch {
                        return config.flat_vat_rate || '__none';
                      }
                    })()}
                    onValueChange={(value) => {
                      if (value === '__none') {
                        handleConfigChange('flat_vat_rate', null);
                      } else {
                        const selectedRate = availableVatRates.find(r => r.taxType === value);
                        if (selectedRate) {
                          handleConfigChange('flat_vat_rate', JSON.stringify({ taxType: selectedRate.taxType, name: selectedRate.name }));
                        }
                      }
                    }}
                    disabled={!isEditable}
                  >
                    <SelectTrigger data-testid="select-flat-vat-rate">
                      <SelectValue placeholder="No VAT" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">No VAT</SelectItem>
                      {availableVatRates.map(rate => (
                        <SelectItem key={rate.taxType} value={rate.taxType}>
                          {rate.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-sm text-muted-foreground">Select the VAT rate to apply to the flat membership cost</p>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h3 className="text-sm font-medium">Tier Bands</h3>
              {isEditable && (
                <Button size="sm" onClick={addBand} data-testid="button-add-band">
                  <Plus className="w-4 h-4 mr-1" />
                  Add Tier
                </Button>
              )}
            </div>
            {bands.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground" data-testid="text-no-bands">
                <Layers className="w-10 h-10 mx-auto mb-2 opacity-50" />
                <p>No tiers defined yet</p>
                <p className="text-sm mt-1">Add tier bands to define your membership pricing structure</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="hidden md:grid md:grid-cols-[1fr_100px_100px_130px_150px_40px] gap-2 text-sm font-medium text-muted-foreground px-2">
                  <span>Label</span>
                  <span>Min Value</span>
                  <span>Max Value</span>
                  <span>{periodLabel} Cost ({currencySymbol})</span>
                  <span>VAT Rate</span>
                  <span></span>
                </div>
                {bands.map((band, index) => {
                  const parsedVat = band.vat_rate ? (() => { try { return JSON.parse(band.vat_rate); } catch { return null; } })() : null;
                  const vatSelectValue = parsedVat?.taxType || '';
                  return (
                    <div
                      key={band.id || index}
                      className="grid grid-cols-1 md:grid-cols-[1fr_100px_100px_130px_150px_40px] gap-2 items-center p-2 rounded-md border"
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
                      <Select
                        value={vatSelectValue}
                        onValueChange={(value) => {
                          if (value === '__none') {
                            updateBand(index, 'vat_rate', null);
                          } else {
                            const selectedRate = availableVatRates.find(r => r.taxType === value);
                            if (selectedRate) {
                              updateBand(index, 'vat_rate', JSON.stringify({ taxType: selectedRate.taxType, name: selectedRate.name }));
                            }
                          }
                        }}
                        disabled={!isEditable}
                      >
                        <SelectTrigger data-testid={`select-band-vat-${index}`}>
                          <SelectValue placeholder="No VAT" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">No VAT</SelectItem>
                          {availableVatRates.map(rate => (
                            <SelectItem key={rate.taxType} value={rate.taxType}>
                              {rate.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                  );
                })}
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
          </div>
        )}
      </CardContent>
    </Card>
  );

  const renderSummarySection = (title, stepNumber, children) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {isEditable && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWizardStep(stepNumber)}
            className="text-xs text-muted-foreground"
          >
            Edit
          </Button>
        )}
      </div>
      <div className="text-sm space-y-1">{children}</div>
    </div>
  );

  const renderStep6 = () => (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg" data-testid="text-config-title">
          {isHistoricalView ? 'Historical Configuration' : 'Configuration Summary'}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {isHistoricalView ? 'Read-only view of this historical tier structure' : 'Review your membership tier configuration before saving'}
        </p>
      </CardHeader>
      <CardContent className="space-y-6 divide-y">
        {renderSummarySection('Structure Scope', 1, (
          <>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Name</span>
              <span className="font-medium">{config.name || 'Untitled'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Effective From</span>
              <span className="font-medium">{formatDate(config.effective_from) || 'Not set'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Scope Type</span>
              <span className="font-medium">{config.structure_scope_type === 'member' ? 'Member Field' : 'Organisation Field'}</span>
            </div>
            {config.structure_field_id && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Scope</span>
                <span className="font-medium">
                  {selectedStructureField?.label || selectedStructureField?.name || 'Field'} = {config.structure_match_value || '(not set)'}
                </span>
              </div>
            )}
            {!config.structure_field_id && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Scope</span>
                <span className="text-muted-foreground">Applies to all {config.structure_scope_type === 'member' ? 'members' : 'organisations'}</span>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Invoice Description</span>
              <span className={config.invoice_description ? 'font-medium' : 'text-muted-foreground'}>
                {config.invoice_description || 'Default (Membership subscription for {year})'}
              </span>
            </div>
            {config.structure_scope_type === 'member' && (
              <>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Auto-approve fees</span>
                  <span className="font-medium" data-testid="text-summary-auto-approve">{config.auto_approve_fees ? 'Enabled' : 'Disabled'}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Online card payment</span>
                  <span className="font-medium" data-testid="text-summary-online-card-payment">{config.online_card_payment ? 'Enabled' : 'Disabled'}</span>
                </div>
              </>
            )}
          </>
        ))}

        <div className="pt-4">
          {renderSummarySection('Tier Model', 2, (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Pricing Model</span>
              <span className="font-medium">
                {config.pricing_model === 'tiered'
                  ? `Tiered (based on ${selectedFieldLabel || 'field'})`
                  : 'Flat cost'}
              </span>
            </div>
          ))}
        </div>

        <div className="pt-4">
          {renderSummarySection('Period', 3, (
            <>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Start Mode</span>
                <span className="font-medium">
                  {config.start_mode === 'fixed_date' ? 'Fixed membership year' : 'Start immediately'}
                </span>
              </div>
              {config.start_mode === 'fixed_date' && (
                <>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Year Start</span>
                    <span className="font-medium">
                      {config.membership_start_day} {MONTHS.find(m => m.value === config.membership_start_month)?.label}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Pro-rata</span>
                    <span className="font-medium">{config.prorata_enabled ? 'Enabled' : 'Disabled'}</span>
                  </div>
                </>
              )}
            </>
          ))}
        </div>

        <div className="pt-4">
          {renderSummarySection('Discounts', 4, (
            <>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">New Member Incentive</span>
                <span className="font-medium">
                  {config.free_period_amount
                    ? config.free_period_unit === 'percent'
                      ? `${config.free_period_amount}% discount (pro-rated over year)`
                      : `${config.free_period_amount} ${config.free_period_unit || 'months'} free`
                    : 'None'}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Rollover Discount</span>
                <span className="font-medium">{config.rollover_enabled ? 'Enabled' : 'Disabled'}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Discount Rules</span>
                <span className="font-medium">{discounts.length} rule{discounts.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">VAT Override Rules</span>
                <span className="font-medium">{vatOverrides.length} rule{vatOverrides.length !== 1 ? 's' : ''}</span>
              </div>
            </>
          ))}
        </div>

        <div className="pt-4">
          {renderSummarySection('Pricing', 5, (
            <>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Currency</span>
                <span className="font-medium">{CURRENCIES.find(c => c.value === config.currency)?.label || config.currency}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Billing Period</span>
                <span className="font-medium">{periodLabel}</span>
              </div>
              {config.pricing_model === 'tiered' ? (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Tier Bands</span>
                  <span className="font-medium">{bands.length} band{bands.length !== 1 ? 's' : ''}</span>
                </div>
              ) : (
                <>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Flat Cost</span>
                    <span className="font-medium">{currencySymbol}{parseFloat(config.flat_cost || 0).toFixed(2)}</span>
                  </div>
                  {config.flat_vat_rate && (() => {
                    try {
                      const parsed = JSON.parse(config.flat_vat_rate);
                      return (
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">VAT Rate</span>
                          <span className="font-medium">{parsed.name || parsed.taxType}</span>
                        </div>
                      );
                    } catch {
                      return null;
                    }
                  })()}
                </>
              )}
            </>
          ))}
        </div>

        {isEditable && (
          <div className="pt-6">
            <Button
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="w-full"
              data-testid="button-wizard-save"
            >
              <Save className="w-4 h-4 mr-2" />
              {saveMutation.isPending ? 'Saving...' : isCreatingNew ? 'Create Structure' : 'Save Changes'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );

  const renderWizardContent = () => {
    switch (wizardStep) {
      case 1: return renderStep1();
      case 2: return renderStep2();
      case 3: return renderStep3();
      case 4: return renderStep4();
      case 5: return renderStep5();
      case 6: return renderStep6();
      default: return null;
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
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

      {isCreatingNew && (
        <div className="p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <p className="text-sm text-blue-700 dark:text-blue-300">
            Creating a new tier structure. If this has the same structure scope (field and match value) as an existing active structure,
            the existing one will be automatically closed when this new structure starts.
          </p>
        </div>
      )}

      {activeConfigs.length > 1 && !isCreatingNew && !viewingHistorical && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
            <CardTitle className="text-sm font-medium">Active Tier Structures ({activeConfigs.length})</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex flex-wrap gap-2">
              {activeConfigs.map((ac) => (
                <Button
                  key={ac.id}
                  variant={selectedActiveConfigId === ac.id ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleSwitchActiveConfig(ac.id)}
                  data-testid={`button-switch-config-${ac.id}`}
                >
                  {ac.name || 'Untitled'}
                  {ac.structure_match_value && (
                    <Badge variant="secondary" className="ml-1.5">{ac.structure_match_value}</Badge>
                  )}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
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
                        <p className="font-medium truncate">
                          {item.name || 'Tier Structure'}
                          {item.structure_match_value && (
                            <Badge variant="outline" className="ml-2">{item.structure_match_value}</Badge>
                          )}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {formatDate(item.effective_from) || 'No start date'}
                          {item.effective_to ? ` - ${formatDate(item.effective_to)}` : ' - Present'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {isCurrent && <Badge variant="secondary">Active</Badge>}
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

      <div>
        {(isEditable || isHistoricalView) && tierData?.config && (
          <>
            <StepIndicator currentStep={wizardStep} onStepClick={handleStepClick} />
            {renderWizardContent()}
            {wizardStep < 6 && isEditable && (
              <div className="flex items-center justify-between gap-2 mt-6">
                <Button
                  variant="outline"
                  onClick={handleBack}
                  disabled={wizardStep === 1}
                  data-testid="button-wizard-back"
                >
                  <ChevronRight className="w-4 h-4 mr-1 rotate-180" />
                  Back
                </Button>
                <Button
                  onClick={handleNext}
                  data-testid="button-wizard-next"
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            )}
            {wizardStep > 1 && wizardStep < 6 && !isEditable && (
              <div className="flex items-center justify-between gap-2 mt-6">
                <Button
                  variant="outline"
                  onClick={handleBack}
                  data-testid="button-wizard-back"
                >
                  <ChevronRight className="w-4 h-4 mr-1 rotate-180" />
                  Back
                </Button>
                <Button
                  onClick={() => setWizardStep(prev => Math.min(prev + 1, 6))}
                  data-testid="button-wizard-next"
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            )}
          </>
        )}

        {!tierData?.config && !isCreatingNew && !loadingConfig && (
          <Card>
            <CardContent className="text-center py-12">
              <Layers className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-50" />
              <p className="text-lg font-medium mb-1">No tier structure configured</p>
              <p className="text-sm text-muted-foreground mb-4">Create your first membership tier structure to get started</p>
              <Button onClick={handleCreateNew} data-testid="button-create-first">
                <PlusCircle className="w-4 h-4 mr-2" />
                Create First Structure
              </Button>
            </CardContent>
          </Card>
        )}

        {loadingConfig && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        )}
      </div>

      {showPreview && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-lg">{isMemberScoped ? 'Member' : 'Organisation'} Preview</CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={previewSearch}
                  onChange={(e) => setPreviewSearch(e.target.value)}
                  placeholder={isMemberScoped ? "Search members..." : "Search organisations..."}
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
                    <p className="text-xs text-muted-foreground">Total {isMemberScoped ? 'Members' : 'Organisations'}</p>
                    <p className="text-xl font-bold">{(isMemberScoped ? previewData.summary?.totalMembers : previewData.summary?.totalOrgs) || 0}</p>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-md" data-testid="card-mapped-orgs">
                    <p className="text-xs text-muted-foreground">Mapped to Tiers</p>
                    <p className="text-xl font-bold">{(isMemberScoped ? previewData.summary?.mappedMembers : previewData.summary?.mappedOrgs) || 0}</p>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-md" data-testid="card-unmapped-orgs">
                    <p className="text-xs text-muted-foreground">Unmapped</p>
                    <p className="text-xl font-bold">{(isMemberScoped ? previewData.summary?.unmappedMembers : previewData.summary?.unmappedOrgs) || 0}</p>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-md" data-testid="card-total-revenue">
                    <p className="text-xs text-muted-foreground">Total {periodLabel} Revenue</p>
                    <p className="text-xl font-bold">{currencySymbol}{(previewData.summary?.totalAnnualRevenue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                  </div>
                </div>

                <div className="border rounded-md overflow-auto">
                  {(() => {
                    const previewIsFlat = previewData?.config?.pricing_model === 'flat';
                    const colCount = previewIsFlat ? 3 : 4;
                    return (
                      <table className="w-full text-sm" data-testid="table-preview">
                        <thead>
                          <tr className="border-b bg-muted/50">
                            <th className="text-left p-3 font-medium">{isMemberScoped ? 'Member' : 'Organisation'}</th>
                            {!previewIsFlat && (
                              <th className="text-left p-3 font-medium">{selectedFieldLabel || 'Value'}</th>
                            )}
                            <th className="text-left p-3 font-medium">Tier</th>
                            <th className="text-right p-3 font-medium">Cost ({currencySymbol})</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredPreviewOrgs.length === 0 ? (
                            <tr>
                              <td colSpan={colCount} className="p-6 text-center text-muted-foreground">
                                {isMemberScoped ? 'No members found' : 'No organisations found'}
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
                                {!previewIsFlat && (
                                  <td className="p-3">
                                    {org.fieldValue !== null && org.fieldValue !== undefined
                                      ? org.fieldValue.toLocaleString()
                                      : <span className="text-muted-foreground">N/A</span>
                                    }
                                  </td>
                                )}
                                <td className="p-3">
                                  {org.tierLabel
                                    ? <Badge variant="secondary">{org.tierLabel}</Badge>
                                    : <Badge variant="outline" className="text-muted-foreground">Unmapped</Badge>
                                  }
                                </td>
                                <td className="p-3 text-right">
                                  {org.annualCost != null
                                    ? <span className="font-medium">{currencySymbol}{org.annualCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                    : <span className="text-muted-foreground">-</span>
                                  }
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    );
                  })()}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
