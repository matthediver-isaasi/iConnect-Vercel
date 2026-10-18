import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSalesSettings } from "./useSalesSettings";
import { BillingPresetSelect } from "./BundleBillingGroups";

export default function QuoteBillingSettings({ form, setForm, readOnly }) {
  const query = useSalesSettings();
  const presetsReady = query.ready && !query.isError && !query.error && !query.isFetching;
  const terms = presetsReady ? query.data?.billingPresets?.paymentTerms || [] : [];
  const selected = terms.find(row => row.id === form.remainderPaymentTermsId)
    || (form.remainderPaymentTermsId ? { id: form.remainderPaymentTermsId, name: "Saved remainder terms", days: "saved" } : null);
  return <Card><CardHeader><CardTitle>Staged billing</CardTitle></CardHeader><CardContent className="space-y-3">
    <label className="flex items-start gap-3 text-sm font-medium"><input aria-label="Use scheduled billing" className="mt-1" type="checkbox" disabled={readOnly || !presetsReady} checked={Boolean(form.scheduledBilling)} onChange={event => {
      if (readOnly || !presetsReady) return;
      const checked = event.target.checked;
      const defaultTerms = terms.find(row => row.isActive && row.isDefault);
      setForm(old => ({ ...old, scheduledBilling: checked, ...(checked && !old.remainderPaymentTermsId && defaultTerms ? { remainderPaymentTermsId: defaultTerms.id } : {}) }));
    }} />Use scheduled billing for this version</label>
    <p className="text-xs text-slate-500">Opt in explicitly. Bundle groups become separate invoices after acceptance; standalone and legacy ungrouped lines form one remainder group. Unscheduled versions keep manual whole-sale invoicing. Issued and accepted history is not changed.</p>
    {form.scheduledBilling && <div className="space-y-2 border-t pt-3">
      <label className="block text-sm font-medium">Remainder payment terms (for standalone or ungrouped lines)</label>
      <BillingPresetSelect label="Remainder payment terms" rows={terms} value={selected} disabled={readOnly || !presetsReady} onChange={row => {
        if (!readOnly && presetsReady) setForm(old => ({ ...old, remainderPaymentTermsId: row?.id || "" }));
      }} />
      <p className="text-xs text-slate-500">The remainder is invoiced on acceptance. The active default is suggested when you first opt in; review this explicit payment-term selection before saving. Existing saved selections are never replaced.</p>
      {query.isPending && <div role="status" className="h-8 animate-pulse rounded bg-muted"><span className="sr-only">Loading remainder terms</span></div>}
      {query.error && <p role="alert" className="text-sm text-destructive">Payment terms could not be loaded. Saved selection is preserved. <Button type="button" variant="link" onClick={() => query.refetch()}>Retry payment terms</Button></p>}
      {query.ready && !terms.some(row => row.isActive) && <p className="text-sm text-amber-800">No active payment terms. Configure billing presets in Sales settings.</p>}
      {!form.remainderPaymentTermsId && <p className="text-sm text-slate-500">Choose terms if this version includes standalone or ungrouped lines. Recalculation checks whether a remainder is required.</p>}
    </div>}
    {!form.scheduledBilling && query.error && <p role="alert" className="text-sm text-destructive">Billing presets could not be loaded. Reload them before selecting scheduled billing. <Button type="button" variant="link" onClick={() => query.refetch()}>Retry payment terms</Button></p>}
  </CardContent></Card>;
}
