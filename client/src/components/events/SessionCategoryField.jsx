import { Button } from "@/components/ui/button";
import SessionCategoryBadges from "@/components/events/SessionCategoryBadges";
import { resolveSessionCategories, sessionCategoryIds } from "@/lib/sessionCategories";

export default function SessionCategoryField({ value, onChange, query }) {
  const ids = sessionCategoryIds(value);
  const categories = query.data || [];
  const waiting = query.isPending || query.isLoading;
  return (
    <fieldset className="min-w-0 w-full space-y-2 rounded-md border border-slate-200 p-3">
      <legend className="px-1 text-sm font-medium text-slate-900">Session categories <span className="font-normal text-slate-500">(optional)</span></legend>
      <p className="text-xs text-slate-500">Choose any active categories, regardless of content type.</p>
      <SessionCategoryBadges
        categories={resolveSessionCategories(ids, categories, { settled: !waiting && !query.isError })}
        onRemove={id => onChange(ids.filter(current => current !== id))}
      />
      {waiting && <div role="status" className="space-y-2"><p className="text-sm text-slate-500">Loading categories…</p><div className="h-8 rounded bg-slate-100 animate-pulse" /></div>}
      {query.isError && (
        <div role="alert" className="space-y-2 text-sm text-red-700">
          <p>Categories could not be loaded. Saved assignments have been kept; you can still remove them.</p>
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Retry loading categories</Button>
        </div>
      )}
      {!waiting && !query.isError && (
        categories.length ? <div className="max-h-48 overflow-y-auto space-y-1" role="group" aria-label="Available session categories">
          {categories.map(category => (
            <label key={category.id} className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50 cursor-pointer">
              <input type="checkbox" className="mt-1 shrink-0 accent-indigo-600" checked={ids.includes(category.id)} onChange={event => onChange(event.target.checked ? [...ids, category.id] : ids.filter(id => id !== category.id))} />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{category.name}</span>
            </label>
          ))}
        </div> : <p className="rounded bg-slate-50 p-3 text-sm text-slate-500">No active categories are available. You can save this session without categories.</p>
      )}
    </fieldset>
  );
}
