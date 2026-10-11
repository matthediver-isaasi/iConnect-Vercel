import { useEffect, useState, useSyncExternalStore } from "react";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export const salespersonName = person => person?.name || [person?.first_name, person?.last_name].filter(Boolean).join(" ") || person?.email || "";

export async function loadQuoteSalespeople(request, signal, tenantId) {
  const items = [];
  let offset = 0;
  do {
    const page = await request(`/api/sales/quotes?action=salesperson-options&offset=${offset}`, { signal, ...(tenantId ? { headers: { "X-Tenant-Id": tenantId } } : {}) });
    items.push(...page.items);
    if (page.nextOffset == null) return items;
    if (page.nextOffset <= offset) throw new Error("Could not load all salespeople.");
    offset = page.nextOffset;
  } while (!signal.aborted);
  return [];
}

export default function QuoteSalespersonSelect(props) {
  const tenantId = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  return <SalespersonPicker key={tenantId || "portal"} {...props} tenantId={tenantId} />;
}

function SalespersonPicker({ value, snapshot, disabled, onChange, request, tenantId }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [state, setState] = useState({ loading: true, items: [] });
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState(null);
  // Local, abortable discovery intentionally avoids sharing personnel caches
  // between tenant/auth contexts. Refresh on every opening.
  useEffect(() => {
    if (!open || disabled) return;
    const controller = new AbortController();
    setState({ loading: true, items: [] });
    loadQuoteSalespeople(request, controller.signal, tenantId).then(
      items => { if (!controller.signal.aborted) setState({ loading: false, items }); },
      error => { if (!controller.signal.aborted) setState({ loading: false, items: [], error }); },
    );
    return () => controller.abort();
  }, [open, disabled, request, attempt, tenantId]);
  const current = snapshot?.id === value ? snapshot : selection?.id === value ? selection : null;
  const choose = person => { setSelection(person); onChange(person?.id || ""); setOpen(false); };
  const rows = state.items.filter(person => `${salespersonName(person)} ${person.email || ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <Popover open={open && !disabled} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" disabled={disabled} variant="outline" role="combobox" aria-label="Salesperson" aria-expanded={open && !disabled} className="w-full justify-between font-normal">
      <span className="truncate">{value ? salespersonName(current) || "Saved salesperson (name unavailable)" : "Choose a salesperson (optional)"}</span><ChevronsUpDown className="ml-2 h-4 w-4 shrink-0" />
    </Button></PopoverTrigger>
    <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[260px] p-0">
      <Command shouldFilter={false} loop>
        <CommandInput aria-label="Search salespeople" placeholder="Search by name or email…" value={search} onValueChange={setSearch} />
        <CommandList aria-label="Salespeople">
          <CommandGroup><CommandItem value="clear-salesperson" onSelect={() => choose(null)}>No salesperson</CommandItem></CommandGroup>
          {value && <p className="px-3 py-2 text-xs text-slate-500">Current: {salespersonName(current) || "Saved salesperson"}. Kept unless changed.</p>}
          {state.loading ? <p role="status" className="p-3 text-sm">Loading salespeople…</p>
            : state.error ? <div role="alert" className="p-3 text-sm"><p>Could not load salespeople.</p><Button type="button" variant="link" onClick={() => setAttempt(n => n + 1)}>Retry salespeople</Button></div>
              : !rows.length ? <p className="p-3 text-sm">{search.trim() ? "No matching salespeople." : "No eligible salespeople in your team."}</p>
                : <CommandGroup>{rows.map(person => <CommandItem key={person.id} value={person.id} onSelect={() => choose(person)}>
                  <div><p>{salespersonName(person) || "Unnamed team member"}{value === person.id ? " (selected)" : ""}</p><p className="text-xs text-slate-500">{person.email}</p></div>
                </CommandItem>)}</CommandGroup>}
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}
