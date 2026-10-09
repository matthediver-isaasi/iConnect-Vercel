import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Inbox, Mail, MailOpen, Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { projectTaskRequest } from "@/components/sales/useSalesProjectTasks";
import { availableInboxCard, inboxCardError } from "./boardMentionHelpers.mjs";
import { useBoardInbox } from "./useBoardInbox";
import "./boardMentions.css";

const timestamp = (date) => {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(parsed);
};

export default function ProjectBoardInbox({ boardId, onOpenCard }) {
  // Remount per board: pagination, selections and pending card requests stay scoped.
  return <InboxContent key={boardId} boardId={boardId} onOpenCard={onOpenCard} />;
}

function InboxContent({ boardId, onOpenCard }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState([]);
  const [opening, setOpening] = useState(null);
  const [openError, setOpenError] = useState(null);
  const [actionError, setActionError] = useState("");
  const controller = useRef(null);
  const contentId = useId();
  const { query, command } = useBoardInbox(boardId, page);
  const { data, isLoading, error } = query;
  const items = data?.items || [];
  const pages = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || 30)));
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (data && page > pages) { setPage(pages); setSelected([]); }
  }, [data, page, pages]);
  const update = (body) => {
    setActionError("");
    command.mutate(body, {
      onSuccess: () => setSelected([]),
      onError: (failure) => setActionError(failure.message || "Could not update your inbox."),
    });
  };
  const openCard = async (item) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setOpening(item.id); setOpenError(null);
    try {
      // Always recheck server access, even if the board cache holds this card.
      const result = await projectTaskRequest(`/api/projects/cards/${encodeURIComponent(item.card_id)}`, { signal: request.signal });
      if (!request.signal.aborted) onOpenCard(availableInboxCard(result, boardId));
    } catch (failure) {
      if (!request.signal.aborted) setOpenError({ item, message: inboxCardError(failure) });
    } finally {
      if (!request.signal.aborted) setOpening(null);
    }
  };
  const changePage = (next) => { setPage(next); setSelected([]); };
  const visibleIds = items.map((item) => item.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  return <aside className="project-inbox" aria-label="Personal board mention inbox" data-testid="board-mention-inbox">
    <div className="flex items-center justify-between gap-2 px-4 py-4">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Inbox className="h-4 w-4 text-primary" />Your mentions
          {Boolean(data?.unreadCount) && <span aria-label={`${data.unreadCount} unread mentions`} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{data.unreadCount}</span>}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">Private to you. Only this board.</p>
      </div>
      <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" aria-expanded={expanded} aria-controls={contentId} aria-label={expanded ? "Collapse your mentions" : "Expand your mentions"} onClick={() => setExpanded(!expanded)}>
        <ChevronDown className={`h-4 w-4 ${expanded ? "rotate-180" : ""}`} />
      </Button>
    </div>
    <div id={contentId} className={`${expanded ? "flex" : "hidden"} min-h-0 flex-1 flex-col md:flex`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-y px-4 py-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <input type="checkbox" aria-label="Select all mentions on this page" checked={allSelected} disabled={!items.length || command.isPending}
            onChange={(event) => setSelected(event.target.checked ? visibleIds : [])} className="h-4 w-4 accent-[hsl(var(--primary))]" />Select page
        </label>
        <Button variant="ghost" size="sm" className="h-7 px-1 text-xs" disabled={!data?.unreadCount || command.isPending} onClick={() => update({ all: true, read: true })}><CheckCheck className="mr-1 h-3.5 w-3.5" />Mark all read</Button>
      </div>
      {selected.length > 0 && <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2">
        <span className="text-xs">{selected.length} selected</span>
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={command.isPending} onClick={() => update({ ids: selected, read: true })}>Mark read</Button>
        <Button variant="ghost" size="sm" className="h-7 px-1 text-xs" onClick={() => setSelected([])}>Clear</Button>
      </div>}
      {actionError && <div role="alert" className="mx-3 mt-3 rounded-md border border-destructive/30 p-3 text-xs text-destructive">{actionError}<Button variant="ghost" size="sm" className="mt-1 h-7" disabled={command.isPending} onClick={() => update(command.variables)}>Retry update</Button></div>}
      {openError && <div role="alert" className="mx-3 mt-3 rounded-md border border-destructive/30 p-3 text-xs">
        <p className="text-destructive">{openError.message}</p>
        <div className="mt-2 flex gap-2"><Button variant="outline" size="sm" className="h-7" onClick={() => openCard(openError.item)}>Try again</Button><Button variant="ghost" size="sm" className="h-7" onClick={() => setOpenError(null)}>Dismiss</Button></div>
      </div>}
      <div className="project-inbox-list space-y-2 p-3" aria-busy={query.isFetching || command.isPending}>
        {isLoading ? <div role="status" aria-label="Loading your mentions" className="space-y-3">{[0, 1, 2].map((index) => <div key={index} className="h-28 animate-pulse rounded-lg bg-muted" />)}</div>
          : error ? <div role="alert" className="rounded-lg border border-dashed p-4 text-sm">
            <AlertCircle className="mb-2 h-5 w-5 text-destructive" /><p className="font-medium">Your inbox couldn’t load</p><p className="mt-1 text-xs text-muted-foreground">{error.message}</p><Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>Retry</Button>
          </div>
          : !items.length ? <div className="rounded-lg border border-dashed px-4 py-7 text-center"><Inbox className="mx-auto mb-3 h-7 w-7 text-primary/60" /><p className="text-sm font-medium">Nothing waiting for you</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">When a board member mentions you in a card comment, it will appear here.</p></div>
          : items.map((item) => <article key={item.id} className="project-inbox-item p-3" data-unread={!item.read_at} data-selected={selected.includes(item.id)}>
            <div className="flex items-start gap-2">
              <input type="checkbox" checked={selected.includes(item.id)} disabled={command.isPending} aria-label={`Select mention on ${item.card_title || "Untitled card"}`} className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
                onChange={(event) => setSelected((old) => event.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id))} />
              <button type="button" className="min-w-0 flex-1 rounded-sm text-left" disabled={opening === item.id} onClick={() => openCard(item)} aria-label={`Open card: ${item.card_title || "Untitled card"}`}>
                <span className="flex items-start gap-1.5 text-sm font-semibold leading-snug">{item.pinned_at && <Pin className="mt-0.5 h-3 w-3 shrink-0 text-primary" />}<span className="break-words">{item.card_title || "Untitled card"}</span></span>
                <span className="mt-1.5 block text-xs font-medium">{item.author_name || "Board member"}</span>
                <span className="mt-1 block line-clamp-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{item.content}</span>
                {opening === item.id && <span role="status" className="mt-2 block text-xs text-primary">Opening card…</span>}
              </button>
            </div>
            <div className="mt-2 flex items-center justify-between gap-1 border-t pt-2">
              <time className="text-[10px] text-muted-foreground" dateTime={item.created_at}>{timestamp(item.created_at)}</time>
              <div className="flex gap-0.5">
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={command.isPending} aria-label={item.read_at ? "Mark unread" : "Mark read"} title={item.read_at ? "Mark unread" : "Mark read"} onClick={() => update({ ids: [item.id], read: !item.read_at })}>{item.read_at ? <Mail className="h-3.5 w-3.5" /> : <MailOpen className="h-3.5 w-3.5" />}</Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={command.isPending} aria-label={item.pinned_at ? "Unpin mention" : "Pin mention"} aria-pressed={Boolean(item.pinned_at)} title={item.pinned_at ? "Unpin mention" : "Pin mention"} onClick={() => update({ ids: [item.id], pinned: !item.pinned_at })}>{item.pinned_at ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</Button>
              </div>
            </div>
          </article>)}
      </div>
      {data && <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
        <span>{data.total} mention{data.total === 1 ? "" : "s"} · Page {page} / {pages}</span>
        <div className="flex gap-1"><Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Previous inbox page" disabled={page <= 1 || query.isFetching || command.isPending} onClick={() => changePage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Next inbox page" disabled={page >= pages || query.isFetching || command.isPending} onClick={() => changePage(page + 1)}><ChevronRight className="h-4 w-4" /></Button></div>
      </div>}
    </div>
  </aside>;
}
