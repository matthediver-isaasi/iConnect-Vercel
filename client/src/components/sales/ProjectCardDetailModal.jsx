import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Check, Loader2, MessageSquare, Pencil, Plus, Tag, Trash2, Users, X } from "lucide-react";
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
import { projectTaskRequest, refreshSalesProjects } from "./useSalesProjectTasks";
import { TaskError } from "./SalesProjectTaskStates";

const LABEL_COLORS = ["#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#ec4899", "#f43f5e", "#78716c"];

// Focused shared version of ProjectBoard's card editor. Both Board and Sales
// must import this component; it has no dependency on either page.
export default function CardDetailModal({
  card, open, onOpenChange, boardId, labels = [], members = [], lists = [],
  canEdit, canManage, canAssign = canEdit, canManageLabels = canManage, onUpdate, onDelete,
  getLabelById = (id) => labels.find((label) => label.id === id),
  getMemberById = (id) => members.find((member) => member.identity_id === id),
}) {
  const [editedCard, setEditedCard] = useState({});
  const [newComment, setNewComment] = useState("");
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [showMemberPicker, setShowMemberPicker] = useState(false);
  const [editingLabel, setEditingLabel] = useState(null);
  const [saving, setSaving] = useState(false);
  const initialized = useRef(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!open) { initialized.current = null; setEditingLabel(null); setShowMemberPicker(false); setShowLabelPicker(false); return; }
    if (card && initialized.current !== card.id) {
      initialized.current = card.id;
      setEditedCard({ title: card.title, description: card.description || "", due_date: card.due_date?.split("T")[0] || "", priority: card.priority || "none", is_complete: Boolean(card.is_complete), list_id: card.list_id });
      setNewComment("");
    }
  }, [card, open]);
  const details = useQuery({
    queryKey: ["card-detail", card?.id],
    queryFn: () => projectTaskRequest(`/api/projects/cards/${card.id}`),
    enabled: Boolean(card?.id && open), refetchOnWindowFocus: true,
  });
  const refresh = () => refreshSalesProjects(queryClient);
  const reportError = (error) => toast.error(error.message || "Could not update card");
  const addComment = useMutation({
    mutationFn: (content) => apiRequest("POST", `/api/projects/cards/${card.id}/comments`, { content }),
    onSuccess: () => { setNewComment(""); refresh(); }, onError: reportError,
  });
  const toggleLabel = useMutation({
    mutationFn: ({ id, applied }) => apiRequest(applied ? "DELETE" : "POST", `/api/projects/cards/${card.id}/labels`, { label_id: id }),
    onSuccess: refresh, onError: reportError,
  });
  const renameLabel = useMutation({
    mutationFn: (data) => apiRequest("PATCH", `/api/projects/boards/${boardId}/labels`, data),
    onSuccess: () => { setEditingLabel(null); refresh(); }, onError: reportError,
  });
  const toggleAssignee = useMutation({
    mutationFn: ({ id, assigned }) => apiRequest(assigned ? "DELETE" : "POST", `/api/projects/cards/${card.id}/assignees`, { identity_id: id }),
    onSuccess: refresh, onError: reportError,
  });
  if (!card) return null;
  const cardDetails = details.data;
  const appliedLabels = cardDetails?.card?.project_card_label || card.project_card_label || [];
  const assignees = cardDetails?.card?.project_card_assignee || card.project_card_assignee || [];
  const save = async () => {
    setSaving(true);
    try {
      const { list_id, ...data } = editedCard;
      await onUpdate({ ...data, due_date: data.due_date || null });
      if (list_id && list_id !== card.list_id) await apiRequest("POST", `/api/projects/cards/${card.id}/move`, { list_id, position: 0 });
      await refresh();
      onOpenChange(false);
    } catch (error) { reportError(error); } finally { setSaving(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto p-0">
    {card.cover_image && <img src={card.cover_image} alt="" className="h-40 w-full object-cover" />}
    <div className="p-6"><DialogHeader>
      <DialogTitle className="flex items-start gap-3">
        <input aria-label="Mark card complete" type="checkbox" checked={Boolean(editedCard.is_complete)} disabled={!canEdit || saving} onChange={(event) => setEditedCard({ ...editedCard, is_complete: event.target.checked })} className="mt-1 h-5 w-5" />
        {canEdit ? <Input aria-label="Card title" data-testid="input-card-title" value={editedCard.title || ""} onChange={(event) => setEditedCard({ ...editedCard, title: event.target.value })} className="text-lg font-semibold" /> : <span className={card.is_complete ? "line-through text-muted-foreground" : ""}>{card.title}</span>}
      </DialogTitle><DialogDescription>Project task details, comments and attachments.</DialogDescription>
    </DialogHeader>
    {details.error && <div className="mt-4"><TaskError error={details.error} onRetry={() => details.refetch()} /></div>}
    <div className="mt-4 grid gap-6 sm:grid-cols-3">
      <div className="space-y-4 sm:col-span-2">
        <CardCoverSection cardId={card.id} coverImage={card.cover_image} attachments={cardDetails?.attachments || []} canEdit={canEdit} onCoverChange={(cover_image) => Promise.resolve(onUpdate({ cover_image })).catch(reportError)} />
        <div><Label>Description</Label>{canEdit ? <Textarea data-testid="input-card-description" value={editedCard.description || ""} onChange={(event) => setEditedCard({ ...editedCard, description: event.target.value })} placeholder="Add a more detailed description..." rows={4} className="mt-1" /> : <p className="mt-1 text-sm text-muted-foreground">{card.description || "No description"}</p>}</div>
        <CardAttachments cardId={card.id} attachments={cardDetails?.attachments || []} coverImage={card.cover_image} canEdit={canEdit} onCoverChange={(cover_image) => Promise.resolve(onUpdate({ cover_image })).catch(reportError)} />
        <div><Label className="flex items-center gap-2"><MessageSquare className="h-4 w-4" />Comments</Label>
          <div className="mt-2 space-y-3">
            {details.isLoading && <div className="h-16 animate-pulse rounded bg-muted" />}
            {cardDetails?.comments?.map((comment) => <div key={comment.id} className="flex gap-3">
              <Avatar className="h-8 w-8"><AvatarImage src={comment.author?.avatar_url} /><AvatarFallback>{comment.author?.first_name?.[0]}{comment.author?.last_name?.[0]}</AvatarFallback></Avatar>
              <div className="flex-1"><p className="text-sm font-medium">{comment.author?.first_name} {comment.author?.last_name}</p><p className="text-xs text-muted-foreground">{format(new Date(comment.created_at), "MMM d, h:mm a")}</p><p className="mt-1 whitespace-pre-wrap text-sm">{comment.content}</p></div>
            </div>)}
            {canEdit && <div className="flex gap-2"><Textarea data-testid="input-new-comment" value={newComment} onChange={(event) => setNewComment(event.target.value)} placeholder="Write a comment..." rows={2} /><Button size="sm" data-testid="button-add-comment" disabled={!newComment.trim() || addComment.isPending} onClick={() => addComment.mutate(newComment)}>Submit</Button></div>}
          </div>
        </div>
      </div>
      <div className="space-y-4">
        <div><Label>List / task status</Label><Select disabled={!canEdit || saving} value={editedCard.list_id || card.list_id} onValueChange={(list_id) => setEditedCard({ ...editedCard, list_id })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{lists.map((list) => <SelectItem key={list.id} value={list.id}>{list.name}</SelectItem>)}</SelectContent></Select></div>
        <div><Label className="flex items-center gap-2"><Calendar className="h-4 w-4" />Due date</Label>{canEdit ? <Input type="date" data-testid="input-due-date" value={editedCard.due_date || ""} onChange={(event) => setEditedCard({ ...editedCard, due_date: event.target.value })} className="mt-1" /> : <p className="mt-1 text-sm">{card.due_date ? format(new Date(card.due_date), "MMM d, yyyy") : "Not set"}</p>}</div>
        <div><Label>Priority</Label><Select disabled={!canEdit} value={editedCard.priority || "none"} onValueChange={(priority) => setEditedCard({ ...editedCard, priority })}><SelectTrigger data-testid="select-priority"><SelectValue /></SelectTrigger><SelectContent>{["none", "low", "medium", "high", "urgent"].map((priority) => <SelectItem key={priority} value={priority}>{priority}</SelectItem>)}</SelectContent></Select></div>
        <div><Label className="flex items-center gap-2"><Tag className="h-4 w-4" />Labels</Label>
          <div className="mt-2 flex flex-wrap gap-1">{appliedLabels.map((item) => { const label = getLabelById(item.label_id); return label && <Badge key={label.id} style={{ backgroundColor: label.color }} className="text-white"><button disabled={!canEdit || toggleLabel.isPending} onClick={() => toggleLabel.mutate({ id: label.id, applied: true })} className="flex items-center">{label.name}{canEdit && <X className="ml-1 h-3 w-3" />}</button></Badge>; })}
            {canEdit && <Button variant="outline" size="sm" aria-label="Add label" data-testid="button-add-label" onClick={() => setShowLabelPicker(!showLabelPicker)}><Plus className="h-4 w-4" /></Button>}
          </div>
          {showLabelPicker && canEdit && <div className="mt-2 space-y-1 rounded border p-2">{labels.map((label) => editingLabel?.id === label.id ? <div key={label.id} className="space-y-2">
            <Input aria-label="Label name" value={editingLabel.name} onChange={(event) => setEditingLabel({ ...editingLabel, name: event.target.value })} />
            <div className="flex flex-wrap gap-1">{LABEL_COLORS.map((color) => <button key={color} aria-label={`Label colour ${color}`} aria-pressed={editingLabel.color === color} className="h-5 w-5 rounded-full border-2" style={{ backgroundColor: color }} onClick={() => setEditingLabel({ ...editingLabel, color })} />)}</div>
            <Button size="sm" variant="ghost" onClick={() => setEditingLabel(null)}>Cancel</Button><Button size="sm" disabled={!editingLabel.name.trim() || renameLabel.isPending} onClick={() => renameLabel.mutate(editingLabel)}>Save</Button>
          </div> : <div key={label.id} className="flex gap-1"><Button className="h-auto flex-1 justify-start whitespace-normal" variant="ghost" size="sm" disabled={toggleLabel.isPending} onClick={() => toggleLabel.mutate({ id: label.id, applied: appliedLabels.some((item) => item.label_id === label.id) })}>{label.name}{appliedLabels.some((item) => item.label_id === label.id) && <Check className="ml-1 h-4 w-4" />}</Button>{canManageLabels && <Button variant="ghost" size="icon" aria-label={`Edit ${label.name}`} onClick={() => setEditingLabel({ id: label.id, name: label.name, color: label.color })}><Pencil className="h-3 w-3" /></Button>}</div>)}</div>}
        </div>
        <div><Label className="flex items-center gap-2"><Users className="h-4 w-4" />Assignees</Label>
          <div className="mt-2 flex flex-wrap gap-1">{assignees.map((item) => { const member = getMemberById(item.identity_id); return <button key={item.identity_id} disabled={!canAssign || toggleAssignee.isPending} className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs" onClick={() => toggleAssignee.mutate({ id: item.identity_id, assigned: true })}>{member?.first_name} {member?.last_name}{canAssign && <X className="h-3 w-3" />}</button>; })}
            {canAssign && <Button variant="outline" size="sm" aria-label="Add assignee" data-testid="button-add-assignee" onClick={() => setShowMemberPicker(!showMemberPicker)}><Plus className="h-4 w-4" /></Button>}
          </div>
          {showMemberPicker && canAssign && <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded border p-2">{members.map((member) => <Button key={member.identity_id} variant="ghost" size="sm" className="h-auto w-full justify-start whitespace-normal" disabled={toggleAssignee.isPending} onClick={() => toggleAssignee.mutate({ id: member.identity_id, assigned: assignees.some((item) => item.identity_id === member.identity_id) })}>{member.first_name} {member.last_name}{assignees.some((item) => item.identity_id === member.identity_id) && <Check className="ml-1 h-4 w-4" />}</Button>)}</div>}
        </div>
        {canManage && <Button variant="destructive" size="sm" data-testid="button-delete-card" className="w-full" disabled={saving} onClick={() => { if (window.confirm("Delete this card? This cannot be undone.")) onDelete(); }}><Trash2 className="mr-2 h-4 w-4" />Delete card</Button>}
      </div>
    </div>
    <DialogFooter className="mt-6"><Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>{canEdit && <Button data-testid="button-save-card" disabled={!editedCard.title?.trim() || saving} onClick={save}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save changes</Button>}</DialogFooter>
    </div>
  </DialogContent></Dialog>;
}
