import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProjectBoardInbox from "./ProjectBoardInbox";
import BoardMentionTextarea from "./BoardMentionTextarea";
import { mentionIdentityIds } from "./boardMentionHelpers.mjs";
import { Button } from "@/components/ui/button";
import "@/index.css";

const members = [
  { identity_id: "mia", first_name: "Mia", last_name: "Chen", email: "mia@example.test" },
  { identity_id: "jules", first_name: "Jules", last_name: "Le Roy", email: "jules@example.test" },
  { identity_id: "sam", email: "sam@example.test" },
];
let items = [
  { id: "notice-1", card_id: "card-1", card_title: "Confirm launch checklist", author_name: "Jules Le Roy", content: "@Mia Chen Could you check the handover notes before Thursday?", created_at: "2026-03-12T09:23:00Z", read_at: null, pinned_at: "2026-03-12T10:04:00Z" },
  { id: "notice-2", card_id: "card-2", card_title: "Update the member welcome pack", author_name: "Sam Rivera", content: "The revised draft is attached. @Mia Chen your review would help.", created_at: "2026-03-12T08:47:00Z", read_at: null, pinned_at: null },
  { id: "notice-3", card_id: "deleted", card_title: "Archived supplier notes", author_name: "Jules Le Roy", content: "@Mia Chen Please review the final quote.", created_at: "2026-03-11T14:18:00Z", read_at: "2026-03-11T15:11:00Z", pinned_at: null },
];
// Deny every request except local fixture endpoints. Never contact a live API.
window.fetch = async (path, options = {}) => {
  const pathname = String(path);
  const mode = new URLSearchParams(location.search).get("state");
  if (pathname.startsWith("/api/projects/boards/fixture/inbox")) {
    if (mode === "loading") return new Promise(() => {});
    if (mode === "error") return new Response(JSON.stringify({ error: "Fixture network unavailable" }), { status: 503 });
    if (options.method === "PATCH") {
      const body = JSON.parse(options.body);
      items = items.map((item) => body.all || body.ids?.includes(item.id)
        ? { ...item, ...(typeof body.read === "boolean" ? { read_at: body.read ? new Date().toISOString() : null } : {}), ...(typeof body.pinned === "boolean" ? { pinned_at: body.pinned ? new Date().toISOString() : null } : {}) } : item);
      return new Response(JSON.stringify({ updated: true }), { status: 200 });
    }
    const sorted = [...items].sort((a, b) => Number(Boolean(b.pinned_at)) - Number(Boolean(a.pinned_at)) || new Date(b.created_at) - new Date(a.created_at));
    return new Response(JSON.stringify({ items: mode === "empty" ? [] : sorted, total: mode === "empty" ? 0 : items.length, unreadCount: mode === "empty" ? 0 : items.filter((item) => !item.read_at).length, page: 1, pageSize: 30 }), { status: 200 });
  }
  if (pathname.startsWith("/api/projects/cards/")) {
    const id = pathname.split("/").pop();
    if (id === "deleted") return new Response(JSON.stringify({ error: "Card not found" }), { status: 404 });
    return new Response(JSON.stringify({ card: { id, board_id: "fixture", title: items.find((item) => item.card_id === id)?.card_title } }), { status: 200 });
  }
  throw new Error(`Blocked non-fixture request: ${pathname}`);
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Fixture() {
  const [content, setContent] = useState("");
  const [mentions, setMentions] = useState([]);
  const [card, setCard] = useState(null);
  const [sent, setSent] = useState(null);
  return <QueryClientProvider client={client}>
    <main className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <header className="border-b px-6 py-5"><p className="text-xs text-muted-foreground">Isolated UI fixture · no live APIs</p><h1 className="mt-1 text-xl font-semibold">Member experience / Launch board</h1></header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ProjectBoardInbox boardId="fixture" onOpenCard={setCard} />
        <section className="min-w-0 flex-1 p-6">
          <div className="flex gap-4 overflow-x-auto pb-4">{["To do", "In progress", "Review"].map((title, index) => <div key={title} className="w-64 shrink-0 rounded-lg bg-muted/60 p-3"><h2 className="mb-3 text-sm font-semibold">{title}</h2><button className="w-full rounded-lg border bg-background p-4 text-left text-sm" onClick={() => setCard({ title: ["Confirm launch checklist", "Member welcome pack", "Prepare handover notes"][index] })}>{["Confirm launch checklist", "Member welcome pack", "Prepare handover notes"][index]}</button></div>)}</div>
          <div className="mt-6 max-w-xl rounded-xl border bg-muted/30 p-5"><h2 className="mb-3 font-semibold">Card comments</h2><BoardMentionTextarea aria-label="Write a comment" value={content} onChange={setContent} mentions={mentions} onMentionsChange={setMentions} members={members} rows={4} placeholder="Write a comment…" className="bg-background" />
            <Button className="mt-3" disabled={!content.trim()} onClick={() => { setSent({ content, mentionIdentityIds: mentionIdentityIds(content, mentions, members) }); setContent(""); setMentions([]); }}>Submit fixture comment</Button>
            {sent && <p role="status" className="mt-3 text-sm">Comment accepted · {sent.mentionIdentityIds.length} explicitly selected recipients</p>}
          </div>
          {card && <div className="mt-5 max-w-xl rounded-lg border p-4"><h2 className="font-semibold">{card.title}</h2><p className="mt-1 text-sm text-muted-foreground">Card loaded after access check. Opening did not change read status.</p><Button variant="outline" size="sm" className="mt-3" onClick={() => setCard(null)}>Close card</Button></div>}
        </section>
      </div>
    </main>
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
