import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSalesSettings } from "./useSalesSettings";
import { BillingPresetSelect } from "./BundleBillingGroups";
import { Input } from "@/components/ui/input";
import { percentageInstalmentsForSaving, presetSnapshot } from "./billingGroups";

export default function QuoteBillingSettings({ form, setForm, readOnly }) {
  const query = useSalesSettings();
  const presetsReady = query.ready && !query.isError && !query.error && !query.isFetching;
  const terms = presetsReady ? query.data?.billingPresets?.paymentTerms || [] : [];
  const delays = presetsReady ? query.data?.billingPresets?.issueDelays || [] : [];
  const rows = form.percentageInstalments || [];
  const percentageMode = form.billingMode === "percentage";
  const newRow = (name, percentage) => ({ id: crypto.randomUUID(), name, percentage, issueDelayPreset: presetSnapshot(delays.find(row => row.isActive && row.isDefault)), paymentTerms: presetSnapshot(terms.find(row => row.isActive && row.isDefault)) });
  const patchRow = (id, values) => {
    if (!readOnly) setForm(old => ({ ...old, percentageInstalments: (old.percentageInstalments || []).map(row => row.id === id ? { ...row, ...values } : row) }));
  };
  let validation = "";
  if (percentageMode) { try { percentageInstalmentsForSaving(rows); } catch (error) { validation = error.message; } }
  const selected = terms.find(row => row.id === form.remainderPaymentTermsId)
    || (form.remainderPaymentTermsId ? { id: form.remainderPaymentTermsId, name: "Saved remainder terms", days: "saved" } : null);
  return <Card><CardHeader><CardTitle>Staged billing</CardTitle></CardHeader><CardContent className="space-y-3">
    <label className="flex items-start gap-3 text-sm font-medium"><input aria-label="Use scheduled billing" className="mt-1" type="checkbox" disabled={readOnly || !presetsReady} checked={Boolean(form.scheduledBilling)} onChange={event => {
      if (readOnly || !presetsReady) return;
      const checked = event.target.checked;
      const defaultTerms = terms.find(row => row.isActive && row.isDefault);
      setForm(old => ({ ...old, scheduledBilling: checked, ...(checked && !old.remainderPaymentTermsId && defaultTerms ? { remainderPaymentTermsId: defaultTerms.id } : {}) }));
    }} />Use scheduled billing for this version</label>
    <p className="text-xs text-slate-500">Opt in explicitly. Scheduled invoices are issued only after acceptance. Unscheduled versions keep manual whole-sale invoicing. Issued and accepted history is not changed.</p>
    {form.scheduledBilling && <div className="space-y-3 border-t pt-3">
      <label className="block text-sm font-medium">Billing method
        <select aria-label="Billing method" className="mt-1 h-9 w-full rounded-md border bg-background px-2" value={form.billingMode || "groups"} disabled={readOnly || !presetsReady} onChange={event => {
          if (readOnly || !presetsReady) return;
          const mode = event.target.value;
          const initial = mode === "percentage" && !rows.length ? [newRow("Deposit", "50"), newRow("Balance", "50")] : rows;
          setForm(old => ({ ...old, billingMode: mode, percentageInstalments: initial }));
        }}><option value="groups">Product and bundle groups</option><option value="percentage">Whole-proposal percentages</option></select>
      </label>
      {percentageMode && <>
        <p className="text-xs text-slate-500">Split the whole proposal across instalments, including all products, bundles and other lines. No product-group assignment is needed. Percentages must total exactly 100%.</p>
        {rows.map((row, index) => <fieldset key={row.id} className="space-y-3 rounded-md border p-3" disabled={readOnly}>
          <legend className="px-1 text-sm font-medium">Instalment {index + 1}</legend>
          <label className="block text-sm">Name<Input aria-label={`Instalment ${index + 1} name`} value={row.name} onChange={event => patchRow(row.id, { name: event.target.value })} /></label>
          <label className="block text-sm">Percentage (%)<Input aria-label={`Instalment ${index + 1} percentage`} inputMode="decimal" value={row.percentage ?? (row.percentageBps / 100).toFixed(2)} onChange={event => patchRow(row.id, { percentage: event.target.value })} /></label>
          <label className="block text-sm">Issue delay from acceptance<BillingPresetSelect label={`Instalment ${index + 1} issue delay`} rows={delays} value={row.issueDelayPreset} disabled={readOnly || !presetsReady} onChange={value => { if (presetsReady) patchRow(row.id, { issueDelayPreset: presetSnapshot(value) }); }} /></label>
          <label className="block text-sm">Payment terms from invoice issue<BillingPresetSelect label={`Instalment ${index + 1} payment terms`} rows={terms} value={row.paymentTerms} disabled={readOnly || !presetsReady} onChange={value => { if (presetsReady) patchRow(row.id, { paymentTerms: presetSnapshot(value) }); }} /></label>
          <Button type="button" variant="outline" disabled={readOnly} onClick={() => { if (!readOnly) setForm(old => ({ ...old, percentageInstalments: old.percentageInstalments.filter(value => value.id !== row.id) })); }}>Remove instalment {index + 1}</Button>
        </fieldset>)}
        <Button type="button" variant="outline" disabled={readOnly || !presetsReady} onClick={() => { if (!readOnly && presetsReady) { const row = newRow("", ""); setForm(old => ({ ...old, percentageInstalments: [...(old.percentageInstalments || []), row] })); } }}>Add instalment</Button>
        {validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}
        {!presetsReady && <p role="status" className="text-sm text-slate-500">Billing presets are unavailable or loading. Saved selections are preserved.</p>}
        {query.error && <Button type="button" variant="link" onClick={() => query.refetch()}>Retry billing presets</Button>}
      </>}
    </div>}
    {form.scheduledBilling && !percentageMode && <div className="space-y-2 border-t pt-3">
      <p className="text-xs text-slate-500">Bundle groups become separate invoices; standalone and legacy ungrouped lines form one remainder group.</p>
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
