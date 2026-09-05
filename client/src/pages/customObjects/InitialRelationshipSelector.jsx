import React, { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { relationshipRequest, relationshipRoutes } from "./relationshipApi";
import {
  initialRelationshipAllowsMultiple,
  initialRelationshipLabel,
  isRequiredInitialRelationship,
  nextInitialRelationshipSelection,
  relationshipCandidateLabel,
} from "./relationshipHelpers";

const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 250;

export function InitialRelationshipSelector({
  selector,
  objectId,
  value,
  onChange,
  error,
  fixed,
}) {
  const { definition, side } = selector;
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const required = isRequiredInitialRelationship(definition, side);
  const label = initialRelationshipLabel(definition, side);
  const allowsMultiple = initialRelationshipAllowsMultiple(definition, side);
  const selected = Array.isArray(value) ? value : [];
  const selectedIds = useMemo(
    () => new Set(selected.map((entry) => String(entry.id))),
    [selected],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useQuery({
    queryKey: [
      "initial-relationship-candidates",
      objectId,
      definition.id,
      side,
      debouncedSearch,
      page,
    ],
    queryFn: () => relationshipRequest(relationshipRoutes.initialRelationshipCandidates(objectId, {
      definitionId: definition.id,
      side,
      page,
      pageSize: PAGE_SIZE,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
    })),
    enabled: !fixed,
  });
  const entries = query.data?.data || [];
  const total = Number(query.data?.total) || 0;
  const responsePageSize = Number(query.data?.pageSize) || PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / responsePageSize));

  useEffect(() => {
    if (!query.isFetching && page > pages) setPage(pages);
  }, [page, pages, query.isFetching]);

  if (fixed) {
    return (
      <div className="rounded-md border bg-slate-50 px-3 py-2">
        <p className="text-sm font-medium text-slate-800">{label}</p>
        <p className="mt-1 text-sm text-slate-600">
          This parent relationship is fixed and will be linked when the new record is created.
        </p>
      </div>
    );
  }

  const updateEntry = (entry, checked) => {
    onChange(nextInitialRelationshipSelection({
      selected,
      entry,
      checked,
      allowsMultiple,
    }));
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <Label>{label}{required && <span className="ml-1 text-rose-600">*</span>}</Label>
        <span className="text-xs text-slate-500">{required ? "Required" : "Optional"}</span>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {required
          ? `Choose ${allowsMultiple ? "at least one record" : "one record"} to create this required relationship.`
          : `Optionally select ${allowsMultiple ? "records" : "a record"} to link as initial ${label.toLowerCase()}. You can leave this empty.`}
      </p>

      {selected.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label={`Selected ${label}`}>
          {selected.map((entry) => (
            <span key={entry.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-800">
              {relationshipCandidateLabel(entry)}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-400"
                aria-label={`Remove ${relationshipCandidateLabel(entry)}`}
                onClick={() => updateEntry(entry, false)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative mt-3">
        <Label htmlFor={`relationship-search-${definition.id}-${side}`} className="sr-only">
          Search {label}
        </Label>
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <Input
          id={`relationship-search-${definition.id}-${side}`}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          className="pl-9"
          placeholder={`Search ${label.toLowerCase()}`}
          autoComplete="off"
        />
      </div>

      {query.isLoading || (query.isFetching && !query.data) ? (
        <p className="mt-2 text-sm text-slate-500">Loading eligible records…</p>
      ) : query.error ? (
        <p className="mt-2 text-sm text-rose-600">
          {query.error.message}{" "}
          <button className="underline" type="button" onClick={() => query.refetch()}>Retry</button>
        </p>
      ) : !entries.length ? (
        <p className="mt-2 text-sm text-slate-500">
          {debouncedSearch
            ? `No records match “${debouncedSearch}”.`
            : "No eligible records are available for this relationship."}
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2" aria-busy={query.isFetching}>
            {entries.map((entry) => {
              const id = String(entry.id);
              const checked = selectedIds.has(id);
              return (
                <label key={id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) => updateEntry(entry, Boolean(next))}
                  />
                  <span>{relationshipCandidateLabel(entry)}</span>
                </label>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
            <span>{total} eligible record{total === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Previous ${label} page`}
                disabled={page <= 1 || query.isFetching}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span>Page {page} of {pages}</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Next ${label} page`}
                disabled={page >= pages || query.isFetching}
                onClick={() => setPage((current) => Math.min(pages, current + 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
      {error && <p className="mt-1 text-sm text-rose-600">{error}</p>}
    </div>
  );
}