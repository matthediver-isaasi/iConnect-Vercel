import { X } from "lucide-react";

// Public consumers pass ONLY the server's visible { id, name } labels.
export default function SessionCategoryBadges({ categories = [], onRemove, className = "" }) {
  const visible = categories.filter(category => category?.id && typeof category.name === "string" && category.name.trim());
  if (!visible.length) return null;
  return (
    <ul aria-label="Session categories" className={`flex flex-wrap gap-1.5 min-w-0 ${className}`}>
      {visible.map(category => (
        <li key={category.id} className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${category.unavailable ? "border-dashed border-slate-300 bg-slate-50 text-slate-600" : "border-indigo-200 bg-indigo-50 text-indigo-800"}`}>
          <span className="whitespace-normal break-words min-w-0 [overflow-wrap:anywhere]">{category.name}</span>
          {onRemove && (
            <button type="button" onClick={() => onRemove(category.id)} aria-label={`Remove ${category.name}`} className="shrink-0 rounded-full p-1 hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
