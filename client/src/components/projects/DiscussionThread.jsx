import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CornerDownRight, Pencil, SmilePlus, Trash2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import ActivityComposer from "./ActivityComposer";
import { publishProjectDiscussion } from "@/lib/projectBoardCache";
import DiscussionRenderer from "./DiscussionRenderer";
import { DISCUSSION_EMOJIS, groupDiscussion } from "./discussionFormat.mjs";
import "./discussion.css";

const displayName = (person, fallback = "Board member") =>
  [person?.first_name, person?.last_name].filter(Boolean).join(" ").trim() || person?.name || person?.email || fallback;
const identityName = (id, members) => {
  const member = members.find((item) => String(item.identity_id) === String(id));
  return displayName(member, "Board member");
};
const timestamp = (value) => value && !Number.isNaN(new Date(value).getTime())
  ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const dateOrder = (a, b) => {
  const timeA = new Date(a.created_at || 0).getTime() || 0;
  const timeB = new Date(b.created_at || 0).getTime() || 0;
  return timeA - timeB || String(a.id).localeCompare(String(b.id));
};

export default function DiscussionThread({ comments = [], cardId, boardId, members = [], canWrite, drafts, refresh }) {
  const threads = useMemo(() => groupDiscussion(comments).sort((a, b) => dateOrder(b, a))
    .map((root) => ({ ...root, replies: root.replies.sort(dateOrder) })), [comments]);
  if (!threads.length) return <div className="rounded-lg border border-dashed border-border/80 bg-background/60 p-4 text-sm">
    <p className="font-medium text-foreground">No comments yet</p><p className="mt-1 text-muted-foreground">Keep updates and decisions with this task.</p>
  </div>;
  return <div className="space-y-4" aria-label="Discussion threads">
    {threads.map((root) => <DiscussionCard key={root.id} comment={root} depth={0} cardId={cardId} boardId={boardId}
      members={members} canWrite={canWrite} drafts={drafts} refresh={refresh} />)}
  </div>;
}

function DiscussionCard({ comment, depth, cardId, boardId, members, canWrite, drafts, refresh }) {
  const queryClient = useQueryClient();
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [retryReaction, setRetryReaction] = useState(null);
  const [reactorsOpen, setReactorsOpen] = useState(false);
  const author = comment.author || members.find((member) => String(member.identity_id) === String(comment.identity_id));
  const name = displayName(author);
  const editable = Boolean(canWrite && comment.can_edit);

  const publish = async (result) => {
    await publishProjectDiscussion(queryClient, boardId, cardId, result);
    void refresh?.();
  };
  const remove = async () => {
    if (!editable || busyRef.current) return;
    const promotion = depth === 0 && comment.replies?.length > 0
      ? ` Deleting this thread starter will promote “${displayName(comment.replies[0].author, comment.replies[0].reply_to_name || "the earliest reply")}” and keep the rest of the conversation.`
      : "";
    if (!window.confirm(`Delete this comment?${promotion} This cannot be undone.`)) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const result = await apiRequest("DELETE", `/api/projects/cards/${cardId}/comments`, { commentId: comment.id });
      await publish(result);
    } catch (failure) { setError(failure.message || "Could not delete comment. Try again."); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const sendReaction = async (emoji, desired) => {
    if (!canWrite || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setRetryReaction(null);
    try {
      const result = await apiRequest("PUT", `/api/projects/cards/${cardId}/comments`, {
        commentId: comment.id, emoji: desired,
      });
      await publish(result);
      setShowReactions(false);
    } catch (failure) {
      setError(failure.message || "Could not update reaction. Try again.");
      setRetryReaction({ emoji, desired });
    } finally { busyRef.current = false; setBusy(false); }
  };
  const setReaction = (emoji) => {
    const selected = comment.reactions?.find((item) => item.selected)?.emoji;
    return sendReaction(emoji, selected === emoji ? null : emoji);
  };
  const photos = comment.images || [];
  return <article className={`discussion-comment${depth ? " is-reply" : ""}`} data-comment-id={comment.id}>
    <div className="flex gap-2.5">
      <Avatar className={`${depth ? "h-7 w-7" : "h-8 w-8"} shrink-0`}>
        <AvatarImage src={author?.avatar_url} /><AvatarFallback className="text-[10px]">{name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold">{name}</span>
          <time className="text-[11px] text-muted-foreground" dateTime={comment.created_at || undefined}>{timestamp(comment.created_at)}</time>
          {comment.edited_at && <span className="text-[10px] text-muted-foreground">(edited)</span>}
        </div>
        {depth > 0 && comment.reply_to_name && <p className="mt-0.5 text-[11px] text-muted-foreground">Replying to {comment.reply_to_name}</p>}
        {editing ? <div className="mt-2">
          <ActivityComposer cardId={cardId} boardId={boardId} members={members} drafts={drafts} refresh={refresh}
            mode="edit" targetComment={comment} compact onCancel={() => setEditing(false)} onSuccess={() => setEditing(false)} />
        </div> : <div className="mt-1.5 rounded-lg border border-border/70 bg-background px-3 py-2.5 text-sm shadow-[0_1px_2px_hsl(var(--foreground)/.035)]">
          <DiscussionRenderer richContent={comment.rich_content} content={comment.content || ""} attachments={photos} />
        {!comment.rich_content && photos.map((item) => {
            const image = item?.attachment;
            if (!image || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.file_type) ||
              !/^(https?:\/\/|\/(?!\/))/i.test(image.url || "")) return null;
            return <a key={image.id} href={image.url} target="_blank" rel="noopener noreferrer" className="mt-2 block">
              <img src={image.url} alt={image.name || "Comment image"} loading="lazy" className="max-h-64 max-w-full rounded-md border object-contain" />
            </a>;
          })}
          {!comment.content && !comment.rich_content && !photos.length && <span className="text-muted-foreground">Image attachment removed.</span>}
        </div>}
        {comment.reactions?.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5">
          {comment.reactions.map((reaction) => {
            const names = reaction.reactors?.map((reactor) => reactor.name || identityName(reactor.id, members)) || [];
            return <button key={reaction.emoji} type="button"
              aria-label={`${reaction.emoji}, ${reaction.count} ${reaction.count === 1 ? "reaction" : "reactions"}; show reactors${names.length ? `: ${names.join(", ")}` : ""}`}
              title={names.length ? names.join(", ") : `${reaction.count} reactions`}
              aria-expanded={reactorsOpen} onClick={() => setReactorsOpen((value) => !value)}
              className={`discussion-reaction${reaction.selected ? " is-selected" : ""}`}>
              <span aria-hidden="true">{reaction.emoji}</span><span>{reaction.count}</span>
            </button>;
          })}
        </div>}
        {reactorsOpen && comment.reactions?.some((reaction) => reaction.reactors?.length) && <div className="mt-1 rounded-md border bg-background px-2.5 py-2 text-xs" role="status" aria-label="People who reacted">
          {comment.reactions.filter((reaction) => reaction.reactors?.length).map((reaction) =>
            <p key={reaction.emoji}><span aria-hidden="true">{reaction.emoji}</span> {reaction.reactors.map((reactor) => reactor.name || identityName(reactor.id, members)).join(", ")}</p>)}
        </div>}
        {canWrite && !editing && <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" disabled={busy}
            onClick={() => { setReplying((value) => !value); setEditing(false); }}><CornerDownRight className="mr-1 h-3.5 w-3.5" />Reply</Button>
          <div className="relative">
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" disabled={busy} aria-label="Add reaction" aria-expanded={showReactions} onClick={() => setShowReactions((value) => !value)}><SmilePlus className="h-4 w-4" /></Button>
            {showReactions && <div className="discussion-reaction-picker" role="group" aria-label="Choose a reaction">
              {DISCUSSION_EMOJIS.map((emoji) => <button key={emoji} type="button" disabled={busy} aria-label={`React with ${emoji}`} onClick={() => setReaction(emoji)}>{emoji}</button>)}
            </div>}
          </div>
          {editable && <>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" disabled={busy} aria-label="Edit comment" onClick={() => { setEditing(true); setReplying(false); }}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" disabled={busy} aria-label="Delete comment" onClick={remove}><Trash2 className="h-3.5 w-3.5" /></Button>
          </>}
        </div>}
        {error && <div className="mt-1 flex flex-wrap items-center gap-2"><p role="alert" className="text-xs text-destructive">{error}</p>
          {retryReaction && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => sendReaction(retryReaction.emoji, retryReaction.desired)}>Retry reaction</Button>}
        </div>}
        {replying && canWrite && <div className="mt-2">
          <ActivityComposer cardId={cardId} boardId={boardId} members={members} drafts={drafts} refresh={refresh}
            mode="reply" targetComment={comment} compact onCancel={() => setReplying(false)} onSuccess={() => setReplying(false)} />
        </div>}
        {(comment.replies || []).length > 0 && <div className="mt-3 space-y-3 border-l border-border/80 pl-3">
          {(comment.replies || []).map((reply) => <DiscussionCard key={reply.id} comment={reply} depth={depth + 1} cardId={cardId}
            boardId={boardId} members={members} canWrite={canWrite} drafts={drafts} refresh={refresh} />)}
        </div>}
      </div>
    </div>
  </article>;
}
