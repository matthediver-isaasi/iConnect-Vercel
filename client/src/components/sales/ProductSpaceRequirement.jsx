import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useExhibition } from "./useExhibition";

export default function ProductSpaceRequirement({ value, onChange }) {
  const query = useExhibition({ resource: "requirements" });
  const rows = query.data?.items || [];
  return <div className="rounded-lg border border-blue-100 bg-blue-50/40 p-3 sm:col-span-2">
    <Label htmlFor="product-space-requirement">Exhibition space requirement</Label>
    <select id="product-space-requirement" className="mt-2 h-9 w-full rounded-md border border-input bg-white px-3 text-sm disabled:opacity-50" value={value || ""} disabled={query.isPending || query.isError} onChange={event => onChange(event.target.value || null)}>
      <option value="">No exhibition space required</option>
      {value && !rows.some(item => item.id === value) && <option value={value}>Saved requirement (unavailable)</option>}
      {rows.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
    <p className="mt-2 text-xs leading-relaxed text-slate-600">One space per unit, scoped to the proposal’s Event. Bundles can include this product at their existing fixed price. Manage requirements and event inventory in Catalogue → Exhibition spaces. Ticket event links below are independent and unchanged.</p>
    {query.isPending && <p role="status" className="mt-2 animate-pulse text-xs">Loading requirements…</p>}
    {query.isError && <p role="alert" className="mt-2 text-xs text-rose-700">{query.error.message} The saved requirement will be preserved. <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => query.refetch()}>Retry requirements</Button></p>}
  </div>;
}
