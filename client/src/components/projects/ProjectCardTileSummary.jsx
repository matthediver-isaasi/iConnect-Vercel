import { AlignLeft, Bell, Check, Clock, MessageSquare, Paperclip } from "lucide-react";
import { format } from "date-fns";
import { isCardOverdue, readCalendarDate } from "./projectCalendarDates";

/** Non-interactive summary: the containing card keeps its click/drag behaviour. */
export default function ProjectCardTileSummary({ card, children, hasUnreadMention = false, compact = false }) {
  const start = readCalendarDate(card.start_date);
  const due = readCalendarDate(card.due_date);
  const overdue = isCardOverdue(card);
  const dateRange = [start, due].filter(Boolean).map((date) => format(date, "d MMM")).join(" – ");
  const dateLabel = [
    start && `Starts ${format(start, "d MMM yyyy")}`,
    due && `Due ${format(due, "d MMM yyyy")}`,
    card.is_complete ? "Completed" : overdue && "Overdue",
  ].filter(Boolean).join(". ");
  const commentCount = Number(card.project_card_comment?.[0]?.count) || 0;
  const attachmentCount = card.project_card_attachment?.length || 0;
  const hasDescription = Boolean(card.description?.trim());
  const hasMetadata = dateRange || hasUnreadMention || hasDescription || commentCount > 0 || attachmentCount > 0 || children;

  return <>
    <p className="flex min-w-0 items-start gap-2 text-sm font-medium">
      {card.is_complete && <span role="img" aria-label="Completed" title="Completed" className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#5a7f23] text-white">
        <Check aria-hidden="true" className="h-3 w-3" strokeWidth={3} />
      </span>}
      <span className="min-w-0 [overflow-wrap:anywhere]">{card.title}</span>
      {compact && hasUnreadMention && <span role="img" aria-label="Unread mentions" title="You have unread mentions on this card" className="shrink-0 text-primary"><Bell aria-hidden="true" className="h-3.5 w-3.5" /></span>}
      {compact && overdue && <span role="img" aria-label="Overdue" title={dateLabel} className="shrink-0 text-destructive"><Clock aria-hidden="true" className="h-3.5 w-3.5" /></span>}
    </p>
    {!compact && hasMetadata && <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
      {dateRange && <span role="img" aria-label={dateLabel} title={dateLabel} data-testid="tile-date-badge" className={`inline-flex max-w-full items-center gap-1 rounded px-1.5 py-1 font-medium ${
        card.is_complete ? "bg-[#5a7f23] text-white"
          : overdue ? "bg-[#c62828] text-white"
            : "bg-secondary text-secondary-foreground"
      }`}>
        <Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span>{dateRange}</span>
      </span>}
      {hasUnreadMention && <span role="img" aria-label="Unread mentions" title="You have unread mentions on this card" data-testid="tile-mention-badge" className="inline-flex items-center rounded-full bg-primary/10 px-2 py-1 text-primary">
        <Bell aria-hidden="true" className="h-3.5 w-3.5" />
      </span>}
      {hasDescription && <span role="img" aria-label="Has description" title="Has description"><AlignLeft aria-hidden="true" className="h-3.5 w-3.5" /></span>}
      {commentCount > 0 && <span role="img" aria-label={`${commentCount} ${commentCount === 1 ? "comment" : "comments"}`} title={`${commentCount} ${commentCount === 1 ? "comment" : "comments"}`} className="inline-flex items-center gap-1">
        <MessageSquare aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /><span>{commentCount}</span>
      </span>}
      {attachmentCount > 0 && <span role="img" aria-label={`${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"}`} title={`${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"}`} className="inline-flex items-center gap-1">
        <Paperclip aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /><span>{attachmentCount}</span>
      </span>}
      {children}
    </div>}
  </>;
}
