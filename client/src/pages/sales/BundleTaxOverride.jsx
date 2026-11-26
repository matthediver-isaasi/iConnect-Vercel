import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { providerTaxOptions, taxCodeKey, taxCodeLabel } from "@/lib/salesTaxCodes";

export default function BundleTaxOverride({ value, onChange, taxOptions }) {
  const items = providerTaxOptions(taxOptions.data);
  const key = taxCodeKey(value);
  const available = items.some(item => item.selectable && taxCodeKey(item) === key);
  return <div className="space-y-2 sm:col-span-2">
    <Label htmlFor="bundle-vat-override">Bundle VAT override</Label>
    <select id="bundle-vat-override" aria-label="Bundle VAT override"
      className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
      value={key} disabled={taxOptions.isPending}
      onChange={event => onChange(items.find(item => item.selectable && taxCodeKey(item) === event.target.value) || null)}>
      <option value="">No bundle VAT override</option>
      {key && !available && <option value={key} disabled>{taxCodeLabel(value)} — unavailable</option>}
      {items.filter(item => item.selectable).map(item =>
        <option key={taxCodeKey(item)} value={taxCodeKey(item)}>{taxCodeLabel(item)}</option>)}
    </select>
    <p className="text-xs text-slate-600">When selected, this VAT code applies to the entire bundle on new proposal and quote lines, ignoring all included products’ VAT rates. Saved quote tax is preserved on unrelated edits.</p>
    {taxOptions.isPending ? <p role="status" className="text-xs text-slate-600">Loading synced VAT codes…</p>
      : taxOptions.isError ? <p role="alert" className="text-xs text-red-600">{taxOptions.error?.message || "Could not load VAT codes."} Saved overrides are preserved unless cleared. <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => taxOptions.refetch()}>Retry</Button></p>
        : !items.some(item => item.selectable) && <p className="text-xs text-amber-700">Connect an accounting provider and sync its sales VAT codes in accounting settings to select an override.</p>}
    {key && !available && !taxOptions.isPending && <p role="status" className="text-xs text-amber-700">This saved VAT code is unavailable. Keep it unchanged, choose a replacement or clear the override.</p>}
  </div>;
}
