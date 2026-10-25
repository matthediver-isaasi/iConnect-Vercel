import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";

// Same event source, searchable title list and selection model as Event Attendees
// in Communications' existing audience editor. No new audience-list segment type.
export default function EventAudiencePicker({ value, onChange }) {
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: ['audience-list-events'],
    queryFn: async () => {
      const response = await fetch('/api/audience-lists/events', { credentials: 'include' });
      if (!response.ok) throw new Error('Unable to load events');
      return response.json();
    },
    staleTime: 60000,
  });
  const filtered = (query.data || []).filter(event => (event.title || '').toLowerCase().includes(search.toLowerCase()));
  return <div className="border rounded-md p-3 space-y-3">
    <Input aria-label="Search events" placeholder="Search events by title..." value={search} onChange={e => setSearch(e.target.value)} />
    {query.isLoading ? <div className="h-16 animate-pulse rounded bg-muted" aria-label="Loading events" />
      : query.isError ? <div role="alert">{query.error.message} <Button variant="outline" onClick={() => query.refetch()}>Retry</Button></div>
      : <div className="max-h-48 overflow-y-auto space-y-2">{filtered.map(event =>
        <label key={event.id} className="flex gap-2 items-center text-sm cursor-pointer py-1">
          <Checkbox checked={value.includes(event.id)} onCheckedChange={checked => onChange(checked ? [...value, event.id] : value.filter(id => id !== event.id))} />
          <span>{event.title}</span>
        </label>)}
        {!query.data?.length && <p className="text-sm text-muted-foreground">No events available.</p>}
        {!!query.data?.length && !filtered.length && <p className="text-sm text-muted-foreground">No events match this search.</p>}
      </div>}
    {value.length > 0 && <p className="text-xs text-muted-foreground">{value.length} event{value.length === 1 ? '' : 's'} selected</p>}
  </div>;
}
