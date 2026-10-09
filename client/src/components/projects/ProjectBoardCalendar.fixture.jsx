import { useState } from "react";
import { createRoot } from "react-dom/client";
import ProjectBoardCalendar from "./ProjectBoardCalendar";
import CalendarAddCardDialog from "./CalendarAddCardDialog";
import "@/index.css";

// Visual-only fixture: no API, authentication bypass, or rescheduling.
const labels = [{ id: "event", name: "Events", color: "#efa900" }, { id: "member", name: "Membership", color: "#7dacb3" }];
const cards = [
  { id: "1", title: "Speaker certificates — check names and send", start_date: "2026-10-06", due_date: "2026-10-09", is_complete: true, project_card_label: [{ label_id: "event" }] },
  { id: "2", title: "Annual meeting programme review", start_date: "2026-10-01", due_date: "2026-10-14", project_card_label: [{ label_id: "event" }] },
  { id: "3", title: "Prepare member welcome pack", due_date: "2026-10-08", project_card_label: [{ label_id: "member" }] },
  { id: "4", title: "Confirm room allocation with venue", start_date: "2026-10-08" },
  { id: "5", title: "Choose next committee date" },
  ...Array.from({ length: 12 }, (_, index) => ({ id: `review-${index}`, title: `Registration review ${index + 1}`, due_date: "2026-10-09" })),
];
function Fixture() {
  const [opened, setOpened] = useState(null);
  const [sampleCards, setSampleCards] = useState(cards);
  const [showCreate, setShowCreate] = useState(new URLSearchParams(window.location.search).has("create"));
  const lists = [{ id: "todo", name: "To do" }, { id: "progress", name: "In progress" }];
  const createSample = async values => setSampleCards(current => [...current, { ...values, id: `sample-${current.length}` }]);
  return <main className="min-h-[100dvh] bg-background text-foreground">
    <header className="border-b bg-primary/5 px-4 py-3"><h1 className="text-xl font-bold">Membership team</h1><p className="text-sm text-muted-foreground">iConnect · Calendar fixture</p></header>
    <ProjectBoardCalendar cards={sampleCards} labels={labels} unreadCardIds={new Set(["1", "3"])} initialDate="2026-10-09"
      boardId="fixture" canEdit lists={lists} onCreateCard={createSample}
      initialMode={new URLSearchParams(window.location.search).get("mode") || "month"} onOpenCard={setOpened} />
    {showCreate && <CalendarAddCardDialog boardId="fixture" day={new Date(2026, 9, 9)} lists={lists}
      onCreateCard={createSample} onClose={() => setShowCreate(false)} />}
    {opened && <div role="status" className="border-t p-4">Opened: {opened.title}<button type="button" className="ml-4 underline" onClick={() => setOpened(null)}>Dismiss</button></div>}
  </main>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
