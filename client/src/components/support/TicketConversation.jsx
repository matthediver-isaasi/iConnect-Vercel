import { useState, useEffect, useRef, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Paperclip, Send, X, Loader2, RotateCcw, FileText } from "lucide-react";
import { toast } from "sonner";
import { showUploadErrorToast } from "@/lib/planQuotaError";
import { format } from "date-fns";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|$)/i;

function isImageUrl(url) {
  return IMAGE_EXT_RE.test(url || "");
}

function formatMessageTime(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return format(d, "h:mm a");
    if (d.getFullYear() === now.getFullYear()) return format(d, "MMM d, h:mm a");
    return format(d, "MMM d, yyyy h:mm a");
  } catch {
    return "";
  }
}

function AttachmentList({ attachments, align }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className={`mt-2 flex flex-wrap gap-2 ${align === "right" ? "justify-end" : ""}`}>
      {attachments.map((url, idx) =>
        isImageUrl(url) ? (
          <a key={idx} href={url} target="_blank" rel="noopener noreferrer" className="block">
            <img
              src={url}
              alt={`Attachment ${idx + 1}`}
              className="max-w-[200px] max-h-40 object-cover rounded border border-slate-200"
              data-testid={`img-attachment-${idx}`}
            />
          </a>
        ) : (
          <a
            key={idx}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-2 py-1.5 bg-white/60 dark:bg-slate-800/60 rounded border border-slate-200 dark:border-slate-700 text-xs text-blue-600 hover:underline max-w-[220px]"
            data-testid={`link-attachment-${idx}`}
          >
            <FileText className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{decodeURIComponent(url.split("/").pop() || "file")}</span>
          </a>
        )
      )}
    </div>
  );
}

function MessageBubble({ message, isOwn }) {
  return (
    <div
      className={`flex ${isOwn ? "justify-end" : "justify-start"}`}
      data-testid={`message-${message.id}`}
    >
      <div className={`max-w-[85%] sm:max-w-[75%] ${isOwn ? "items-end" : "items-start"}`}>
        <div className="flex items-baseline gap-2 mb-1 px-1 flex-wrap">
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            {message.responder_name || "Unknown"}
          </span>
          {message.is_admin_response && (
            <Badge className="bg-blue-600 text-white text-[10px] px-1.5 py-0 no-default-active-elevate">
              Staff
            </Badge>
          )}
          <span className="text-[11px] text-slate-400" data-testid={`text-time-${message.id}`}>
            {formatMessageTime(message.created_date)}
          </span>
          {message._optimistic && (
            <span className="text-[11px] text-slate-400 italic">Sending…</span>
          )}
        </div>
        <div
          className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
            isOwn
              ? "bg-blue-600 text-white"
              : message.is_admin_response
                ? "bg-blue-50 dark:bg-blue-950/40 text-slate-800 dark:text-slate-200 border border-blue-200 dark:border-blue-900"
                : "bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700"
          } ${message._optimistic ? "opacity-70" : ""}`}
        >
          {message.message}
          <AttachmentList attachments={message.attachments} />
        </div>
      </div>
    </div>
  );
}

/**
 * Chat-style support ticket conversation shared by the member view
 * (ViewSupportTicketDialog) and the admin view (SupportManagement).
 *
 * Owns: the responses query, live realtime subscriptions (per open ticket),
 * the reply mutation with optimistic append, attachment upload, auto-scroll,
 * and (member side) the reopen-on-reply behaviour for resolved/closed tickets.
 */
export default function TicketConversation({
  ticket,
  memberInfo,
  isAdminView = false,
  ticketQueryKeys = [],
  onTicketUpdated,
}) {
  const queryClient = useQueryClient();
  const [replyMessage, setReplyMessage] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const ticketId = ticket?.id;

  useEffect(() => {
    setReplyMessage("");
    setAttachments([]);
  }, [ticketId]);

  const responsesKey = ["support-responses", ticketId];

  const { data: responses = [], isLoading } = useQuery({
    queryKey: responsesKey,
    queryFn: async () => {
      const all = await base44.entities.SupportTicketResponse.list("created_date");
      return all.filter((r) => r.ticket_id === ticketId);
    },
    enabled: !!ticketId,
  });

  // Live updates: new/edited responses on this ticket
  useRealtimeSubscription("support_ticket_response", [responsesKey], {
    enabled: !!ticketId,
    filter: `ticket_id=eq.${ticketId}`,
  });

  // Live updates: ticket status / detail changes
  useRealtimeSubscription("support_ticket", ticketQueryKeys, {
    enabled: !!ticketId && ticketQueryKeys.length > 0,
    filter: `id=eq.${ticketId}`,
  });

  const messages = useMemo(() => {
    const opening = ticket
      ? [
          {
            id: `ticket-${ticket.id}`,
            message: ticket.description,
            is_admin_response: false,
            responder_name: ticket.submitter_name || "Member",
            responder_email: ticket.submitter_email,
            created_date: ticket.created_date,
            attachments: ticket.attachments || [],
            _isOpening: true,
          },
        ]
      : [];
    const sorted = [...responses].sort(
      (a, b) => new Date(a.created_date || 0) - new Date(b.created_date || 0)
    );
    return [...opening, ...sorted];
  }, [ticket, responses]);

  // Auto-scroll to the latest message
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [messages.length, ticketId]);

  const willReopen =
    !isAdminView && (ticket?.status === "resolved" || ticket?.status === "closed");

  const invalidateTicketQueries = () => {
    ticketQueryKeys.forEach((key) => queryClient.invalidateQueries({ queryKey: key }));
  };

  const sendMutation = useMutation({
    mutationFn: async ({ message, attachments: files }) => {
      const payload = {
        ticket_id: ticketId,
        message,
        is_admin_response: isAdminView,
        responder_email: memberInfo?.email || "",
        responder_name:
          `${memberInfo?.first_name || ""} ${memberInfo?.last_name || ""}`.trim() ||
          memberInfo?.email ||
          "Unknown",
      };
      if (files && files.length > 0) payload.attachments = files;
      const created = await base44.entities.SupportTicketResponse.create(payload);
      // Member replying to a resolved/closed ticket reopens it
      if (willReopen) {
        await base44.entities.SupportTicket.update(ticketId, { status: "open" });
      }
      return created;
    },
    onMutate: async ({ message, attachments: files }) => {
      await queryClient.cancelQueries({ queryKey: responsesKey });
      const previous = queryClient.getQueryData(responsesKey);
      const optimistic = {
        id: `optimistic-${Date.now()}`,
        ticket_id: ticketId,
        message,
        is_admin_response: isAdminView,
        responder_name:
          `${memberInfo?.first_name || ""} ${memberInfo?.last_name || ""}`.trim() ||
          memberInfo?.email ||
          "You",
        responder_email: memberInfo?.email || "",
        created_date: new Date().toISOString(),
        attachments: files || [],
        _optimistic: true,
      };
      queryClient.setQueryData(responsesKey, (old = []) => [...old, optimistic]);
      setReplyMessage("");
      setAttachments([]);
      return { previous, draft: { message, files } };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(responsesKey, context.previous);
      if (context?.draft) {
        setReplyMessage(context.draft.message);
        setAttachments(context.draft.files || []);
      }
      toast.error("Failed to send message");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: responsesKey });
      if (willReopen) {
        invalidateTicketQueries();
        if (onTicketUpdated) onTicketUpdated({ ...ticket, status: "open" });
        toast.success("Ticket reopened");
      }
    },
  });

  const handleSend = () => {
    const message = replyMessage.trim();
    if (!message || sendMutation.isPending) return;
    sendMutation.mutate({ message, attachments });
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileUpload = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setUploading(true);
    try {
      const urls = [];
      for (const file of files) {
        const { file_url } = await base44.integrations.Core.UploadFile({ file });
        urls.push(file_url);
      }
      setAttachments((prev) => [...prev, ...urls]);
    } catch (error) {
      showUploadErrorToast(error, "Failed to upload file");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const currentEmail = (memberInfo?.email || "").toLowerCase();
  const isOwnMessage = (m) => {
    if (isAdminView) return m.is_admin_response === true;
    if (m._isOpening) return true;
    return (
      m.is_admin_response !== true &&
      (m.responder_email || "").toLowerCase() === currentEmail
    );
  };

  if (!ticket) return null;

  return (
    <div className="flex flex-col gap-3" data-testid="ticket-conversation">
      {/* Messages */}
      <div className="space-y-4 max-h-[45vh] overflow-y-auto pr-1" data-testid="conversation-messages">
        {isLoading && responses.length === 0 ? (
          <div className="flex justify-center py-6">
            <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} isOwn={isOwnMessage(m)} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Reopen notice */}
      {willReopen && (
        <div
          className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg"
          data-testid="text-reopen-notice"
        >
          <RotateCcw className="w-4 h-4 shrink-0" />
          This ticket is {ticket.status}. Sending a reply will reopen it.
        </div>
      )}

      {/* Pending attachments */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((url, idx) => (
            <div key={idx} className="relative group">
              {isImageUrl(url) ? (
                <img
                  src={url}
                  alt={`Upload ${idx + 1}`}
                  className="w-16 h-16 object-cover rounded border border-slate-200"
                />
              ) : (
                <div className="w-40 px-2 py-1.5 rounded border border-slate-200 text-xs truncate flex items-center gap-1">
                  <FileText className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{decodeURIComponent(url.split("/").pop() || "file")}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                className="absolute -top-1.5 -right-1.5 bg-slate-700 text-white rounded-full p-0.5"
                data-testid={`button-remove-pending-${idx}`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Composer */}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFileUpload(e.target.files)}
          disabled={uploading}
          data-testid="input-conversation-file"
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          data-testid="button-attach-file"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
        </Button>
        <Textarea
          placeholder={isAdminView ? "Type your response…" : "Type your message…"}
          rows={2}
          value={replyMessage}
          onChange={(e) => setReplyMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 resize-none"
          data-testid="input-conversation-message"
        />
        <Button
          type="button"
          size="icon"
          onClick={handleSend}
          disabled={!replyMessage.trim() || sendMutation.isPending || uploading}
          className="bg-blue-600 hover:bg-blue-700"
          data-testid="button-send-message"
        >
          <Send className="w-4 h-4" />
        </Button>
      </div>
      <p className="text-[11px] text-slate-400 -mt-1">Enter to send · Shift+Enter for a new line</p>
    </div>
  );
}
