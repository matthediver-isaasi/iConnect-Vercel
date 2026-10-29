import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { publicClient } from "@/api/publicClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChevronsUpDown } from "lucide-react";

// The public endpoint alone controls visibility. Private event filter metadata
// must never be needed (or fetched) by guest registration.
export default function RegistrationAssociationField({ eventId, eventKind = "simple", value = {}, onChange, ...inputProps }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [other, setOther] = useState(Boolean(value.organization && !value.registration_association));
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => { setOpen(false); setSearch(""); setQuery(""); }, [eventId, eventKind]);
  const result = useQuery({
    queryKey: ["public-event-registration-associations", publicClient.tenantSlug, eventId, eventKind, query],
    queryFn: () => publicClient.getEventRegistrationAssociations(eventId, eventKind, query),
    enabled: !!eventId,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey?.[2] === eventId && previousQuery?.queryKey?.[3] === eventKind ? previous : undefined,
    retry: false,
  });
  const original = <Input {...inputProps} value={value.organization || ""} onChange={event => onChange({
    organization: event.target.value, registration_association: null,
  })} />;
  if (inputProps.disabled) return original;
  if (result.isLoading) return <div className="h-10 animate-pulse rounded-md bg-slate-100" aria-label="Loading organisations and groups" />;
  if (result.data?.enabled !== true) return <div className="space-y-1">
    {original}
    {result.isError && <p role="status" className="text-xs text-slate-500">Organisation search is unavailable. You can enter your organisation above. <button type="button" className="underline" onClick={() => result.refetch()}>Retry search</button></p>}
  </div>;
  const select = option => {
    onChange({ organization: option.name, registration_association: { kind: option.kind, id: option.id } });
    setOther(false); setOpen(false); setSearch("");
  };
  const showOther = other || Boolean(value.organization && !value.registration_association);
  return <div className="space-y-2">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" id={showOther ? `${id}-trigger` : inputProps.id} disabled={inputProps.disabled}
          role="combobox" aria-label="Organisation or group" aria-expanded={open} aria-controls={`${id}-options`}
          className="h-auto min-h-10 w-full justify-between text-left font-normal">
          <span className="truncate">{value.registration_association ? value.organization : showOther ? "Other" : "Select an organisation or group"}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-slate-400" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-2" align="start">
        <Input autoFocus aria-label="Search organisations and groups" placeholder="Search by name" value={search} onChange={event => setSearch(event.target.value)} />
        <div id={`${id}-options`} className="mt-2 max-h-60 overflow-y-auto" aria-label="Organisations and groups">
          {result.isFetching && <div className="my-2 h-8 animate-pulse rounded bg-slate-100" aria-label="Searching" />}
          {(result.data.options || []).map(option => <button key={`${option.kind}:${option.id}`} type="button"
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-100 focus:bg-slate-100"
            onClick={() => select(option)}>{option.name}</button>)}
          {!result.isFetching && !result.data.options?.length && <p className="px-3 py-3 text-sm text-slate-500">No matching organisations or groups. Choose Other to enter your own.</p>}
        </div>
        <button type="button" className="mt-1 block w-full rounded border-t border-slate-200 px-3 py-2 text-left text-sm font-medium hover:bg-slate-100"
          onClick={() => { onChange({ registration_association: null, organization: value.registration_association ? "" : value.organization || "" }); setOther(true); setOpen(false); }}>Other</button>
      </PopoverContent>
    </Popover>
    {showOther && original}
  </div>;
}
