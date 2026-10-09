import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { format, isSameMonth } from "date-fns";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import CalendarAddCardDialog from "./CalendarAddCardDialog";
import ProjectCardTileSummary from "./ProjectCardTileSummary";
import {
  calendarHeading, calendarWeeks, cardDateRange, cardsOnDate, navigateCalendar,
  readCalendarDate, sameCalendarDay, weekCardSpans,
} from "./projectCalendarDates";
import "./ProjectBoardCalendar.css";

const EMPTY_CARDS = [];
const EMPTY_UNREAD = new Set();

function CalendarTask({ card, labels, lists, unreadCardIds, onOpenCard, compact = false, style, span }) {
  const list = lists.find(item => String(item.id) === String(card.list_id));
  const cardLabels = (card.project_card_label || []).map(item =>
    labels.find(label => String(label.id) === String(item.label_id))).filter(Boolean);
  return <button type="button" onClick={() => onOpenCard(card)}
    onContextMenu={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    className={`calendar-task ${compact ? "calendar-task-span" : ""}`} style={style}
    data-testid={`calendar-card-${card.id}`}
    data-continues-before={span?.continuesBefore || undefined}
    data-continues-after={span?.continuesAfter || undefined}
    title={[card.title, list?.name, ...cardLabels.map(label => label.name)].filter(Boolean).join(" · ")}>
    {cardLabels.length > 0 && <span className="calendar-task-labels">
      {cardLabels.map(label => <span className="calendar-label" key={label.id}>
        <i aria-hidden="true" style={{ backgroundColor: label.color }} /><span>{label.name || "Unnamed label"}</span>
      </span>)}
    </span>}
    <ProjectCardTileSummary card={card} compact={compact} hasUnreadMention={unreadCardIds.has(card.id)} />
    {!compact && list && <span className="mt-2 block text-xs text-muted-foreground">{list.name}</span>}
  </button>;
}

export default function ProjectBoardCalendar({
  cards = EMPTY_CARDS, labels = [], lists = [], unreadCardIds = EMPTY_UNREAD,
  onOpenCard, initialDate = new Date(), initialMode = "month",
  boardId, canEdit = false, onCreateCard,
}) {
  const [date, setDate] = useState(() => readCalendarDate(initialDate) || new Date());
  const [mode, setMode] = useState(initialMode);
  const [selectedDay, setSelectedDay] = useState(date);
  const [creationDay, setCreationDay] = useState(null);
  const [contextDay, setContextDay] = useState(date);
  useEffect(() => { setSelectedDay(date); }, [date]);
  useEffect(() => { setCreationDay(null); setSelectedDay(date); }, [boardId]);
  const creationAvailable = canEdit && Boolean(onCreateCard) && Boolean(boardId);
  const openCreation = day => { if (creationAvailable && lists.length) setCreationDay(day); };
  const contextForWeek = (event, week) => {
    if (event.target.closest(".calendar-task")) return;
    const heading = event.target.closest("[data-calendar-day]");
    const bounds = event.currentTarget.getBoundingClientRect();
    const column = Math.max(0, Math.min(6, Math.floor((event.clientX - bounds.left) / (bounds.width / 7))));
    const day = heading ? readCalendarDate(heading.dataset.calendarDay) : week[Number.isFinite(column) ? column : 0];
    setContextDay(day);
    setSelectedDay(day);
  };
  const dayMenu = <ContextMenuContent>
    <ContextMenuItem disabled={!lists.length} onSelect={() => openCreation(contextDay)}>
      <Plus className="mr-2 h-4 w-4" aria-hidden="true" />Add card
    </ContextMenuItem>
    {!lists.length && <p className="max-w-64 px-2 py-1 text-xs text-muted-foreground">Create a list on the board before adding cards.</p>}
  </ContextMenuContent>;
  const today = new Date();
  const undated = useMemo(() => cards.filter(card => !cardDateRange(card)), [cards]);
  const weeks = useMemo(() => calendarWeeks(date, mode), [date, mode]);
  const dayCards = useMemo(() => cardsOnDate(cards, date), [cards, date]);
  const taskProps = { labels, lists, unreadCardIds, onOpenCard };
  const goToDay = day => { setDate(day); setMode("day"); };
  return <section className="project-calendar" aria-label="Board calendar">
    <div className="calendar-toolbar">
      <CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />
      <h2 className="mr-auto text-sm font-semibold" aria-live="polite" data-testid="calendar-heading">{calendarHeading(date, mode)}</h2>
      <div className="flex items-center gap-1">
        <button className="calendar-control" type="button" aria-label={`Previous ${mode}`} onClick={() => setDate(current => navigateCalendar(current, mode, -1))}><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
        <button className="calendar-control" type="button" onClick={() => setDate(readCalendarDate(new Date()))}>Today</button>
        <button className="calendar-control" type="button" aria-label={`Next ${mode}`} onClick={() => setDate(current => navigateCalendar(current, mode, 1))}><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
      </div>
      <input className="calendar-control min-w-0 max-w-full" type="date" aria-label="Go to date" value={format(date, "yyyy-MM-dd")}
        onChange={event => { const next = readCalendarDate(event.target.value); if (next) setDate(next); }} />
      <div className="calendar-modes" role="group" aria-label="Calendar mode">
        {["day", "week", "month"].map(value => <button key={value} type="button" className="calendar-control" aria-pressed={mode === value} onClick={() => setMode(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
      </div>
    </div>
    {creationAvailable && <div className="calendar-create">
      <button className="calendar-control" type="button" disabled={!lists.length} onClick={() => openCreation(selectedDay)}>
        <Plus className="h-4 w-4" aria-hidden="true" />Add card
      </button>
      <p>{lists.length ? `Selected day · ${format(selectedDay, "d MMMM yyyy")}` : "Create a list on the board before adding cards."}</p>
    </div>}
    {mode === "day" ? <ContextMenu><ContextMenuTrigger asChild disabled={!creationAvailable}>
      <div className="calendar-agenda" onContextMenu={() => { setContextDay(date); setSelectedDay(date); }}
        onPointerDown={() => { setContextDay(date); setSelectedDay(date); }}>
      <p className="mb-3 text-xs text-muted-foreground">Day agenda · {dayCards.length} {dayCards.length === 1 ? "task" : "tasks"} · Dates are inclusive; no time slots.</p>
      {dayCards.length ? <div className="calendar-agenda-list">{dayCards.map(card => <CalendarTask key={card.id} card={card} {...taskProps} />)}</div>
        : <div className="calendar-empty"><h3 className="mb-1 font-medium text-foreground">Nothing scheduled for this day</h3>Choose another date or check the undated tasks below.</div>}
    </div></ContextMenuTrigger>{creationAvailable && dayMenu}</ContextMenu> : <div className="calendar-overflow" role="region" aria-label={`${mode === "week" ? "Week" : "Month"} calendar, scroll horizontally on small screens`} tabIndex={0}>
      <div className="calendar-grid">
        <div className="calendar-weekdays">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map(day => <span key={day}>{day}</span>)}</div>
        {weeks.map(week => {
          const spans = weekCardSpans(cards, week[0]);
          return <ContextMenu key={format(week[0], "yyyy-MM-dd")}><ContextMenuTrigger asChild disabled={!creationAvailable}>
            <div className="calendar-week" data-testid="calendar-week"
              onContextMenu={event => contextForWeek(event, week)} onPointerDown={event => contextForWeek(event, week)}>
            <div className="calendar-day-backgrounds" aria-hidden="true">{week.map(day => <div key={day.getTime()} className={sameCalendarDay(day, today) ? "calendar-today" : mode === "month" && !isSameMonth(day, date) ? "calendar-outside" : ""} />)}</div>
            <div className="calendar-day-headings">{week.map(day => <button type="button" key={day.getTime()}
              className={`calendar-day-heading ${mode === "month" && !isSameMonth(day, date) ? "calendar-outside" : ""}`}
              data-calendar-day={format(day, "yyyy-MM-dd")}
              aria-current={sameCalendarDay(day, today) ? "date" : undefined}
              aria-label={`View ${format(day, "EEEE, d MMMM yyyy")}`} onClick={() => goToDay(day)}>{format(day, mode === "week" ? "d MMM" : "d")}</button>)}</div>
            <div className="calendar-spans">{spans.map(span => <CalendarTask key={span.card.id} card={span.card} compact span={span} {...taskProps}
              style={{ gridColumn: `${span.startColumn} / ${span.endColumn + 1}`, gridRow: span.lane + 1 }} />)}</div>
          </div></ContextMenuTrigger>{creationAvailable && dayMenu}</ContextMenu>;
        })}
      </div>
      {!weeks.some(week => weekCardSpans(cards, week[0]).length) && <p className="mt-3 text-sm text-muted-foreground">No dated tasks in this {mode}. Undated tasks are shown below.</p>}
    </div>}
    <div className="calendar-undated">
      <h3 className="text-sm font-semibold">Undated tasks <span className="ml-1 text-muted-foreground">({undated.length})</span></h3>
      <p className="mt-1 text-xs text-muted-foreground">Tasks without a start or due date stay here. Open a task to add dates.</p>
      {undated.length ? <div className="calendar-undated-list">{undated.map(card => <CalendarTask key={card.id} card={card} {...taskProps} />)}</div>
        : <p className="mt-3 text-xs text-muted-foreground">All tasks have dates.</p>}
    </div>
    {creationDay && creationAvailable && <CalendarAddCardDialog key={boardId} boardId={boardId} day={creationDay} lists={lists}
      onCreateCard={onCreateCard} onClose={() => setCreationDay(null)} />}
  </section>;
}
