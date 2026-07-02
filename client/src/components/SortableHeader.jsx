import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";

export function getAriaSort(field, sortField, sortDir) {
  if (!field || sortField !== field) return "none";
  return sortDir === "asc" ? "ascending" : "descending";
}

export default function SortableHeader({
  field,
  sortField,
  sortDir,
  onSort,
  sortable = true,
  children,
  className = "",
}) {
  if (!sortable || !field) {
    return <span className={className}>{children}</span>;
  }

  const active = sortField === field;
  const Icon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={`inline-flex items-center gap-1 -mx-2 px-2 py-1 rounded-md hover-elevate active-elevate-2 font-inherit text-inherit ${className}`}
      data-testid={`sort-header-${field}`}
    >
      <span>{children}</span>
      <Icon
        className={`w-3 h-3 shrink-0 ${active ? "opacity-100" : "opacity-40"}`}
      />
    </button>
  );
}
