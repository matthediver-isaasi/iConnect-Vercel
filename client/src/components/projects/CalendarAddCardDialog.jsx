import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function CalendarAddCardDialog({ boardId, day, lists, onCreateCard, onClose }) {
  const [title, setTitle] = useState("");
  const [listId, setListId] = useState("");
  const [dueDate, setDueDate] = useState(() => format(day, "yyyy-MM-dd"));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const submit = async event => {
    event.preventDefault();
    const list = lists.find(item => String(item.id) === listId);
    if (saving.current || !title.trim() || !list || !onCreateCard) return;
    saving.current = true;
    setPending(true);
    setError("");
    try {
      // mutateAsync resolves only after the board's existing cache publication.
      await onCreateCard({ boardId, list_id: list.id, title: title.trim(), due_date: dueDate || null });
      if (mounted.current) onClose();
    } catch (cause) {
      if (mounted.current) setError(cause?.message || "Could not create this card. Your draft is still here; please try again.");
    } finally {
      saving.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return <Dialog open onOpenChange={open => { if (!open && !saving.current) onClose(); }}>
    <DialogContent hideCloseButton={pending}
      onEscapeKeyDown={event => { if (saving.current) event.preventDefault(); }}
      onPointerDownOutside={event => { if (saving.current) event.preventDefault(); }}
      onInteractOutside={event => { if (saving.current) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>Add card</DialogTitle>
        <DialogDescription>Schedule a task and choose where it belongs on this board.</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2"><Label htmlFor="calendar-card-title">Title</Label>
          <Input id="calendar-card-title" value={title} onChange={event => setTitle(event.target.value)} required autoFocus disabled={pending} maxLength={500} />
        </div>
        <div className="space-y-2"><Label htmlFor="calendar-card-list">List</Label>
          <select id="calendar-card-list" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            value={listId} onChange={event => setListId(event.target.value)} required disabled={pending}>
            <option value="" disabled>Choose a list</option>
            {lists.map(list => <option key={list.id} value={String(list.id)}>{list.name}</option>)}
          </select>
        </div>
        <div className="space-y-2"><Label htmlFor="calendar-card-due">Due date</Label>
          <Input id="calendar-card-due" type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} disabled={pending} />
          <p className="text-xs text-muted-foreground">You can change this date or leave it empty for an undated task.</p>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {pending && <p role="status" className="text-sm text-muted-foreground animate-pulse">Creating card…</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending || !title.trim() || !lists.some(list => String(list.id) === listId)}>
            {pending ? "Creating…" : "Create card"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
