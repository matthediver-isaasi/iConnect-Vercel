import { Search, Tags, Users, X, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ASSIGNED_TO_ME, UNASSIGNED } from "./projectBoardFilters.mjs";

function MultiFilter({ title, icon: Icon, options, selected, onChange }) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button size="sm" variant={selected.length ? "secondary" : "outline"} aria-label={`${title}${selected.length ? ` (${selected.length} selected)` : ""}`}>
        <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
        {title}{selected.length > 0 && <span className="ml-2 rounded bg-primary/10 px-1.5 text-xs text-primary">{selected.length}</span>}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="max-h-72 max-w-[calc(100vw-2rem)] overflow-y-auto">
      <DropdownMenuLabel>{title} · match any</DropdownMenuLabel>
      <DropdownMenuSeparator />
      {!options.length && <p className="px-2 py-3 text-xs text-muted-foreground">No {title.toLowerCase()} on this board.</p>}
      {options.map(option => <DropdownMenuCheckboxItem key={option.id} checked={selected.includes(option.id)}
        disabled={option.disabled} onSelect={event => event.preventDefault()}
        onCheckedChange={checked => onChange(checked ? [...selected, option.id] : selected.filter(id => id !== option.id))}>
        {option.color && <span className="mr-2 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: option.color }} />}
        {option.name}
      </DropdownMenuCheckboxItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

export default function ProjectBoardFilters({
  controller, labels = [], members = [], viewerIdentityId, totalCount,
}) {
  const { filters, setFilters, clearFilters, active, filteredCards, searchStatus, searchError, retrySearch, noMatches } = controller;
  const update = patch => setFilters(current => ({ ...current, ...patch }));
  const labelOptions = labels.map(label => ({ id: String(label.id), name: label.name || "Unnamed label", color: label.color }));
  const assigneeOptions = [
    { id: ASSIGNED_TO_ME, name: "Assigned to Me", disabled: viewerIdentityId == null },
    { id: UNASSIGNED, name: "Unassigned" },
    ...members.map(member => ({
      id: String(member.identity_id),
      name: [member.first_name, member.last_name].filter(Boolean).join(" ") || member.email || "Board member",
    })),
  ];
  const activeOptions = [
    ...labelOptions.filter(option => filters.labels.includes(option.id)).map(option => ({ ...option, kind: "labels" })),
    ...assigneeOptions.filter(option => filters.assignees.includes(option.id)).map(option => ({ ...option, kind: "assignees" })),
  ];
  return <section aria-label="Board filters" className="shrink-0 border-b bg-muted/20 px-4 py-3">
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full md:w-72">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input className="h-9 pl-9 pr-9" aria-label="Search cards" placeholder="Search cards, comments, activity…" value={filters.keyword}
          onChange={event => update({ keyword: event.target.value })} />
        {filters.keyword && <Button variant="ghost" size="icon" className="absolute right-0 top-0 h-9 w-9"
          aria-label="Clear search" onClick={() => update({ keyword: "" })}><X className="h-3.5 w-3.5" /></Button>}
      </div>
      <MultiFilter title="Labels" icon={Tags} options={labelOptions} selected={filters.labels} onChange={labels => update({ labels })} />
      <MultiFilter title="Assignees" icon={Users} options={assigneeOptions} selected={filters.assignees} onChange={assignees => update({ assignees })} />
      <Button size="sm" variant={filters.hideCompleted ? "secondary" : "outline"} aria-pressed={filters.hideCompleted}
        onClick={() => update({ hideCompleted: !filters.hideCompleted })}>Hide completed</Button>
      <Button size="sm" variant="ghost" disabled={!active && !filters.keyword} onClick={clearFilters}>Clear Filters</Button>
      <span className="text-xs text-muted-foreground md:ml-auto" role="status">
        {searchStatus === "loading" ? "Searching all card text…"
          : searchStatus === "error" ? "Search unavailable"
            : `${filteredCards.length} of ${totalCount} cards`}
      </span>
    </div>
    {!!activeOptions.length && <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Active filters">
      {activeOptions.map(option => <Button key={`${option.kind}-${option.id}`} size="sm" variant="secondary" className="h-6 gap-1.5 px-2 text-xs"
        aria-label={`Remove ${option.name} filter`} onClick={() => update({ [option.kind]: filters[option.kind].filter(id => id !== option.id) })}>
        {option.name}<X aria-hidden="true" className="h-3 w-3" />
      </Button>)}
    </div>}
    {searchStatus === "loading" && <p role="status" className="mt-2 animate-pulse text-xs text-muted-foreground">
      Loading complete search results. Keyword filtering will apply when ready.
    </p>}
    {searchStatus === "error" && <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-destructive">
      <AlertCircle aria-hidden="true" className="h-4 w-4" /><span>{searchError} Keyword filtering is not applied.</span>
      <Button size="sm" variant="outline" onClick={retrySearch}>Retry search</Button>
    </div>}
    {noMatches && <div role="status" className="mt-3 rounded-md border border-dashed bg-background px-4 py-3">
      <p className="text-sm font-medium">No cards match your filters</p>
      <p className="mt-1 text-xs text-muted-foreground">Try another keyword or clear filters to see all cards. Nothing on this board has changed.</p>
    </div>}
  </section>;
}
