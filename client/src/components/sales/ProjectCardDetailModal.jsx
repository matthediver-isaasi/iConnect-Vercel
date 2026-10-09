import { invalidateInboxViews } from "@/lib/inboxSources.mjs";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Check, History, MessageSquare, Pencil, Plus, Tag, Trash2, Users, X } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { apiRequest } from "@/lib/queryClient";
import { CardAttachments, CardCoverSection } from "@/components/projects/CardAttachments";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import BoardMentionTextarea from "@/components/projects/BoardMentionTextarea";
import { mentionIdentityIds } from "@/components/projects/boardMentionHelpers.mjs";
import { projectTaskRequest, refreshSalesProjects } from "./useSalesProjectTasks";
import { TaskError } from "./SalesProjectTaskStates";

const LABEL_COLORS = ["#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#ec4899", "#f43f5e", "#78716c"];
const editableValues = (card) => ({
  title: card.title || "", description: card.description || "",
  start_date: card.start_date?.split("T")[0] || "", due_date: card.due_date?.split("T")[0] || "",
  priority: card.priority || "none", is_complete: Boolean(card.is_complete), list_id: card.list_id,
});
const dateText = (value, pattern = "MMM d, h:mm a") => {
  if (!value || Number.isNaN(new Date(value).getTime())) return "";
  return format(new Date(value), pattern);
};
const personName = (person) => [person?.first_name, person?.last_name].filter(Boolean).join(" ") || person?.email || "Board member";

function activityText(activity, lists, getMemberById) {
  const data = activity.action_data || {};
  const listName = lists.find((list) => list.id === (data.to_list || data.moved_to_list))?.name;
  const actions = {
    created: "created this card", updated: "updated this card", completed: "completed this card",
    reopened: "reopened this card", archived: "archived this card",
    moved: listName ? `moved this card to ${listName}` : "moved this card",
    assigned: `assigned ${personName(getMemberById(data.assignee_id))}`,
    unassigned: `unassigned ${personName(getMemberById(data.assignee_id))}`,
    cover_set: "changed the cover", cover_cleared: "removed the cover",
    attachment_added: `added attachment${data.fileName ? `: ${data.fileName}` : ""}`,
    attachment_deleted: `removed attachment${data.fileName ? `: ${data.fileName}` : ""}`,
    commented: "added a comment",
  };
  return actions[activity.action_type] || "updated this card";
}

// Shared by Projects and Sales. Keep drafts independent of board/detail refreshes.
export default function CardDetailModal({
  card, open, onOpenChange, boardId, labels = [], members = [], lists = [],
  canEdit, canManage, canAssign = canEdit, canManageLabels = canManage, onUpdate, onDelete,
  getLabelById = (id) => labels.find((label) => label.id === id),
  getMemberById = (id) => members.find((member) => member.identity_id === id),
}) {
  const [editedCard, setEditedCard] = useState({});
  const [newComment, setNewComment] = useState("");
  const [commentMentions, setCommentMentions] = useState([]);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [showMemberPicker, setShowMemberPicker] = useState(false);
  const [editingLabel, setEditingLabel] = useState(null);
  const [labelOverrides, setLabelOverrides] = useState({});
  const [showActivity, setShowActivity] = useState(true);
  const [saving, setSaving] = useState(false);
  const initialized = useRef(null);
  const dirtyFields = useRef(new Set());
  const queryClient = useQueryClient();
  const details = useQuery({
    queryKey: ["card-detail", card?.id],
    queryFn: ({ signal }) => projectTaskRequest(`/api/projects/cards/${card.id}`, { signal }),
    enabled: Boolean(card?.id && open), refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (!open) {
      initialized.current = null;
      setCommentMentions([]);
      dirtyFields.current.clear();
      setEditingLabel(null); setShowMemberPicker(false); setShowLabelPicker(false);
      return;
    }
    if (!card) return;
    const values = editableValues({ ...card, ...details.data?.card });
    if (initialized.current !== card.id) {
      initialized.current = card.id;
      dirtyFields.current.clear();
      setEditedCard(values); setNewComment("");
      setCommentMentions([]);
      setEditingLabel(null); setShowMemberPicker(false); setShowLabelPicker(false);
    } else {
      setEditedCard((draft) => {
        const next = { ...draft };
        for (const [key, value] of Object.entries(values)) {
          if (!dirtyFields.current.has(key)) next[key] = value;
        }
        return next;
      });
    }
  }, [card, open, details.data?.card]);
  useEffect(() => { setLabelOverrides({}); }, [boardId]);
  const editField = (key, value) => {
    dirtyFields.current.add(key);
    setEditedCard((draft) => ({ ...draft, [key]: value }));
  };
  const refresh = () => refreshSalesProjects(queryClient);
  const reportError = (error) => toast.error(error.message || "Could not update card");

  // Server-confirmed label writes are immediately visible even while parents
  // still hold the previous board props. Tombstones prevent deleted-label flashes.
  const publishLabel = async (label, deletedId) => {
    const id = deletedId || label.id;
    await queryClient.cancelQueries({ queryKey: ["project-board", boardId], exact: true });
    if (deletedId) {
      await queryClient.cancelQueries({
        predicate: (query) => query.queryKey[0] === "card-detail" && query.state.data?.card?.board_id === boardId,
      });
    }
    setLabelOverrides((old) => ({ ...old, [id]: deletedId ? null : label }));
    const stripLabel = (item) => ({
      ...item, project_card_label: item.project_card_label?.filter((entry) => entry.label_id !== deletedId),
    });
    queryClient.setQueryData(["project-board", boardId], (old) => {
      if (!old) return old;
      const nextLabels = (old.labels || []).filter((item) => item.id !== id);
      if (!deletedId) nextLabels.push(label);
      return { ...old, labels: nextLabels, ...(deletedId ? { cards: old.cards?.map(stripLabel) } : {}) };
    });
    if (deletedId) {
      queryClient.setQueriesData({
        predicate: (query) => query.queryKey[0] === "card-detail" &&
          (query.state.data?.card?.board_id === boardId || query.queryKey[1] === card?.id),
      }, (old) => old?.card ? { ...old, card: stripLabel(old.card) } : old);
    }
    void refresh();
  };
  const addComment = useMutation({
    mutationFn: ({ content, mentionIdentityIds: ids }) => apiRequest("POST", `/api/projects/cards/${card.id}/comments`, { content, mentionIdentityIds: ids }),
    onSuccess: (result) => {
      setNewComment("");
      setCommentMentions([]);
      void invalidateInboxViews(queryClient, boardId);
      if (result.comment) queryClient.setQueryData(["card-detail", card.id], (old) =>
        old ? { ...old, comments: [...(old.comments || []), result.comment] } : old);
      void refresh();
    }, onError: reportError,
  });
  const toggleLabel = useMutation({
    mutationFn: ({ id, applied }) => apiRequest(applied ? "DELETE" : "POST", `/api/projects/cards/${card.id}/labels`, { label_id: id }),
    onSuccess: async (_, { id, applied }) => {
      await queryClient.cancelQueries({ queryKey: ["card-detail", card.id], exact: true });
      const updateLabels = (value) => {
        const remaining = (value.project_card_label || []).filter((entry) => entry.label_id !== id);
        return { ...value, project_card_label: applied ? remaining : [...remaining, { label_id: id }] };
      };
      queryClient.setQueryData(["card-detail", card.id], (old) => ({ ...old, card: updateLabels(old?.card || card) }));
      queryClient.setQueryData(["project-board", boardId], (old) =>
        old ? { ...old, cards: old.cards?.map((item) => item.id === card.id ? updateLabels(item) : item) } : old);
      void refresh();
    }, onError: reportError,
  });
  const saveLabel = useMutation({
    mutationFn: ({ id, name, color }) => apiRequest(id ? "PATCH" : "POST", `/api/projects/boards/${boardId}/labels`,
      { ...(id ? { id } : {}), name: name.trim(), color }),
    onSuccess: async ({ label }) => { await publishLabel(label); setEditingLabel(null); },
    onError: reportError,
  });
  const deleteLabel = useMutation({
    mutationFn: (id) => apiRequest("DELETE", `/api/projects/boards/${boardId}/labels`, { id }),
    onSuccess: async (_, id) => { await publishLabel(null, id); if (editingLabel?.id === id) setEditingLabel(null); },
    onError: reportError,
  });
  const toggleAssignee = useMutation({
    mutationFn: ({ id, assigned }) => apiRequest(assigned ? "DELETE" : "POST", `/api/projects/cards/${card.id}/assignees`, { identity_id: id }),
    onSuccess: refresh, onError: reportError,
  });
  if (!card) return null;
  const cardDetails = details.data;
  const liveCard = { ...card, ...cardDetails?.card };
  const appliedLabels = liveCard.project_card_label || [];
  const assignees = liveCard.project_card_assignee || [];
  const boardLabels = [
    ...labels.filter((label) => !Object.hasOwn(labelOverrides, label.id)),
    ...Object.values(labelOverrides).filter(Boolean),
  ];
  const lookupLabel = (id) => Object.hasOwn(labelOverrides, id)
    ? labelOverrides[id] : boardLabels.find((label) => label.id === id) || getLabelById(id);
  const labelBusy = saveLabel.isPending || deleteLabel.isPending;
  const updateCover = async (cover_image) => {
    // CardCoverSection/Attachments own the error UI. Preserve rejection so
    // they never emit a success toast for a failed PATCH.
    await onUpdate({ cover_image });
    queryClient.setQueryData(["card-detail", card.id], (old) => ({
      ...old, card: { ...(old?.card || liveCard), cover_image },
    }));
  };
  const save = async () => {
    if (!canEdit || saving) return;
    setSaving(true);
    try {
      const changes = Object.fromEntries([...dirtyFields.current].filter((key) => key !== "list_id")
        .map((key) => [key, ["start_date", "due_date"].includes(key) ? editedCard[key] || null : editedCard[key]]));
      if (Object.keys(changes).length) await onUpdate(changes);
      if (dirtyFields.current.has("list_id") && editedCard.list_id && editedCard.list_id !== liveCard.list_id) {
        await apiRequest("POST", `/api/projects/cards/${card.id}/move`, { list_id: editedCard.list_id, position: 0 });
      }
      await refresh();
      onOpenChange(false);
    } catch (error) { reportError(error); } finally { setSaving(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent data-testid="card-detail-modal" className="flex max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-[1180px] flex-col gap-0 overflow-hidden rounded-xl p-0">
      <CardCoverSection presentation="header" cardId={card.id} coverImage={liveCard.cover_image} attachments={cardDetails?.attachments || []} canEdit={canEdit} onCoverChange={updateCover} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[minmax(0,1.45fr)_minmax(320px,1fr)] md:overflow-hidden">
        <section aria-label="Card details" className="min-w-0 px-5 pb-6 pt-8 md:overflow-y-auto md:px-8">
          <DialogHeader className="text-left">
            <DialogTitle className="flex items-start gap-3">
              <button type="button" role="checkbox" aria-label="Mark card complete" aria-checked={Boolean(editedCard.is_complete)} data-testid="button-toggle-card-complete" disabled={!canEdit || saving} onClick={() => editField("is_complete", !editedCard.is_complete)} className={`mt-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default ${editedCard.is_complete ? "border-[#5a7f23] bg-[#5a7f23] text-white" : "border-muted-foreground/50 bg-background text-muted-foreground hover:border-[#5a7f23]"}`}>
                {editedCard.is_complete && <Check aria-hidden="true" className="h-4 w-4" strokeWidth={3} />}
              </button>
              {canEdit ? <Textarea aria-label="Card title" data-testid="input-card-title" value={editedCard.title || ""} disabled={saving} onChange={(event) => editField("title", event.target.value)} rows={2} className={`min-h-[72px] resize-none border-transparent bg-transparent px-2 text-xl md:text-xl font-semibold leading-snug shadow-none focus-visible:border-input ${editedCard.is_complete ? "line-through text-muted-foreground" : ""}`} />
                : <span className={`py-2 text-xl leading-snug ${liveCard.is_complete ? "line-through text-muted-foreground" : ""}`}>{liveCard.title}</span>}
            </DialogTitle>
            <DialogDescription className="pl-8">Project task details, dates and attachments.</DialogDescription>
          </DialogHeader>
          {details.error && <div className="mt-4"><TaskError error={details.error} onRetry={() => details.refetch()} /></div>}
          <div className="mt-6 space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label>List / task status</Label><Select disabled={!canEdit || saving} value={editedCard.list_id || liveCard.list_id} onValueChange={(value) => editField("list_id", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{lists.map((list) => <SelectItem key={list.id} value={list.id}>{list.name}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label>Priority</Label><Select disabled={!canEdit || saving} value={editedCard.priority || "none"} onValueChange={(value) => editField("priority", value)}><SelectTrigger data-testid="select-priority"><SelectValue /></SelectTrigger><SelectContent>{["none", "low", "medium", "high", "urgent"].map((priority) => <SelectItem key={priority} value={priority}>{priority}</SelectItem>)}</SelectContent></Select></div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {["start_date", "due_date"].map((key) => <div key={key} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor={`card-${key}`} className="flex items-center gap-2"><Calendar className="h-4 w-4 text-muted-foreground" />{key === "start_date" ? "Start date" : "Due date"}</Label>
                  {key === "due_date" && editedCard.is_complete && <span data-testid="card-complete-pill" className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold text-white bg-[#5a7f23]"><Check aria-hidden="true" className="h-3 w-3" />Complete</span>}
                </div>
                {canEdit ? <Input id={`card-${key}`} type="date" data-testid={`input-${key.replace("_", "-")}`} value={editedCard[key] || ""} disabled={saving} onChange={(event) => editField(key, event.target.value)} />
                  : <p className="text-sm">{dateText(liveCard[key], "MMM d, yyyy") || "Not set"}</p>}
              </div>)}
            </div>
            <div>
              <Label className="flex items-center gap-2"><Tag className="h-4 w-4 text-muted-foreground" />Labels</Label>
              <div className="mt-2 flex flex-wrap items-center gap-2">{appliedLabels.map((item) => {
                const label = lookupLabel(item.label_id);
                return label && <Badge key={label.id} style={{ backgroundColor: label.color }} className="px-2 py-1 text-white">
                  <button disabled={!canEdit || toggleLabel.isPending} onClick={() => toggleLabel.mutate({ id: label.id, applied: true })} aria-label={canEdit ? `Remove label ${label.name}` : label.name} className="flex items-center gap-1">{label.name}{canEdit && <X className="h-3 w-3" />}</button>
                </Badge>;
              })}
                {!appliedLabels.some((item) => lookupLabel(item.label_id)) && <span className="text-sm text-muted-foreground">No labels</span>}
                {(canEdit || canManageLabels) && <Button variant="outline" size="sm" aria-label="Add label" data-testid="button-add-label" onClick={() => setShowLabelPicker(!showLabelPicker)} aria-expanded={showLabelPicker}><Tag className="mr-1.5 h-3.5 w-3.5" />{canEdit ? "Labels" : "Manage labels"}</Button>}
              </div>
              {showLabelPicker && (canEdit || canManageLabels) && <div className="mt-3 rounded-lg border bg-background p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Board labels</p>
                {!boardLabels.length && <p className="mb-3 text-sm text-muted-foreground">No labels on this board yet.{canManageLabels ? " Create one to organise your cards." : ""}</p>}
                <div className="space-y-1">{boardLabels.map((label) => {
                  const applied = appliedLabels.some((item) => item.label_id === label.id);
                  return <div key={label.id} className="flex items-center gap-1">
                    <Button className="h-auto min-h-9 flex-1 justify-start gap-2 whitespace-normal text-left" variant="ghost" size="sm" disabled={!canEdit || toggleLabel.isPending || labelBusy} onClick={() => toggleLabel.mutate({ id: label.id, applied })} aria-pressed={applied}>
                      <span className="h-4 w-6 shrink-0 rounded-sm" style={{ backgroundColor: label.color }} />{label.name}{applied && <Check className="ml-auto h-4 w-4 shrink-0" />}
                    </Button>
                    {canManageLabels && <>
                      <Button variant="ghost" size="icon" disabled={labelBusy} aria-label={`Edit ${label.name}`} onClick={() => setEditingLabel({ id: label.id, name: label.name, color: label.color })}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" disabled={labelBusy || toggleLabel.isPending} aria-label={`Delete label ${label.name}`} onClick={() => {
                        if (window.confirm(`Delete the board label "${label.name}"? It will be removed from all cards on this board. This cannot be undone.`)) deleteLabel.mutate(label.id);
                      }}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                    </>}
                  </div>;
                })}</div>
                {canManageLabels && !editingLabel && <Button variant="outline" size="sm" className="mt-3" disabled={labelBusy} data-testid="button-create-label" onClick={() => setEditingLabel({ name: "", color: LABEL_COLORS[5] })}><Plus className="mr-1 h-4 w-4" />Create board label</Button>}
                {canManageLabels && editingLabel && <div className="mt-3 space-y-3 border-t pt-3">
                  <Label htmlFor="board-label-name">{editingLabel.id ? "Edit board label" : "New board label"}</Label>
                  <Input id="board-label-name" aria-label="Label name" value={editingLabel.name} disabled={labelBusy} onChange={(event) => setEditingLabel({ ...editingLabel, name: event.target.value })} />
                  <div className="flex flex-wrap gap-2" aria-label="Label colours">{LABEL_COLORS.map((color) => <button key={color} disabled={labelBusy} aria-label={`Label colour ${color}`} aria-pressed={editingLabel.color === color} className={`flex h-7 w-7 items-center justify-center rounded border-2 ${editingLabel.color === color ? "border-foreground" : "border-transparent"}`} style={{ backgroundColor: color }} onClick={() => setEditingLabel({ ...editingLabel, color })}>{editingLabel.color === color && <Check className="h-4 w-4 text-white" />}</button>)}</div>
                  <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={labelBusy} onClick={() => setEditingLabel(null)}>Cancel</Button><Button size="sm" disabled={!editingLabel.name.trim() || labelBusy} data-testid="button-save-label" onClick={() => saveLabel.mutate(editingLabel)}>{saveLabel.isPending ? "Saving…" : "Save label"}</Button></div>
                </div>}
              </div>}
            </div>
            <div>
              <Label className="flex items-center gap-2"><Users className="h-4 w-4 text-muted-foreground" />Assignees</Label>
              <div className="mt-2 flex flex-wrap items-center gap-2">{assignees.map((item) => {
                const member = getMemberById(item.identity_id);
                return <button key={item.identity_id} disabled={!canAssign || toggleAssignee.isPending} aria-label={canAssign ? `Unassign ${personName(member)}` : personName(member)} className="flex items-center gap-1 rounded-full bg-muted px-3 py-1.5 text-xs" onClick={() => toggleAssignee.mutate({ id: item.identity_id, assigned: true })}>{personName(member)}{canAssign && <X className="h-3 w-3" />}</button>;
              })}
                {!assignees.length && <span className="text-sm text-muted-foreground">Unassigned</span>}
                {canAssign && <Button variant="outline" size="sm" aria-label="Add assignee" data-testid="button-add-assignee" aria-expanded={showMemberPicker} onClick={() => setShowMemberPicker(!showMemberPicker)}><Plus className="h-4 w-4" /></Button>}
              </div>
              {showMemberPicker && canAssign && <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2">
                {!members.length && <p className="p-2 text-sm text-muted-foreground">No board members available.</p>}
                {members.map((member) => <Button key={member.identity_id} variant="ghost" size="sm" className="h-auto w-full justify-start whitespace-normal" disabled={toggleAssignee.isPending} onClick={() => toggleAssignee.mutate({ id: member.identity_id, assigned: assignees.some((item) => item.identity_id === member.identity_id) })}>{personName(member)}{assignees.some((item) => item.identity_id === member.identity_id) && <Check className="ml-auto h-4 w-4" />}</Button>)}
              </div>}
            </div>
            <div><Label htmlFor="card-description" className="text-sm font-semibold">Description</Label>
              {canEdit ? <Textarea id="card-description" data-testid="input-card-description" disabled={saving} value={editedCard.description || ""} onChange={(event) => editField("description", event.target.value)} placeholder="Add a more detailed description..." rows={5} className="mt-2" />
                : <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{liveCard.description || "No description"}</p>}
            </div>
            <CardAttachments cardId={card.id} attachments={cardDetails?.attachments || []} coverImage={liveCard.cover_image} canEdit={canEdit} onCoverChange={updateCover} />
          </div>
        </section>
        <aside aria-label="Comments and activity" className="min-w-0 border-t bg-muted/40 px-5 py-6 md:overflow-y-auto md:border-l md:border-t-0 md:px-6 md:pt-9">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><MessageSquare className="h-4 w-4" />Comments and activity</h2>
            <Button variant="outline" size="sm" aria-expanded={showActivity} onClick={() => setShowActivity(!showActivity)}>{showActivity ? "Hide activity" : "Show activity"}</Button>
          </div>
          {canEdit && <div className="mb-6 space-y-2">
            <BoardMentionTextarea aria-label="Write a comment" data-testid="input-new-comment" value={newComment} disabled={addComment.isPending} onChange={setNewComment} mentions={commentMentions} onMentionsChange={setCommentMentions} members={members} placeholder="Write a comment..." rows={3} className="bg-background" />
            <div className="flex justify-end"><Button size="sm" data-testid="button-add-comment" disabled={!newComment.trim() || addComment.isPending} onClick={() => addComment.mutate({ content: newComment, mentionIdentityIds: mentionIdentityIds(newComment, commentMentions, members) })}>{addComment.isPending ? "Posting…" : "Submit"}</Button></div>
          </div>}
          {details.isLoading ? <div role="status" aria-label="Loading comments and activity" className="space-y-4">{[0, 1, 2].map((index) => <div key={index} className="h-20 animate-pulse rounded-lg bg-muted" />)}</div>
            : <div className="space-y-5">
              {!cardDetails?.comments?.length && <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground"><p className="font-medium text-foreground">No comments yet</p><p className="mt-1">Keep updates and decisions with this task.</p></div>}
              {(cardDetails?.comments || []).map((comment) => {
                // Card detail GET returns raw rows; author is only enriched by
                // the comments endpoint. Resolve raw identity_id via board members.
                const author = comment.author || getMemberById(comment.identity_id);
                return <div key={comment.id} className="flex gap-3">
                  <Avatar className="h-8 w-8 shrink-0"><AvatarImage src={author?.avatar_url} /><AvatarFallback className="text-xs">{author?.first_name?.[0] || "B"}{author?.last_name?.[0] || "M"}</AvatarFallback></Avatar>
                  <div className="min-w-0 flex-1"><p className="text-sm font-medium">{personName(author)}</p><time className="text-xs text-muted-foreground">{dateText(comment.created_at)}</time><p className="mt-2 whitespace-pre-wrap break-words rounded-lg border bg-background p-3 text-sm leading-relaxed shadow-sm">{comment.content}</p></div>
                </div>;
              })}
              {showActivity && <div className="space-y-4 border-t pt-5">
                <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><History className="h-3.5 w-3.5" />Activity</h3>
                {!cardDetails?.activity?.length && <p className="text-sm text-muted-foreground">No activity recorded yet.</p>}
                {(cardDetails?.activity || []).map((activity) => {
                  const actor = getMemberById(activity.identity_id);
                  return <div key={activity.id} data-testid="card-activity-entry" className="flex gap-3 text-sm">
                    <Avatar className="h-7 w-7 shrink-0"><AvatarImage src={actor?.avatar_url} /><AvatarFallback className="text-[10px]">{actor?.first_name?.[0] || "B"}{actor?.last_name?.[0] || "M"}</AvatarFallback></Avatar>
                    <div className="min-w-0"><p className="break-words leading-relaxed"><span className="font-medium">{personName(actor)}</span> {activityText(activity, lists, getMemberById)}.</p><time className="text-xs text-muted-foreground">{dateText(activity.created_at)}</time></div>
                  </div>;
                })}
              </div>}
            </div>}
        </aside>
      </div>
      <DialogFooter className="shrink-0 gap-2 border-t bg-background px-5 py-4 sm:items-center md:px-8">
        {canManage && <Button variant="ghost" size="sm" data-testid="button-delete-card" className="text-destructive sm:mr-auto" disabled={saving} onClick={async () => {
          if (window.confirm("Delete this card? This cannot be undone.")) {
            try { await onDelete(); } catch (error) { reportError(error); }
          }
        }}><Trash2 className="mr-2 h-4 w-4" />Delete card</Button>}
        <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>{canEdit ? "Cancel" : "Close"}</Button>
        {canEdit && <Button data-testid="button-save-card" disabled={!editedCard.title?.trim() || saving} onClick={save}>{saving ? "Saving…" : "Save changes"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
