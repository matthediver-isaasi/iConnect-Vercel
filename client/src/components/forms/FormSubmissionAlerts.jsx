import React, { useEffect, useRef, useState } from "react";
import { Mail, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useFormAlerts } from "@/hooks/useFormAlerts";
import { alertRecipientsError, normalizeAlertRecipients } from "@/lib/formAlertRecipients";

export default function FormSubmissionAlerts({ formId, tenantId, canManage }) {
  return (
    <Card className="border-slate-200" data-testid="form-submission-alerts">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg flex items-center gap-2"><Mail className="w-5 h-5" /> Submission Email Alerts</CardTitle>
        <p className="text-sm text-slate-500">Notify administrators when a submission arrives. These private settings are separate from the Emails tab and are saved independently.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canManage ? (
          <p className="text-sm text-slate-500">FormBuilder access is required to manage submission alerts.</p>
        ) : !formId ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-800">Save this form first</p>
            <p className="mt-1 text-sm text-slate-500">Alerts are disabled for new forms and copies. Save the form before configuring recipients.</p>
          </div>
        ) : tenantId.status === "loading" ? (
          <p className="text-sm text-slate-500">Waiting for the active tenant. Alert settings are unavailable until your tenant is resolved.</p>
        ) : tenantId.status !== "ready" ? (
          <div role="alert" className="space-y-3">
            <p className="text-sm text-red-600">{tenantId.error}</p>
            <Button type="button" variant="outline" onClick={() => window.location.reload()}>Reload page</Button>
          </div>
        ) : (
          <AlertSettings key={`${tenantId.scopeKey}:${formId}`} formId={formId} tenantId={tenantId} />
        )}
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 space-y-2">
          <p className="flex items-center gap-2 font-medium text-slate-800"><ShieldCheck className="w-4 h-4" /> Link confidentiality and survey privacy</p>
          <p>Alert links expire after seven days. Anyone with a bearer link can open it without signing in; treat it as confidential and do not forward it. Administrators can revoke links from the submission details.</p>
          <p>Anonymous surveys are supported. Alert views exclude identity, contact details, linkage data, network information and attachments. Exact submission times are withheld and cohort thresholds remain protected.</p>
          <p>Free-text answers can still identify someone. Review recipients carefully.</p>
          <p>New forms and copies default to alerts disabled; existing submission emails are unchanged.</p>
        </div>
      </CardContent>
    </Card>
  );
}

function AlertSettings({ formId, tenantId }) {
  const { query, save } = useFormAlerts(formId, tenantId, true);
  const [enabled, setEnabled] = useState(false);
  const [recipientText, setRecipientText] = useState("");
  const [validationError, setValidationError] = useState(null);
  const initialized = useRef(false);
  useEffect(() => {
    if (query.data && !initialized.current) {
      initialized.current = true;
      setEnabled(query.data.enabled === true);
      setRecipientText((query.data.recipients || []).join("\n"));
    }
  }, [query.data]);
  if (query.isLoading) return <div className="space-y-3" aria-label="Loading alert settings"><Skeleton className="h-8 w-60" /><Skeleton className="h-28 w-full" /></div>;
  if (query.isError) return (
    <div className="space-y-3" role="alert">
      <p className="text-sm text-red-600">{query.error.message || "Unable to load alert settings."}</p>
      <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => query.refetch()}>Retry</Button>
    </div>
  );
  const recipients = normalizeAlertRecipients(recipientText);
  const available = query.data?.available === true;
  const dirty = enabled !== query.data?.enabled
    || JSON.stringify(recipients) !== JSON.stringify(query.data?.recipients || []);
  const handleSave = async () => {
    const error = alertRecipientsError(enabled, recipients);
    setValidationError(error);
    if (error) return;
    try {
      const settings = await save.mutateAsync({ enabled, recipients });
      setEnabled(settings.enabled === true);
      setRecipientText((settings.recipients || []).join("\n"));
      toast.success("Submission alert settings saved");
    } catch {
      // The inline error retains the draft and offers a retry via Save Alerts.
    }
  };
  return (
    <div className="space-y-4">
      {!available && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        Submission alerts are not available yet. Delivery and secure-response verification must be completed before enabling them.
      </p>}
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="submission-alert-enabled">Enable submission alerts</Label>
          <p className="text-sm text-slate-500 mt-1">Send alerts to the recipients below for future submissions.</p>
        </div>
        <Switch id="submission-alert-enabled" checked={enabled} disabled={save.isPending || !available} onCheckedChange={setEnabled} data-testid="switch-submission-alerts" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="submission-alert-recipients">Recipients</Label>
        <Textarea id="submission-alert-recipients" rows={4} value={recipientText} disabled={save.isPending}
          onChange={event => { setRecipientText(event.target.value); setValidationError(null); }}
          placeholder="admin@example.org" aria-describedby="submission-alert-recipient-help submission-alert-error"
          aria-invalid={!!validationError} data-testid="input-submission-alert-recipients" />
        <p id="submission-alert-recipient-help" className="text-xs text-slate-500">Up to 20 recipients. Use one address per line, or separate with commas. Addresses are trimmed, lowercased and deduplicated. At least one is required when enabled.</p>
      </div>
      <p className="text-sm text-slate-500">Link expiry: {query.data?.expires_in_days ?? 7} days (fixed).</p>
      <div id="submission-alert-error" aria-live="polite">
        {(validationError || save.isError) && <p role="alert" className="text-sm text-red-600">{validationError || save.error?.message || "Unable to save alert settings. Please try again."}</p>}
      </div>
      <Button type="button" onClick={handleSave} disabled={save.isPending || !query.data || !dirty} data-testid="button-save-submission-alerts">
        <Save className="w-4 h-4 mr-2" />{save.isPending ? "Saving…" : "Save Alerts"}
      </Button>
    </div>
  );
}
