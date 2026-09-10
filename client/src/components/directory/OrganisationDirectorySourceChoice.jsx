import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOrganisationDirectoryOptions } from "@/hooks/useOrganisationDirectory";

const PAGE_SIZE = 50;

function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default function OrganisationDirectorySourceChoice({
  field,
  selected,
  onChange,
}) {
  const values = Array.isArray(selected) ? selected : [];
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [page, setPage] = useState(1);

  useEffect(() => setPage(1), [debouncedSearch]);

  const query = useOrganisationDirectoryOptions({
    fieldKey: field.key,
    search: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
    selected: values,
  });
  const data = query.data;
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || PAGE_SIZE)));
  const unavailableValues = useMemo(() => (
    (data?.unavailableSelected || []).map(item => (
      item && typeof item === "object" ? item.value : item
    )).filter(value => values.includes(value))
  ), [data?.unavailableSelected, values]);
  const selectedOptions = (data?.selectedOptions || []).filter(option => values.includes(option.value));

  const choose = (value) => {
    if (field.multi_select) {
      onChange(values.includes(value)
        ? values.filter(selectedValue => selectedValue !== value)
        : [...values, value]);
    } else {
      onChange(values[0] === value ? [] : [value]);
    }
  };
  const removeUnavailable = (value) => {
    onChange(values.filter(selectedValue => selectedValue !== value));
  };

  return (
    <div className="w-full space-y-2" data-testid={`filter-${field.key}`}>
      <div className="flex gap-2">
        <Input
          type="search"
          aria-label={`Search ${field.label} options`}
          placeholder={`Search ${field.label}`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button type="button" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
          Refresh
        </Button>
      </div>

      {!query.isError && selectedOptions.length > 0 && (
        <div aria-label={`Selected ${field.label}`} className="flex flex-wrap gap-1">
          {selectedOptions.map(option => (
            <Button
              key={option.value}
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => choose(option.value)}
              aria-label={`Remove ${option.label}`}
            >
              {option.label} ×
            </Button>
          ))}
        </div>
      )}

      {!query.isError && unavailableValues.length > 0 && (
        <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
          <p>
            {unavailableValues.length} selected {unavailableValues.length === 1 ? "value is" : "values are"} no longer available.
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {unavailableValues.map((value, index) => (
              <Button
                key={`${String(value)}:${index}`}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => removeUnavailable(value)}
                aria-label={`Remove unavailable selection ${index + 1}`}
              >
                Remove unavailable selection {index + 1}
              </Button>
            ))}
          </div>
        </div>
      )}

      {query.isPending ? (
        <p role="status" className="text-sm text-slate-600">Loading options…</p>
      ) : query.isError ? (
        <div role="alert" className="space-y-1 text-sm text-red-700">
          <p>{query.error?.message || "Unable to load filter options"}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>Retry</Button>
        </div>
      ) : data.options.length === 0 ? (
        <p className="text-sm text-slate-600">No options found</p>
      ) : (
        <div
          role={field.multi_select ? "group" : "radiogroup"}
          aria-label={`${field.label} options`}
          className="max-h-52 overflow-y-auto rounded-md border border-input p-1"
        >
          {data.options.map(option => {
            const checked = values.includes(option.value);
            return (
              <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
                <input
                  type={field.multi_select ? "checkbox" : "radio"}
                  name={field.multi_select ? undefined : `directory-filter-${field.key}`}
                  checked={checked}
                  onChange={() => choose(option.value)}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
      )}

      {query.isFetching && !query.isPending && <p role="status" className="text-xs text-slate-500">Updating options…</p>}
      {data && !query.isError && (
        <div className="flex items-center justify-between gap-2 text-xs text-slate-600">
          <Button type="button" variant="outline" size="sm" disabled={page <= 1 || query.isFetching} onClick={() => setPage(value => value - 1)}>
            Previous
          </Button>
          <span>Page {data.page} of {totalPages}</span>
          <Button type="button" variant="outline" size="sm" disabled={page >= totalPages || query.isFetching} onClick={() => setPage(value => value + 1)}>
            Next
          </Button>
        </div>
      )}

      {values.length > 0 && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange([])}>
          Clear {field.label}
        </Button>
      )}
    </div>
  );
}