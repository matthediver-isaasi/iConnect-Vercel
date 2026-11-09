import { useCatalogue } from '@/pages/sales/useCatalogue';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

export default function BundleSelectionSettings({ field, onChange }) {
  const catalogue = useCatalogue('bundles');
  const rows = Array.isArray(catalogue.data) ? catalogue.data : catalogue.data?.items || [];
  const selected = field.allowed_bundle_ids || [];
  const selectable = rows.filter(row => row.isActive !== false && !row.archivedAt);
  const unselected = selectable.filter(row => !selected.includes(row.id));
  const remainingSlots = Math.max(0, 100 - selected.length);
  return <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
    <p className="text-sm font-medium">Allowed bundles</p>
    <p className="text-xs text-slate-500">Choose the packaged offers available on this form. Prices and availability are resolved by the server.</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm"
        disabled={catalogue.isPending || catalogue.isError || unselected.length === 0 || remainingSlots === 0}
        onClick={() => onChange([...new Set([...selected, ...unselected.slice(0, remainingSlots).map(row => row.id)])])}>
        Select all bundles
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={selected.length === 0} onClick={() => onChange([])}>
        Clear selection
      </Button>
      <span role="status" className="text-xs text-slate-500">{selected.length} of 100 selected</span>
    </div>
    {!catalogue.isPending && !catalogue.isError && unselected.length > remainingSlots && (
      <p className="text-xs text-amber-700">You can select up to 100 bundles. Select all adds bundles in the order shown until that limit is reached, keeping your existing selections.</p>
    )}
    {catalogue.isPending ? <div role="status" className="animate-pulse rounded bg-slate-200 p-3 text-sm">Loading catalogue…</div>
      : catalogue.isError ? <div role="alert"><p className="text-sm text-destructive">The bundle catalogue could not be loaded.</p><Button type="button" variant="outline" size="sm" onClick={() => catalogue.refetch()}>Retry catalogue</Button></div>
      : rows.length === 0 ? <p className="text-sm text-slate-500">No catalogue bundles yet. Add a bundle in Sales → Catalogue.</p>
      : rows.map(row => <label key={row.id} className="flex items-start gap-2 text-sm">
        <Checkbox checked={selected.includes(row.id)} disabled={!selected.includes(row.id) && (selected.length >= 100 || row.isActive === false || !!row.archivedAt)}
          onCheckedChange={checked => onChange(checked ? [...new Set([...selected, row.id])] : selected.filter(id => id !== row.id))} />
        <span>{row.name} <span className="text-xs text-slate-500">{row.currency}{row.sellingPriceMinor != null ? ` ${(row.sellingPriceMinor / 100).toFixed(2)}` : ''}</span>{row.isActive === false || row.archivedAt ? ' (archived)' : ''}</span>
      </label>)}
    {selected.filter(id => !rows.some(row => row.id === id)).map(id => <label key={id} className="flex gap-2 text-sm text-amber-700"><Checkbox checked onCheckedChange={() => onChange(selected.filter(value => value !== id))} />Unavailable saved bundle ({id})</label>)}
    <p className="text-xs text-slate-500">Choose up to 100 bundles. Use the same currency as the Payment field. One top-level Bundle selection per standard form; not available in surveys, repeatable rows, membership pricing or monthly instalments. Selections are immutable after submission; deleting a submission does not automatically restock.</p>
  </div>;
}
