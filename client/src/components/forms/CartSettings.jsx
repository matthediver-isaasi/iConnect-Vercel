import { useCatalogue } from '@/pages/sales/useCatalogue';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { catalogueRows, eligibleCartProduct } from '@/lib/formCart';
import { SALES_TAX_TREATMENTS } from '../../../../shared/salesContracts.js';

export default function CartSettings({ field, onChange }) {
  const products = useCatalogue('products');
  const bundles = useCatalogue('bundles');
  const productRows = catalogueRows(products.data);
  const bundleRows = catalogueRows(bundles.data);
  const count = (field.allowed_product_ids || []).length + (field.allowed_bundle_ids || []).length;
  const sections = [
    { kind: 'product', label: 'Products', query: products, rows: productRows, eligible: eligibleCartProduct },
    { kind: 'bundle', label: 'Bundles', query: bundles, rows: bundleRows, eligible: row =>
      !products.isPending && !products.isError && Array.isArray(row.items) && row.items.length > 0 &&
      row.items.every(item => eligibleCartProduct(productRows.find(product => product.id === item.productId))) },
  ];
  return <div className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4">
    <div><p className="text-sm font-medium">Cart catalogue</p><p className="text-xs text-slate-500">Offer up to 100 products and bundles in the Payment currency. Prices, tax and stock are checked by the server. Event and space-dependent items are not supported.</p></div>
    <p role="status" className="text-xs text-slate-500">{count} of 100 items selected</p>
    <label className="block text-sm">Bundle display
      <select aria-label="Bundle display" className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
        value={field.bundle_display || 'cards'} onChange={event => onChange({ bundle_display: event.target.value })}>
        <option value="cards">Item cards</option><option value="dropdown">Dropdown</option>
      </select>
    </label>
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={field.show_bundle_category === true} onCheckedChange={checked => onChange({ show_bundle_category: checked === true })} />
      Enable bundle category filter
    </label>
    {sections.map(({ kind, label, query, rows, eligible }) => {
      const key = `allowed_${kind}_ids`;
      const selected = field[key] || [];
      const ready = query.data?.cartStockReady === true && (kind !== 'bundle' || products.data?.cartStockReady === true);
      const toggle = (id, checked) => {
        if (checked && (!ready || count >= 100)) return;
        onChange({ [key]: checked ? [...new Set([...selected, id])] : selected.filter(value => value !== id) });
      };
      return <section key={kind} className="space-y-2">
        <p className="text-sm font-medium">{label}</p>
        {!ready && <p role="status" className="text-xs text-amber-700">Cart stock is not ready for {label.toLowerCase()}. New selections are disabled until the required catalogue update is available. Saved choices are kept and can be removed.</p>}
        {query.isPending ? <div role="status" className="animate-pulse rounded bg-slate-200 p-3 text-sm">Loading {label.toLowerCase()}…</div>
          : query.isError ? <div role="alert" className="text-sm text-destructive">Catalogue could not be loaded. Saved selections are kept. <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()}>Retry {label.toLowerCase()}</Button></div>
          : rows.length === 0 ? <p className="text-xs text-slate-500">No {label.toLowerCase()} yet. Add them in Sales → Catalogue.</p>
          : rows.map(row => {
            const available = eligible(row) && row.isActive !== false && !row.archivedAt;
            const checked = selected.includes(row.id);
            const tax = field.bundle_tax?.[row.id];
            return <div key={row.id} className="space-y-2 rounded border bg-background p-3">
              <label className="flex items-start gap-2 text-sm"><Checkbox checked={checked} disabled={!checked && (!ready || !available || count >= 100)} onCheckedChange={value => toggle(row.id, value === true)} /><span>{row.name}{!available && <span className="text-amber-700"> — unavailable / ineligible</span>}</span></label>
              {kind === 'bundle' && checked && <div className="space-y-2 pl-6">
                <label className="block text-xs">Bundle tax treatment (required)
                  <select aria-label={`Tax treatment for ${row.name}`} className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm" value={tax?.treatment || ''} onChange={event => {
                    const treatment = event.target.value;
                    onChange({ bundle_tax: { ...field.bundle_tax, [row.id]: { treatment, rateBps: treatment === 'standard' ? (tax?.treatment === 'standard' ? tax.rateBps : null) : 0 } } });
                  }}>
                    <option value="">Choose tax treatment…</option>
                    {SALES_TAX_TREATMENTS.map(treatment => <option key={treatment} value={treatment}>{treatment.replaceAll('_', ' ')}</option>)}
                  </select>
                </label>
                {tax?.treatment === 'standard' && <label className="block text-xs">Tax rate (%) (required)<Input aria-label={`Tax rate for ${row.name}`} type="number" min="0" max="1000" step="0.01" value={Number.isInteger(tax.rateBps) ? tax.rateBps / 100 : ''} onChange={event => onChange({ bundle_tax: { ...field.bundle_tax, [row.id]: { ...tax, rateBps: event.target.value === '' ? null : Math.round(Number(event.target.value) * 100) } } })} /></label>}
                <p className="text-xs text-slate-500">Set tax explicitly for this bundle. Component tax rates are not used.</p>
              </div>}
            </div>;
          })}
        {selected.filter(id => !rows.some(row => row.id === id)).map(id => <label key={id} className="flex gap-2 text-sm text-amber-700"><Checkbox checked onCheckedChange={() => toggle(id, false)} />Unavailable saved {kind} ({id})</label>)}
      </section>;
    })}
    <p className="text-xs text-slate-500">One top-level Cart on a standard form, connected to exactly one one-off Payment. No legacy Bundle selection or membership fees. Checkout reserves stock; deleting a submission does not restore it.</p>
  </div>;
}
