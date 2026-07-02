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
import { Settings, Save, Loader2, ShieldCheck, MessageSquare, Clock, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function MembershipSettings() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  const [requireApproval, setRequireApproval] = useState(false);
  const [customMessage, setCustomMessage] = useState('');
  const [cronTime, setCronTime] = useState('06:00');
  const [nominalLedger, setNominalLedger] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
