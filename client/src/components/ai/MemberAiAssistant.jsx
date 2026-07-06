import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getActiveTenantId } from "@/api/base44Client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  Sparkles,
  ArrowRight,
  Loader2,
  FileText,
  CalendarDays,
  Newspaper,
  BookOpen,
} from "lucide-react";
import dougalAvatar from "@assets/ChatGPT_Image_Jul_4,_2026,_06_26_22_PM_1783182456658.png";

const TYPE_ICON = {
  resource: FileText,
  event: CalendarDays,
  complex_event: CalendarDays,
  news_post: Newspaper,
  blog_post: BookOpen,
};

async function askMemberAi({ question, history }) {
  const tenantId = getActiveTenantId();
  const res = await fetch("/api/member-ai/ask", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(tenantId ? { "X-Tenant-Id": tenantId } : {}),
    },
    body: JSON.stringify({ question, history }),
  });
  if (!res.ok) {
    let message = "We couldn't answer that right now. Please try again.";
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // keep default
    }
    throw new Error(message);
  }
  return res.json();
}

export default function MemberAiAssistant({ open, onOpenChange }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState([]); // { role: 'user'|'assistant', content, sources? }
  const scrollRef = useRef(null);

  const { data: persona } = useQuery({
    queryKey: ["/ai-help-persona"],
    queryFn: async () => {
      const res = await fetch("/api/public/ai-help-persona", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load assistant");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const aiName = (persona?.name || "Dougal").trim() || "Dougal";
  const aiAvatarUrl = persona?.avatarUrl || dougalAvatar;
  const aiInitial = aiName.charAt(0).toUpperCase();
  const aiDescription = (persona?.description || "").trim();

  const askMutation = useMutation({
    mutationFn: askMemberAi,
    onSuccess: (data, variables) => {
      setTurns((prev) => [
        ...prev,
        { role: "user", content: variables.question },
        {
          role: "assistant",
          content: data.answer,
          sources: Array.isArray(data.sources) ? data.sources : [],
        },
      ]);
    },
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, askMutation.isPending]);

  const handleAsk = (e) => {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 3 || askMutation.isPending) return;
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    askMutation.mutate({ question: q, history });
    setQuestion("");
  };

  const isEmpty = turns.length === 0 && !askMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] max-h-[85vh] w-[95vw] max-w-3xl flex-col gap-0 overflow-hidden p-0"
        data-testid="dialog-member-ai"
      >
        <DialogHeader className="border-b bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-5 text-left">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Avatar className="h-12 w-12">
                <AvatarImage src={aiAvatarUrl} alt={aiName} />
                <AvatarFallback>{aiInitial}</AvatarFallback>
              </Avatar>
              <span className="absolute -bottom-1 -right-1 rounded-full bg-primary p-1 text-primary-foreground">
                <Sparkles className="h-3 w-3" />
              </span>
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-lg" data-testid="text-member-ai-title">
                Ask {aiName}
              </DialogTitle>
              <DialogDescription className="mt-0.5">
                {aiDescription ||
                  "Your AI guide to everything in the member portal."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div
          ref={scrollRef}
          className="flex-1 space-y-4 overflow-y-auto p-5"
          data-testid="member-ai-thread"
        >
          {isEmpty && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="rounded-full bg-primary/10 p-4 text-primary">
                <Sparkles className="h-7 w-7" />
              </div>
              <p className="max-w-md text-muted-foreground">
                Ask me about events, resources, news, or articles available to
                you. For example, "What events are coming up?" or "Where can I
                find the onboarding guide?"
              </p>
            </div>
          )}

          {turns.map((turn, i) =>
            turn.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div
                  className="max-w-[85%] rounded-md bg-primary px-4 py-2 text-primary-foreground"
                  data-testid={`member-ai-user-${i}`}
                >
                  <p className="whitespace-pre-wrap leading-relaxed">
                    {turn.content}
                  </p>
                </div>
              </div>
            ) : (
              <div key={i} className="flex items-start gap-3">
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarImage src={aiAvatarUrl} alt={aiName} />
                  <AvatarFallback>{aiInitial}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div
                    className="rounded-md bg-muted px-4 py-2"
                    data-testid={`member-ai-answer-${i}`}
                  >
                    <p className="whitespace-pre-wrap leading-relaxed text-foreground">
                      {turn.content}
                    </p>
                  </div>
                  {Array.isArray(turn.sources) && turn.sources.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Sources
                      </p>
                      {turn.sources.map((source, si) => {
                        const Icon = TYPE_ICON[source.type] || BookOpen;
                        const inner = (
                          <>
                            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="truncate">{source.title}</span>
                            {source.typeLabel && (
                              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                                {source.typeLabel}
                              </span>
                            )}
                          </>
                        );
                        return source.link ? (
                          <Link
                            key={si}
                            to={source.link}
                            onClick={() => onOpenChange(false)}
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-foreground hover-elevate"
                            data-testid={`link-member-ai-source-${i}-${si}`}
                          >
                            {inner}
                          </Link>
                        ) : (
                          <div
                            key={si}
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground"
                          >
                            {inner}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )
          )}

          {askMutation.isPending && (
            <div className="flex items-start gap-3" data-testid="member-ai-loading">
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarImage src={aiAvatarUrl} alt={aiName} />
                <AvatarFallback>{aiInitial}</AvatarFallback>
              </Avatar>
              <div className="flex-1 space-y-2 rounded-md bg-muted px-4 py-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          )}

          {askMutation.isError && !askMutation.isPending && (
            <p
              className="text-sm text-muted-foreground"
              data-testid="member-ai-error"
            >
              {askMutation.error?.message ||
                "We couldn't answer that right now. Please try again."}
            </p>
          )}
        </div>

        <form
          onSubmit={handleAsk}
          className="flex flex-wrap items-center gap-2 border-t p-4"
        >
          <Input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={`Ask ${aiName} anything...`}
            className="min-w-0 flex-1"
            autoFocus
            data-testid="input-member-ai-ask"
          />
          <Button
            type="submit"
            disabled={question.trim().length < 3 || askMutation.isPending}
            data-testid="button-member-ai-send"
          >
            {askMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRight className="h-4 w-4" />
            )}
            Ask
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
