import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Settings, Save, Loader2, ShieldCheck, MessageSquare, Clock, BookOpen, PackagePlus, Landmark } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { base44 } from "@/api/base44Client";

const CURRENCY_SYMBOLS = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };

function fmtMoney(amount, currency) {
  if (amount == null) return '-';
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency || ''} `;
  return `${symbol}${parseFloat(amount).toFixed(2)}`;
}

function fmtDate(d) {
  if (!d) return '-';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return d;
  }
}

const DD_STATUS_VARIANTS = {
  active: 'default',
  pending: 'secondary',
  completed: 'secondary',
  paused: 'warning',
  payment_failed: 'destructive',
  cancelled: 'outline',
};

function DirectDebitPlansAdminCard() {
  const [plans, setPlans] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/membership/payment-plan?admin=1', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load Direct Debit plans');
        return res.json();
      })
      .then((json) => { if (!cancelled) setPlans(json.plans || []); })
      .catch((err) => { if (!cancelled) setLoadError(err.message); });
    return () => { cancelled = true; };
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Landmark className="w-4 h-4" />
          Monthly Payment Plans
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loadError ? (
          <p className="text-sm text-muted-foreground" data-testid="text-dd-plans-error">{loadError}</p>
        ) : plans === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="loading-dd-plans">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading plans...
          </div>
        ) : plans.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-dd-plans-empty">
            No members are paying by monthly plan yet.
          </p>
        ) : (
          <div className="space-y-2">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className="flex items-center justify-between gap-2 flex-wrap rounded-md border p-3"
                data-testid={`row-dd-plan-${plan.id}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {plan.member?.name || plan.member?.email || 'Unknown member'}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {plan.member?.email}{plan.membershipYear ? ` \u00b7 ${plan.membershipYear}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-sm" data-testid={`text-dd-plan-amount-${plan.id}`}>
                    {fmtMoney(plan.monthlyAmount, plan.currency)}/mo
                  </span>
                  <Badge variant="outline" data-testid={`badge-dd-plan-provider-${plan.id}`}>
                    {plan.provider === 'stripe' ? 'Card (Stripe)' : 'Direct Debit'}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Next: {fmtDate(plan.nextChargeDate)}
                  </span>
                  <Badge variant={DD_STATUS_VARIANTS[plan.status] || 'outline'} data-testid={`badge-dd-plan-status-${plan.id}`}>
                    {(plan.status || 'pending').replace(/_/g, ' ')}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function MembershipSettings() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  const [requireApproval, setRequireApproval] = useState(false);
  const [customMessage, setCustomMessage] = useState('');
  const [cronTime, setCronTime] = useState('06:00');
  const [nominalLedger, setNominalLedger] = useState('');
  const [addonsEnabled, setAddonsEnabled] = useState(false);
  const [addonTrainingFundEnabled, setAddonTrainingFundEnabled] = useState(false);
  const [addonFreeformEnabled, setAddonFreeformEnabled] = useState(false);
  const [trainingFundNominalCode, setTrainingFundNominalCode] = useState('');
  const [trainingFundVatRate, setTrainingFundVatRate] = useState(null); // { taxType, name, effectiveRate } | null
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const { data: systemSettings } = useQuery({
    queryKey: ['/api/entities/SystemSettings'],
    queryFn: () => base44.entities.SystemSettings.list(),
    enabled: accessChecked,
  });
  const vatRates = (() => {
    try {
      const row = (systemSettings || []).find(s => s.setting_key === 'xero_vat_rates');
      const parsed = row ? JSON.parse(row.setting_value) : null;
      return Array.isArray(parsed?.rates) ? parsed.rates : [];
    } catch {
      return [];
    }
  })();

  useEffect(() => {
    if (isAccessReady) {
      setAccessChecked(true);
    }
  }, [isAccessReady]);

  useEffect(() => {
    if (!accessChecked) return;
    fetch('/api/membership/membership-settings', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        setRequireApproval(data.require_approval || false);
        setCustomMessage(data.custom_message || '');
        setCronTime(data.cron_time || '06:00');
        setNominalLedger(data.nominal_ledger || '');
        setAddonsEnabled(data.addons_enabled || false);
        setAddonTrainingFundEnabled(data.addon_training_fund_enabled || false);
        setAddonFreeformEnabled(data.addon_freeform_enabled || false);
        setTrainingFundNominalCode(data.training_fund_nominal_code || '');
        setTrainingFundVatRate(data.training_fund_vat_rate || null);
      })
      .catch(() => {
        toast.error('Failed to load membership settings');
      })
      .finally(() => setLoading(false));
  }, [accessChecked]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/membership/membership-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          require_approval: requireApproval,
          custom_message: customMessage,
          cron_time: cronTime,
          nominal_ledger: nominalLedger,
          addons_enabled: addonsEnabled,
          addon_training_fund_enabled: addonTrainingFundEnabled,
          addon_freeform_enabled: addonFreeformEnabled,
          training_fund_nominal_code: trainingFundNominalCode,
          training_fund_vat_rate: trainingFundVatRate,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save');
      }
      toast.success('Membership settings saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!accessChecked || loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isFeatureExcluded('commerce.membership-settings')) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">You do not have access to this page.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="w-5 h-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold" data-testid="text-page-title">Membership Settings</h1>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" />
            Fee Approval
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Require approval before fees can be processed</Label>
              <p className="text-xs text-muted-foreground">
                When enabled, an admin must approve each organisation's fees before invoices can be generated,
                manual renewals can be triggered, or members can pay online.
              </p>
            </div>
            <Switch
              checked={requireApproval}
              onCheckedChange={setRequireApproval}
              data-testid="switch-require-approval"
            />
          </div>
          {requireApproval && (
            <Badge variant="outline" data-testid="badge-approval-active">
              Approval workflow active
            </Badge>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="w-4 h-4" />
            Member-Facing Message
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-sm font-medium">Custom message shown when fees are pending approval</Label>
            <p className="text-xs text-muted-foreground">
              This message is displayed on the member portal's Membership Fees page when the organisation's 
              fees have not yet been approved. Leave blank for the default message.
            </p>
          </div>
          <Textarea
            value={customMessage}
            onChange={(e) => setCustomMessage(e.target.value)}
            placeholder="e.g. Your membership fees are currently being reviewed. You will be notified once they are ready for payment."
            rows={3}
            data-testid="textarea-custom-message"
          />
          {!customMessage && (
            <p className="text-xs text-muted-foreground italic">
              Default: "Your membership fees are currently being reviewed. You will be notified when they are ready for payment."
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Invoice Processing Schedule
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-sm font-medium">Time of day to process membership invoices (UTC)</Label>
            <p className="text-xs text-muted-foreground">
              The automated membership renewal job checks every hour and processes your invoices at the
              selected time. Invoices for automatic and scheduled renewals will be generated during this window.
            </p>
          </div>
          <Select value={cronTime} onValueChange={setCronTime}>
            <SelectTrigger className="w-40" data-testid="select-cron-time">
              <SelectValue placeholder="Select time" />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 24 }, (_, i) => {
                const hour = String(i).padStart(2, '0');
                const value = `${hour}:00`;
                return (
                  <SelectItem key={value} value={value}>
                    {value} UTC
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BookOpen className="w-4 h-4" />
            Nominal Ledger Code
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-sm font-medium">Account code for membership invoices</Label>
            <p className="text-xs text-muted-foreground">
              The nominal ledger (account code) used when creating Xero invoices for membership fees.
              If left blank, the system-wide default account code will be used.
            </p>
          </div>
          <Input
            value={nominalLedger}
            onChange={(e) => setNominalLedger(e.target.value)}
            placeholder="e.g. 200"
            className="w-40"
            data-testid="input-nominal-ledger"
          />
          {!nominalLedger && (
            <p className="text-xs text-muted-foreground italic">
              Using system-wide default account code
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <PackagePlus className="w-4 h-4" />
            Invoice Add-ons
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Allow add-on line items on membership invoices</Label>
              <p className="text-xs text-muted-foreground">
                When enabled, admins can attach extra line items (such as a Training Fund top-up) to an
                organisation's membership invoice when approving its fees.
              </p>
            </div>
            <Switch
              checked={addonsEnabled}
              onCheckedChange={setAddonsEnabled}
              data-testid="switch-addons-enabled"
            />
          </div>

          {addonsEnabled && (
            <>
              <Separator />
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label className="text-sm font-medium">Training Fund top-ups</Label>
                  <p className="text-xs text-muted-foreground">
                    Add a Training Fund top-up line to the invoice. The fund is credited automatically
                    when the invoice is paid.
                  </p>
                </div>
                <Switch
                  checked={addonTrainingFundEnabled}
                  onCheckedChange={setAddonTrainingFundEnabled}
                  data-testid="switch-addon-training-fund"
                />
              </div>

              {addonTrainingFundEnabled && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pl-1">
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">Training Fund nominal code</Label>
                    <Input
                      value={trainingFundNominalCode}
                      onChange={(e) => setTrainingFundNominalCode(e.target.value)}
                      placeholder="e.g. 210"
                      className="w-40"
                      data-testid="input-training-fund-nominal"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">Training Fund VAT rate</Label>
                    <Select
                      value={trainingFundVatRate?.taxType || 'none'}
                      onValueChange={(value) => {
                        if (value === 'none') {
                          setTrainingFundVatRate(null);
                        } else {
                          const rate = vatRates.find(r => r.taxType === value);
                          setTrainingFundVatRate(rate ? { taxType: rate.taxType, name: rate.name, effectiveRate: rate.effectiveRate } : { taxType: value, name: null, effectiveRate: null });
                        }
                      }}
                    >
                      <SelectTrigger data-testid="select-training-fund-vat">
                        <SelectValue placeholder="Select VAT rate" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No VAT rate (provider default)</SelectItem>
                        {vatRates.map((rate) => (
                          <SelectItem key={rate.taxType} value={rate.taxType}>
                            {rate.name}{rate.effectiveRate != null ? ` (${rate.effectiveRate}%)` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              <Separator />
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label className="text-sm font-medium">Free-form add-ons</Label>
                  <p className="text-xs text-muted-foreground">
                    Add arbitrary line items with their own description, nominal code, VAT rate,
                    unit cost and quantity.
                  </p>
                </div>
                <Switch
                  checked={addonFreeformEnabled}
                  onCheckedChange={setAddonFreeformEnabled}
                  data-testid="switch-addon-freeform"
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <DirectDebitPlansAdminCard />

      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={saving}
          data-testid="button-save-settings"
        >
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Settings
        </Button>
      </div>
    </div>
  );
}
