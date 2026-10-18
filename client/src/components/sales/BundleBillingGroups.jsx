import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSalesSettings } from "./useSalesSettings";
import { decimalToMinor, minorToDecimal } from "@/pages/sales/catalogueProductForm";
import { groupsForSaving, presetSnapshot, suggestedGroupAmounts } from "./billingGroups";

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50";
export function BillingPresetSelect({ rows = [], value, onChange, disabled, label }) {
  return <select aria-label={label} className={selectClass} disabled={disabled} value={value?.id || ""} onChange={event => onChange(rows.find(row => row.id === event.target.value))}>
    <option value="">Choose {label.toLowerCase()}</option>
    {value?.id && !rows.some(row => row.id === value.id && row.isActive) && <option value={value.id}>{value.name} · {value.days} days (saved, unavailable)</option>}
    {rows.filter(row => row.isActive).map(row => <option key={row.id} value={row.id}>{row.name} · {row.days} days{row.isDefault ? " (default)" : ""}</option>)}
  </select>;
}

export default function BundleBillingGroups({ form, update, products }) {
  const settings = useSalesSettings();
  const groups = form.billingGroups || [];
  const items = form.items || [];
  const [deleting, setDeleting] = useState(null);
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  const presetsReady = settings.ready && !settings.isError && !settings.error && !settings.isFetching;
  const presets = presetsReady ? settings.data?.billingPresets || {} : {};
  const set = next => update("billingGroups", next.map((group, position) => ({ ...group, position })));
  const patch = (id, values) => set(groups.map(group => group.id === id ? { ...group, ...values } : group));
  const add = () => {
    if (!presetsReady) return;
    const delay = presets.issueDelays?.find(row => row.isActive && row.isDefault);
    const terms = presets.paymentTerms?.find(row => row.isActive && row.isDefault);
    set([...groups, { id: crypto.randomUUID(), name: "", productIds: [], allocatedAmount: "0.00", timing: { kind: "acceptance", days: delay?.days || 0 }, paymentTerms: presetSnapshot(terms), ...(delay ? { issueDelayPreset: presetSnapshot(delay) } : {}) }]);
  };
  let validation = "";
  try { groupsForSaving(groups, items, decimalToMinor(form.sellingPriceMinor, { required: true })); } catch (error) { validation = error.message; }
  const suggest = () => {
    try {
      const amounts = suggestedGroupAmounts(groups, items, products, decimalToMinor(form.sellingPriceMinor, { required: true }));
      set(groups.map((group, index) => ({ ...group, allocatedAmount: amounts[index] })));
      setMessage("Suggested amounts applied. Review each allocation before saving.");
    } catch (error) { setMessage(error.message || "Enter a valid selling price and whole product quantities before suggesting allocations."); }
  };
  const remove = () => {
    try {
      const source = groups.find(group => group.id === deleting);
      if (!source) return;
      if ((source.productIds.length || decimalToMinor(source.allocatedAmount)) && !target) return;
      set(groups.filter(group => group.id !== deleting).map(group => group.id === target ? {
        ...group, productIds: [...group.productIds, ...source.productIds],
        allocatedAmount: minorToDecimal(BigInt(decimalToMinor(group.allocatedAmount) || 0) + BigInt(decimalToMinor(source.allocatedAmount) || 0)),
      } : group));
      setDeleting(null); setTarget(""); setMessage("");
    } catch (error) { setMessage(error.message); }
  };
  return <section className="space-y-4 rounded-xl border border-blue-100 bg-blue-50/30 p-4 sm:col-span-2">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Billing groups</h3><Button type="button" variant="outline" size="sm" disabled={!presetsReady} onClick={add}>Add billing group</Button></div>
    <p className="text-xs leading-relaxed text-slate-600">Allocate the independent selling price, excluding VAT. A deposit is part of that price, not an extra charge. Each product belongs to one group; products cannot be split across milestones.</p>
    {settings.isPending ? <div role="status" className="h-9 animate-pulse rounded bg-muted">Loading billing presets…</div> : settings.isError ? <p role="alert" className="text-sm text-destructive">Billing presets could not be loaded. Saved selections are preserved. <Button type="button" variant="link" onClick={() => settings.refetch()}>Retry</Button></p> : !presets.paymentTerms?.some(row => row.isActive) && <p className="text-xs text-amber-800">No active payment terms. Configure billing presets in Sales settings before creating groups.</p>}
    {!groups.length && <div className="rounded-lg border border-dashed p-4 text-sm text-slate-500">No billing groups. This bundle remains a single commitment unless you add groups.</div>}
    {groups.map((group, index) => <div key={group.id} className="space-y-3 rounded-lg border bg-background p-3">
      <div className="flex items-center gap-2"><span className="text-xs font-semibold text-slate-500">{index + 1}</span><Input aria-label={`Billing group ${index + 1} name`} maxLength={255} placeholder="e.g. Accommodation & travel" value={group.name} onChange={event => patch(group.id, { name: event.target.value })} />
        {[-1, 1].map(direction => <Button key={direction} type="button" variant="ghost" size="icon" aria-label={`Move group ${index + 1} ${direction < 0 ? "up" : "down"}`} disabled={index + direction < 0 || index + direction >= groups.length} onClick={() => { const next = [...groups]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; set(next); }}>{direction < 0 ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}</Button>)}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">Allocated amount ({form.currency}, excl. VAT)<Input inputMode="decimal" aria-label={`Group ${index + 1} allocated amount`} value={group.allocatedAmount ?? ""} onChange={event => patch(group.id, { allocatedAmount: event.target.value })} /></label>
        <label className="space-y-1 text-xs">Invoice timing<select className={selectClass} value={group.timing.kind} onChange={event => patch(group.id, { timing: event.target.value === "fixed" ? { kind: "fixed", date: "" } : { kind: "acceptance", days: 0 }, issueDelayPreset: undefined })}><option value="acceptance">After acceptance</option><option value="fixed">Fixed calendar date</option></select></label>
        {group.timing.kind === "fixed" ? <label className="space-y-1 text-xs">Planned issue date<Input aria-label={`Group ${index + 1} issue date`} type="date" value={group.timing.date} onChange={event => patch(group.id, { timing: { kind: "fixed", date: event.target.value } })} /></label> : <div className="space-y-2">
          <label className="block space-y-1 text-xs">Issue delay preset<BillingPresetSelect label={`Group ${index + 1} issue delay`} rows={presets.issueDelays} value={group.issueDelayPreset} disabled={!presetsReady} onChange={row => { if (presetsReady) patch(group.id, { issueDelayPreset: presetSnapshot(row), timing: { kind: "acceptance", days: row?.days ?? group.timing.days } }); }} /></label>
          <label className="block space-y-1 text-xs">Calendar days after acceptance<Input aria-label={`Group ${index + 1} issue delay days`} type="number" min="0" step="1" value={group.timing.days} onChange={event => patch(group.id, { timing: { kind: "acceptance", days: event.target.value }, issueDelayPreset: undefined })} /></label>
        </div>}
        <label className="space-y-1 text-xs">Payment terms (after invoice issue)<BillingPresetSelect label={`Group ${index + 1} payment terms`} rows={presets.paymentTerms} value={group.paymentTerms} disabled={!presetsReady} onChange={row => { if (presetsReady) patch(group.id, { paymentTerms: presetSnapshot(row) }); }} /></label>
      </div>
      <p className="text-xs text-slate-500">{group.productIds.length} product{group.productIds.length === 1 ? "" : "s"} assigned. {group.productIds.map(id => products.find(product => product.id === id)?.name || "Unavailable product").join(" · ")}</p>
      {group.productIds.some(id => !items.some(item => item.productId === id)) && <Button type="button" size="sm" variant="outline" onClick={() => patch(group.id, { productIds: group.productIds.filter(id => items.some(item => item.productId === id)) })}>Remove memberships for removed products</Button>}
      <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => { setDeleting(group.id); setTarget(""); }}>Remove group</Button>
      {deleting === group.id && <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs"><p>Remove this group? Its products and allocated amount must be explicitly moved to another group. No products will be removed from the bundle.</p>
        <select aria-label="Reassign removed group to" className={selectClass} value={target} onChange={event => setTarget(event.target.value)}><option value="">Choose reassignment group</option>{groups.filter(row => row.id !== group.id).map(row => <option key={row.id} value={row.id}>{row.name || "Unnamed group"}</option>)}</select>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setDeleting(null)}>Cancel removal</Button><Button type="button" size="sm" disabled={!target && (group.productIds.length > 0 || group.allocatedAmount !== "0.00")} onClick={remove}>Confirm removal{target ? " and transfer amount" : ""}</Button></div>
      </div>}
    </div>)}
    {groups.length > 0 && <>
      <div className="space-y-2 border-t pt-3"><h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Product membership</h4>
        {items.filter(item => item.productId).map((item, index) => <label key={`${item.productId}-${index}`} className="grid items-center gap-2 text-xs sm:grid-cols-2"><span>{products.find(product => product.id === item.productId)?.name || "Unavailable product"} · {item.quantity} units</span><select aria-label={`Billing group for product ${index + 1}`} className={selectClass} value={groups.find(group => group.productIds.includes(item.productId))?.id || ""} onChange={event => set(groups.map(group => ({ ...group, productIds: [...group.productIds.filter(id => id !== item.productId), ...(group.id === event.target.value ? [item.productId] : [])] })))}><option value="">Unassigned — choose group</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name || "Unnamed group"}</option>)}</select></label>)}
      </div>
      <p className="text-xs text-slate-600">Suggest amounts in proportion to assigned products’ standard prices × quantities. If all component values are zero, use equal shares; spare pennies follow group order. This is a suggestion, not a change to the bundle selling price.</p>
      <Button type="button" variant="outline" size="sm" onClick={suggest}>Apply suggested allocations</Button>
      {validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}
    </>}
    {message && <p role="status" className="text-xs text-slate-600">{message}</p>}
    <p className="text-xs text-slate-500">No invoice or email is created before acceptance. All days are calendar days. Existing issued or accepted financial history is never changed.</p>
  </section>;
}
