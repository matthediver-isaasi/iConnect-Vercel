import { createRoot } from "react-dom/client";
import ProjectCardTileSummary from "./ProjectCardTileSummary";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import "@/index.css";

// Isolated visual-only fixture. No network transport and no app auth changes.
const cards = [
  { title: "BNMS Invited Speakers certificate - leave off session title and send certificates", is_complete: true, start_date: "2026-10-06", due_date: "2026-10-08", description: "Prepare speaker certificates.", project_card_comment: [{ count: 3 }], project_card_attachment: [{ id: "a" }, { id: "b" }, { id: "c" }] },
  { title: "Review the annual meeting programme", due_date: "2020-10-08", description: "Check the final session order.", project_card_comment: [{ count: 1 }] },
  { title: "Prepare the member welcome pack", start_date: "2026-10-06", project_card_attachment: [{ id: "guide" }] },
  { title: "CheckRoomAllocationWithTheConferenceVenue".repeat(3), due_date: "2099-10-08" },
  { title: "Schedule the next committee meeting" },
];

createRoot(document.getElementById("root")).render(
  <main className="min-h-[100dvh] bg-background p-4 text-foreground">
    <h1 className="mb-4 text-lg font-semibold">Project card summaries</h1>
    <div className="w-full max-w-72 space-y-2 rounded-lg bg-muted/50 p-2">
      {cards.map((card, index) => <Card key={card.title} className="overflow-hidden">
        {index === 2 && <div className="h-8 bg-[#82b4bf]" />}
        <CardContent className="p-3">
          {index === 0 && <div className="mb-2 flex gap-1"><span className="h-2 w-10 rounded-full bg-[#efa900]" /><span className="h-2 w-10 rounded-full bg-[#f36c6a]" /></div>}
          <ProjectCardTileSummary card={card} />
          {index === 0 && <div className="mt-2 flex justify-end"><Avatar className="h-6 w-6"><AvatarFallback className="text-[10px]">MC</AvatarFallback></Avatar></div>}
        </CardContent>
      </Card>)}
    </div>
  </main>,
);
