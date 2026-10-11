import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export default function QuoteEventSelect({ value, kind = "simple", disabled, onChange, request }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [excludePast, setExcludePast] = useState(true);
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState(null);
  useEffect(() => {
    const timer = setTimeout(() => { setTerm(search.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const base = "/api/sales/catalogue/event-options?quoteEvents=true&";
  const query = useQuery({
    queryKey: ["quote-event-options", term, excludePast, page],
    queryFn: ({ signal }) => request(`${base}${new URLSearchParams({ search: term, excludePast: String(excludePast), page: String(page) })}`, { signal }),
    enabled: open && !disabled, retry: false,
  });
  const selected = useQuery({
    queryKey: ["quote-selected-event", value, kind],
    queryFn: ({ signal }) => request(`${base}${new URLSearchParams({ selectedId: value, kind })}`, { signal }),
    enabled: Boolean(value), retry: false,
  });
  const current = selection?.id === value && selection?.kind === kind ? selection : selected.data?.items?.[0];
  const waiting = search.trim() !== term || query.isFetching;
  const choose = item => { setSelection(item); onChange(item); setOpen(false); };
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" disabled={disabled} variant="outline" role="combobox" aria-label="Event" aria-expanded={open} className="w-full justify-between font-normal"><span className="truncate">{value ? current?.name || (selected.isError ? "Event could not be loaded" : selected.isPending ? "Loading event…" : "Event unavailable") : "Choose an event (optional)"}</span><ChevronsUpDown className="ml-2 h-4 w-4 shrink-0" /></Button></PopoverTrigger>
    <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[280px] p-0">
      <label className="flex items-center gap-2 border-b p-3 text-sm"><input type="checkbox" checked={excludePast} onChange={e => { setExcludePast(e.target.checked); setPage(1); }} />Exclude past events</label>
      <Command shouldFilter={false} loop>
        <CommandInput aria-label="Search events" placeholder="Type an event name…" value={search} onValueChange={setSearch} />
        <CommandList aria-label="Events">
          <CommandGroup><CommandItem value="clear-event" onSelect={() => choose(null)}>No event</CommandItem></CommandGroup>
          {waiting ? <p role="status" className="p-3 text-sm">Loading events…</p>
            : query.isError ? <div role="alert" className="p-3 text-sm">{query.error.message}<Button onClick={() => query.refetch()} variant="link">Retry events</Button></div>
              : !query.data?.items?.length ? <p className="p-3 text-sm">No matching events.</p>
                : <CommandGroup>{query.data.items.map(item => <CommandItem key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`} onSelect={() => choose(item)}><div><p>{item.name}</p><p className="text-xs text-slate-500">{item.kind === "complex" ? "Enterprise event" : "Event"}{item.startDate ? ` · ${new Date(item.startDate).toLocaleDateString()}` : ""}</p></div></CommandItem>)}</CommandGroup>}
        </CommandList>
      </Command>
      <div className="flex items-center justify-between border-t p-2"><Button variant="ghost" size="sm" disabled={waiting || page === 1} onClick={() => setPage(page - 1)}>Previous events</Button><span className="text-xs">Page {page}</span><Button variant="ghost" size="sm" disabled={waiting || !query.data?.hasMore} onClick={() => setPage(page + 1)}>Next events</Button></div>
    </PopoverContent>
  </Popover>;
}
