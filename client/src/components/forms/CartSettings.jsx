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
    <label className="block text-sm">Bundle label<Input maxLength={120} value={field.bundle_label ?? ''} placeholder="Bundle" onChange={event => onChange({ bundle_label: event.target.value })} /></label>
    <label className="block text-sm">Bundle category label<Input maxLength={120} value={field.bundle_category_label ?? ''} placeholder="Bundle category" onChange={event => onChange({ bundle_category_label: event.target.value })} /></label>
    <label className="block text-sm">Products heading (optional)<Input maxLength={120} value={field.products_heading ?? ''} placeholder="Select other options" onChange={event => onChange({ products_heading: event.target.value })} /></label>
    <p className="text-xs text-slate-500">Shown above the products, after any bundles. Leave blank to show no heading.</p>
    <label className="block text-sm">Stock reservation time (minutes)<Input type="number" min="1" max="60" step="1"
      value={field.reservation_minutes ?? 5} onChange={event => {
        const minutes = Number(event.target.value);
        if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 60) onChange({ reservation_minutes: minutes });
      }} /></label>
    <p className="text-xs text-slate-500">Starts with the first item added. Adding items or refreshing does not restart it. Existing reservations keep their original deadline. Expiry clears the cart, not other form answers; payments in progress must be checked before stock is released.</p>
    <label className="flex items-center gap-2 text-sm"><Checkbox checked={field.show_reservation_countdown === true}
      onCheckedChange={checked => onChange({ show_reservation_countdown: checked === true })} />Show reservation countdown</label>
    {field.show_reservation_countdown === true && <label className="block text-sm">Countdown label<Input maxLength={120}
      value={field.reservation_label ?? ''} placeholder="Your items are reserved for {time}"
      onChange={event => onChange({ reservation_label: event.target.value })} />
      <span className="text-xs text-slate-500">Use {'{time}'} for the countdown. If omitted, the time appears after your label.</span></label>}
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={field.bundle_required === true} onCheckedChange={checked => onChange({ bundle_required: checked === true })} />
      Require at least one bundle
    </label>
    <p className="text-xs text-slate-500">When enabled, respondents must add a bundle to their cart. Products alone do not satisfy this requirement. Leave off to make bundles optional.</p>
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
              <div className="flex flex-wrap items-start justify-between gap-3">
                <label className="flex items-start gap-2 text-sm"><Checkbox checked={checked} disabled={!checked && (!ready || !available || count >= 100)} onCheckedChange={value => toggle(row.id, value === true)} /><span>{row.name}{!available && <span className="text-amber-700"> — unavailable / ineligible</span>}</span></label>
                {kind === 'bundle' && checked && <label className="text-xs">Maximum quantity
                  <Input aria-label={`Maximum quantity for ${row.name}`} className="mt-1 w-24" type="number" min="1" max="1000" step="1"
                    value={field.bundle_max_quantities?.[row.id] ?? ''} placeholder="1000"
                    onChange={event => {
                      const next = { ...field.bundle_max_quantities };
                      if (event.target.value === '') delete next[row.id];
                      else {
                        const quantity = Number(event.target.value);
                        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return;
                        next[row.id] = quantity;
                      }
                      onChange({ bundle_max_quantities: next });
                    }} />
                </label>}
              </div>
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
