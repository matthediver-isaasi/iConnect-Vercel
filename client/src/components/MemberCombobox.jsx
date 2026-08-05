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

function getMemberLabel(member) {
  return [member.first_name, member.last_name].filter(Boolean).join(" ") || member.email || "Unknown";
}

export default function MemberCombobox({
  value,
  onValueChange,
  placeholder = "Search member...",
  unassignedLabel = "Unassigned",
  testId = "combobox-member",
  initialMember = null,
  // Optional pass-through org filter for /api/members/search:
  // a specific org UUID, 'none'/'__no_org__'/'null', or '__primary__'
  // (resolved server-side to the tenant's primary organisation).
  organizationId = null,
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [resolvedMember, setResolvedMember] = useState(initialMember);
  const timerRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (initialMember) {
      setResolvedMember(initialMember);
    }
  }, [initialMember]);

  useEffect(() => {
    if (!value || value === "unassigned") {
      setResolvedMember(null);
      return;
    }
    if (resolvedMember && resolvedMember.id === value) return;
    if (initialMember && initialMember.id === value) {
      setResolvedMember(initialMember);
      return;
    }
    setResolvedMember(null);
    let cancelled = false;
    fetch(`/api/members/by-ids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ids: [value] }),
    })
      .then((r) => r.ok ? r.json() : [])
      .then((data) => {
        if (!cancelled && data.length > 0) {
          setResolvedMember(data[0]);
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

  const searchMembers = useCallback((query) => {
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
        const orgParam = organizationId
          ? `&organization_id=${encodeURIComponent(organizationId)}`
          : "";
        const resp = await fetch(
          `/api/members/search?q=${encodeURIComponent(query)}&limit=15${orgParam}`,
          { credentials: "include", signal: controller.signal }
        );
        if (resp.ok) {
          const data = await resp.json();
          setResults(data);
        }
      } catch (e) {
        if (e.name !== "AbortError") {
          console.error("Member search error:", e);
        }
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [organizationId]);

  useEffect(() => {
    if (open) {
      searchMembers(searchQuery);
    }
  }, [searchQuery, open]);

  useEffect(() => {
    if (!open) {
      setSearchQuery("");
      setResults([]);
    }
  }, [open]);

  const handleSelect = (memberId) => {
    if (memberId === "unassigned") {
      setResolvedMember(null);
      onValueChange("unassigned");
    } else {
      const member = results.find((m) => m.id === memberId);
      if (member) setResolvedMember(member);
      onValueChange(memberId);
    }
    setOpen(false);
  };

  const displayLabel = resolvedMember
    ? getMemberLabel(resolvedMember)
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
              <p className="py-4 text-center text-sm text-muted-foreground">No members found.</p>
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
              {results.map((m) => {
                const label = getMemberLabel(m);
                return (
                  <CommandItem
                    key={m.id}
                    value={m.id}
                    onSelect={() => handleSelect(m.id)}
                    data-testid={`${testId}-option-${m.id}`}
                  >
                    <Check className={cn("mr-2 h-4 w-4", value === m.id ? "opacity-100" : "opacity-0")} />
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm truncate">{label}</span>
                      {m.email && <span className="text-xs text-muted-foreground truncate">{m.email}</span>}
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
