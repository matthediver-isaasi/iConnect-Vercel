import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { opportunitySearchParams } from "./useQuoteOpportunity";

export default function QuoteOpportunitySelect({ value, name, onChange, request }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState(null);
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useQuery({
    queryKey: ["quote-opportunity-options", debounced, page],
    queryFn: ({ signal }) => request(`/api/opportunities?${opportunitySearchParams(debounced, page)}`, { signal }),
    enabled: open,
    retry: false,
  });
  const rows = query.data?.items || [];
  const waiting = search.trim() !== debounced || query.isFetching;
  const pages = Math.max(1, Math.ceil(Number(query.data?.total || 0) / 25));
  const selectedName = name || (String(selection?.id) === String(value) ? selection?.name : "");
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" role="combobox" aria-label="Opportunity" aria-expanded={open} className="w-full justify-between font-normal">
        <span className="truncate">{value ? selectedName || "Loading selected opportunity…" : "Choose an active opportunity"}</span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-slate-400" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[260px] max-w-[calc(100vw-2rem)] p-0">
      <Command shouldFilter={false} loop>
        <CommandInput aria-label="Search opportunities" placeholder="Search opportunities…" value={search} onValueChange={setSearch} />
        <CommandList aria-label="Active opportunities">
          {waiting ? <div role="status" className="space-y-2 p-3"><p className="text-xs text-slate-500">Loading opportunities…</p>{[0, 1, 2].map((i) => <div key={i} className="h-9 animate-pulse rounded bg-slate-100" />)}</div>
            : query.isError ? <div role="alert" className="p-3 text-sm text-rose-700"><p>{query.error.message || "Could not load opportunities."}</p><Button type="button" variant="link" className="h-auto px-0" onClick={() => query.refetch()}>Retry opportunities</Button></div>
              : !rows.length ? <div className="p-5 text-center text-sm text-slate-500">No active opportunities match this search. Try another name.</div>
                : <CommandGroup>{rows.map((item) => <CommandItem key={item.id} value={String(item.id)} onSelect={() => { setSelection(item); onChange(String(item.id)); setOpen(false); }}>
                  <Check className={`h-4 w-4 shrink-0 ${String(value) === String(item.id) ? "opacity-100" : "opacity-0"}`} />
                  <div className="min-w-0"><p className="truncate font-medium">{item.name}</p>{(item.organization?.name || item.stage?.name) && <p className="truncate text-xs text-slate-500">{[item.organization?.name, item.stage?.name].filter(Boolean).join(" · ")}</p>}</div>
                </CommandItem>)}</CommandGroup>}
        </CommandList>
        <div className="flex items-center justify-between gap-2 border-t p-2">
          <Button type="button" size="icon" variant="ghost" aria-label="Previous opportunities" disabled={waiting || page === 1} onClick={() => setPage((old) => old - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-xs text-slate-500" aria-live="polite">Page {page} of {pages}</span>
          <Button type="button" size="icon" variant="ghost" aria-label="Next opportunities" disabled={waiting || query.isError || page >= pages} onClick={() => setPage((old) => old + 1)}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </Command>
    </PopoverContent>
  </Popover>;
}
