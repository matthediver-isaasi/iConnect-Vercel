import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import SimpleRichTextEditor from "@/components/SimpleRichTextEditor";
import {
  Reply,
  Loader2,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  AlertCircle,
  Send,
  Mail,
} from "lucide-react";
import moment from "moment";
import { toast } from "sonner";

export function submissionRepliesQueryKey(submissionId) {
  return ["form-submission-emails", submissionId];
}

export default function SubmissionReplies({
  submissionId,
  defaultEmail = "",
  formName = "",
  buttonVariant = "outline",
  buttonSize = "sm",
}) {
  const queryClient = useQueryClient();
  const [composeOpen, setComposeOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const [toEmail, setToEmail] = useState("");
  const [ccEmail, setCcEmail] = useState("");
  const [bccEmail, setBccEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const { data: replies = [], isLoading } = useQuery({
    queryKey: submissionRepliesQueryKey(submissionId),
    queryFn: async () => {
      const rows = await base44.entities.FormSubmissionEmail.filter({
        submission_id: submissionId,
      });
      return (rows || []).sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      );
    },
    enabled: !!submissionId,
  });

  const openCompose = () => {
    setToEmail(defaultEmail || "");
    setCcEmail("");
    setBccEmail("");
    setSubject(formName ? `Re: ${formName}` : "");
    setBody("");
    setComposeOpen(true);
  };

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/forms/send-submission-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          submission_id: submissionId,
          to: toEmail.trim(),
          cc: ccEmail.trim() || undefined,
          bcc: bccEmail.trim() || undefined,
          subject: subject.trim(),
          html: body,
        }),
      });
      let payload = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      if (!res.ok) {
        const err = new Error(payload?.error || `Failed to send reply (${res.status})`);
        // A 502 means the email failed but the attempt was still persisted.
        err.persistedRecord = payload?.record || null;
        throw err;
      }
      return payload;
    },
    onSuccess: () => {
      toast.success("Reply sent");
      setComposeOpen(false);
      queryClient.invalidateQueries({
        queryKey: submissionRepliesQueryKey(submissionId),
      });
    },
    onError: (err) => {
      toast.error(err?.message || "Failed to send reply");
      // If the failed attempt was recorded server-side, surface it immediately.
      if (err?.persistedRecord) {
        setExpanded(true);
        queryClient.invalidateQueries({
          queryKey: submissionRepliesQueryKey(submissionId),
        });
      }
    },
  });

  const canSend =
    toEmail.trim() &&
    subject.trim() &&
    body.replace(/<[^>]*>/g, "").trim() &&
    !sendMutation.isPending;

  const replyCount = replies.length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={buttonVariant}
        size={buttonSize}
        onClick={openCompose}
        data-testid={`button-reply-submission-${submissionId}`}
        title="Send a reply email to the submitter"
      >
        <Reply className="w-4 h-4 mr-1" />
        Send reply
      </Button>

      {replyCount > 0 && (
        <Button
          variant="ghost"
          size={buttonSize}
          onClick={() => setExpanded((v) => !v)}
          data-testid={`button-toggle-replies-${submissionId}`}
          title="View sent replies"
        >
          <Mail className="w-4 h-4 mr-1" />
          {replyCount} {replyCount === 1 ? "reply" : "replies"}
          {expanded ? (
            <ChevronUp className="w-4 h-4 ml-1" />
          ) : (
            <ChevronDown className="w-4 h-4 ml-1" />
          )}
        </Button>
      )}

      {expanded && replyCount > 0 && (
        <div className="w-full mt-2 space-y-3" data-testid={`list-replies-${submissionId}`}>
          {replies.map((reply) => (
            <div
              key={reply.id}
              className="rounded-md border bg-muted/30 p-3"
              data-testid={`item-reply-${reply.id}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium" data-testid={`text-reply-subject-${reply.id}`}>
                    {reply.subject}
                  </span>
                  {reply.delivery_status === "failed" ? (
                    <Badge variant="destructive" className="gap-1">
                      <AlertCircle className="w-3 h-3" />
                      Failed
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="gap-1">
                      <CheckCircle className="w-3 h-3" />
                      Sent
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {moment(reply.created_at).format("MMM D, YYYY h:mm A")}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                To: {reply.to_email}
                {reply.cc_email ? ` · Cc: ${reply.cc_email}` : ""}
                {reply.bcc_email ? ` · Bcc: ${reply.bcc_email}` : ""}
                {reply.sent_by_email ? ` · From: ${reply.sent_by_email}` : ""}
              </div>
              {reply.delivery_status === "failed" && reply.delivery_error && (
                <div className="mt-1 text-xs text-destructive">
                  {reply.delivery_error}
                </div>
              )}
              {reply.body_html && (
                <div
                  className="prose prose-sm max-w-none mt-2 border-t pt-2"
                  data-testid={`text-reply-body-${reply.id}`}
                  dangerouslySetInnerHTML={{ __html: reply.body_html }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={composeOpen} onOpenChange={setComposeOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Send reply</DialogTitle>
            <DialogDescription>
              This email is sent from your organisation, with your tenant footer
              and branding applied.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={`reply-to-${submissionId}`}>To</Label>
              <Input
                id={`reply-to-${submissionId}`}
                type="email"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
                placeholder="recipient@example.com"
                data-testid="input-reply-to"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`reply-cc-${submissionId}`}>Cc (optional)</Label>
                <Input
                  id={`reply-cc-${submissionId}`}
                  value={ccEmail}
                  onChange={(e) => setCcEmail(e.target.value)}
                  placeholder="cc@example.com"
                  data-testid="input-reply-cc"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`reply-bcc-${submissionId}`}>Bcc (optional)</Label>
                <Input
                  id={`reply-bcc-${submissionId}`}
                  value={bccEmail}
                  onChange={(e) => setBccEmail(e.target.value)}
                  placeholder="bcc@example.com"
                  data-testid="input-reply-bcc"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`reply-subject-${submissionId}`}>Subject</Label>
              <Input
                id={`reply-subject-${submissionId}`}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                data-testid="input-reply-subject"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Message</Label>
              <SimpleRichTextEditor
                content={body}
                onChange={setBody}
                placeholder="Write your reply..."
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setComposeOpen(false)}
              disabled={sendMutation.isPending}
              data-testid="button-cancel-reply"
            >
              Cancel
            </Button>
            <Button
              onClick={() => sendMutation.mutate()}
              disabled={!canSend}
              data-testid="button-send-reply"
            >
              {sendMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-1" />
                  Send reply
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
