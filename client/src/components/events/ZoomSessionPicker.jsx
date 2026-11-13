import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from "@/components/ui/command";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { upcomingZoomOptions } from "@/lib/zoomSessionOptions";

const localId = item => String(item.id);
export default function ZoomSessionPicker({
  items = [], value = '', onValueChange, loading = false, error = null, onRetry,
  kind = 'meeting', getValue = localId, formatDate, testId = 'zoom-session-picker',
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  const selected = items.find(item => getValue(item) === String(value));
  const options = upcomingZoomOptions(items, search, now);
  const dateLabel = item => {
    if (formatDate) return formatDate(item);
    if (!Number.isFinite(Date.parse(item.start_time))) return '';
    return new Date(item.start_time).toLocaleString(undefined, {
      dateStyle: 'medium', timeStyle: 'short', ...(item.timezone ? { timeZone: item.timezone } : {}),
    });
  };
  return (
    <div className="space-y-1">
      <Popover open={open} onOpenChange={next => { setOpen(next); setSearch(''); setNow(Date.now()); }}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" role="combobox" aria-expanded={open}
            aria-label={`Select Zoom ${kind}`} disabled={loading} className="w-full justify-between h-auto min-h-10 text-left font-normal"
            data-testid={testId}>
            <span className="truncate">{loading ? `Loading ${kind}s…` : selected?.topic ||
              (value ? `Previously linked ${kind}` : `Choose a scheduled ${kind}`)}</span>
            {loading ? <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin" /> : <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="p-0 w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)]">
          <Command shouldFilter={false}>
            <CommandInput placeholder={`Search ${kind}s by name…`} value={search} onValueChange={setSearch} />
            <CommandList>
              {error ? <div role="alert" className="p-3 text-sm text-destructive">
                Could not load {kind}s. {onRetry && <Button type="button" variant="link" onClick={onRetry}>Retry</Button>}
              </div> : <>
                <CommandEmpty>{search ? `No matching upcoming ${kind}s.` : `No upcoming ${kind}s available.`}</CommandEmpty>
                {options.map(item => <CommandItem key={getValue(item)} value={getValue(item)}
                  onSelect={() => {
                    if (!upcomingZoomOptions([item], '', Date.now()).length) { setNow(Date.now()); return; }
                    onValueChange(getValue(item)); setOpen(false);
                  }}>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium whitespace-normal">{item.topic || `Untitled ${kind}`}</div>
                    <div className="text-xs text-muted-foreground">{dateLabel(item)}</div>
                  </div>
                  {getValue(item) === String(value) && <Check className="ml-2 h-4 w-4 shrink-0" />}
                </CommandItem>)}
              </>}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && !upcomingZoomOptions(selected ? [selected] : [], '', now).length &&
        <p className="text-xs text-muted-foreground">The existing link is retained, but is not available for new selection.</p>}
    </div>
  );
}
