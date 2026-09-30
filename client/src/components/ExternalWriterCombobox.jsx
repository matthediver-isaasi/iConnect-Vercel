import { useState, useEffect, useRef, useCallback } from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

function getWriterLabel(writer) {
  return [writer.first_name, writer.last_name].filter(Boolean).join(" ") || writer.email || "Unknown";
}

export default function ExternalWriterCombobox({
  value,
  onValueChange,
  placeholder = "Search external writer...",
  unassignedLabel = "Unassigned",
  testId = "combobox-external-writer",
  initialWriter = null,
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [resolvedWriter, setResolvedWriter] = useState(initialWriter);
  const timerRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (initialWriter) {
      setResolvedWriter(initialWriter);
    }
  }, [initialWriter]);

  useEffect(() => {
    if (!value || value === "unassigned") {
      setResolvedWriter(null);
      return;
    }
    if (resolvedWriter && resolvedWriter.id === value) return;
    if (initialWriter && initialWriter.id === value) {
      setResolvedWriter(initialWriter);
      return;
    }
    setResolvedWriter(null);
    let cancelled = false;
    fetch(`/api/entities/ExternalWriter/${value}`, {
      credentials: "include",
    })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!cancelled && data) {
          setResolvedWriter(data);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [value]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const searchWriters = useCallback((query) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (abortRef.current) abortRef.current.abort();

    if (!query || query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    timerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const resp = await fetch(
          `/api/external-writers/search?q=${encodeURIComponent(query)}&limit=15`,
          { credentials: "include", signal: controller.signal }
        );
        if (resp.ok) {
          const data = await resp.json();
          setResults(data);
        }
      } catch (e) {
        if (e.name !== "AbortError") {
          console.error("External writer search error:", e);
        }
      } finally {
        setLoading(false);
      }
    }, 300);
  }, []);

  useEffect(() => {
    if (open) {
      searchWriters(searchQuery);
    }
  }, [searchQuery, open]);

  useEffect(() => {
    if (!open) {
      setSearchQuery("");
      setResults([]);
    }
  }, [open]);

  const handleSelect = (writerId) => {
    if (writerId === "unassigned") {
      setResolvedWriter(null);
      onValueChange("unassigned");
    } else {
      const writer = results.find((w) => w.id === writerId);
      if (writer) setResolvedWriter(writer);
      onValueChange(writerId);
    }
    setOpen(false);
  };

  const displayLabel = resolvedWriter
    ? getWriterLabel(resolvedWriter)
    : (value && value !== "unassigned" ? "Loading..." : unassignedLabel);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid={testId}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={placeholder}
            value={searchQuery}
            onValueChange={setSearchQuery}
            data-testid={`${testId}-search`}
          />
          <CommandList>
            {loading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && searchQuery.length >= 2 && results.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">No external writers found.</p>
            )}
            {!loading && searchQuery.length > 0 && searchQuery.length < 2 && (
              <p className="py-4 text-center text-sm text-muted-foreground">Type at least 2 characters to search.</p>
            )}
            <CommandGroup>
              <CommandItem
                value="unassigned"
                onSelect={() => handleSelect("unassigned")}
                data-testid={`${testId}-option-unassigned`}
              >
                <Check className={cn("mr-2 h-4 w-4", (!value || value === "unassigned") ? "opacity-100" : "opacity-0")} />
                {unassignedLabel}
              </CommandItem>
              {results.map((w) => {
                const label = getWriterLabel(w);
                return (
                  <CommandItem
                    key={w.id}
                    value={w.id}
                    onSelect={() => handleSelect(w.id)}
                    data-testid={`${testId}-option-${w.id}`}
                  >
                    <Check className={cn("mr-2 h-4 w-4", value === w.id ? "opacity-100" : "opacity-0")} />
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm truncate">{label}</span>
                      {w.organisation && <span className="text-xs text-muted-foreground truncate">{w.organisation}</span>}
                      {w.email && <span className="text-xs text-muted-foreground truncate">{w.email}</span>}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
