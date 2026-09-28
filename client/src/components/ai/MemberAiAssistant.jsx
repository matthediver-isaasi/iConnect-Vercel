import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/use-toast";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Sparkles,
  ArrowRight,
  Loader2,
  FileText,
  CalendarDays,
  Newspaper,
  BookOpen,
  Info,
  ShieldCheck,
  Link2,
  EyeOff,
  Plus,
  History,
  Trash2,
  MessageSquare,
  X,
} from "lucide-react";
import dougalAvatar from "@assets/ChatGPT_Image_Jul_4,_2026,_06_26_22_PM_1783182456658.png";

const TYPE_ICON = {
  resource: FileText,
  event: CalendarDays,
  complex_event: CalendarDays,
  news_post: Newspaper,
  blog_post: BookOpen,
  canvas_page: FileText,
};

const TITLE_MAX = 80;

function tenantHeaders(tenantId) {
  return {
    "Content-Type": "application/json",
    ...(tenantId ? { "X-Tenant-Id": tenantId } : {}),
  };
}

export async function askMemberAi({ question, history, tenantId, signal }) {
  const res = await fetch("/api/member-ai/ask", {
    method: "POST",
    credentials: "include",
    headers: tenantHeaders(tenantId),
    signal,
    body: JSON.stringify({ question, history }),
  });
  if (!res.ok) {
    let message = "We couldn't answer that right now. Please try again.";
    try {
      const body = await res.json();
      if (body?.code === "assistant_disabled") {
        const error = new Error("This assistant is no longer available.");
        error.code = body.code;
        throw error;
      }
      if (body?.error) message = body.error;
    } catch (error) {
      if (error?.code === "assistant_disabled") throw error;
      // keep default
    }
    throw new Error(message);
  }
  return res.json();
}

async function fetchConversations(tenantId, signal) {
  const res = await fetch("/api/member-ai/conversations", {
    credentials: "include",
    headers: tenantHeaders(tenantId),
    signal,
  });
  if (res.status === 403) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    if (body?.code === "not_member") return { notMember: true, conversations: [] };
    const error = new Error(body?.error || "Failed to load chat history");
    error.code = body?.code;
    throw error;
  }
  if (!res.ok) throw new Error("Failed to load chat history");
  return res.json();
}

async function fetchConversation(id, tenantId, signal) {
  const res = await fetch(`/api/member-ai/conversations/${id}`, {
    credentials: "include",
    headers: tenantHeaders(tenantId),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const error = new Error(body?.error || "Failed to load conversation");
    error.code = body?.code;
    throw error;
  }
  return res.json();
}

function deriveTitle(question) {
  const q = question.trim().replace(/\s+/g, " ");
  return q.length > TITLE_MAX ? `${q.slice(0, TITLE_MAX - 1).trimEnd()}…` : q;
}

export function AnswerWithCitations({ content, sources, onSourceClick, className = "text-foreground" }) {
  const byCitation = new Map(
    (sources || [])
      .filter((source) => source?.citationId)
      .map((source) => [source.citationId, source])
  );
  const parts = String(content || "").split(/(\[[A-Za-z][A-Za-z0-9_-]{0,11}\])/g);
  return (
    <p className={`whitespace-pre-wrap leading-relaxed ${className}`}>
      {parts.map((part, index) => {
        const match = /^\[([A-Za-z][A-Za-z0-9_-]{0,11})\]$/.exec(part);
        const source = match ? byCitation.get(match[1]) : null;
        if (!source?.link) return <React.Fragment key={index}>{part}</React.Fragment>;
        return (
          <Link
            key={index}
            to={source.link}
            onClick={onSourceClick}
            className="font-medium text-primary underline underline-offset-2 hover:no-underline"
            aria-label={`Open source: ${source.title}`}
            data-testid={`link-member-ai-inline-citation-${source.citationId}`}
          >
            {part}
          </Link>
        );
      })}
    </p>
  );
}

export function SourceDates({ dates }) {
  if (!Array.isArray(dates) || !dates.length) return null;
  return <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
    {dates.filter(date => date?.label && date?.value).map((date, index) =>
      <span key={index}>{date.label}: {date.value}</span>)}
  </span>;
}

export function EscalationNotice({ escalation }) {
  if (!escalation || typeof escalation !== "object") return null;
  const { name, url, email, instructions, message } = escalation;
  const safeUrl = typeof url === "string" && /^https:\/\//i.test(url) ? url : null;
  const safeEmail = typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  if (!name && !safeUrl && !safeEmail && !instructions && !message) return null;
  return <div className="mt-2 rounded-md border border-current/20 p-3 text-sm" data-testid="member-ai-escalation">
    <p className="font-semibold">Specialist contact</p>
    {(instructions || message) && <p className="mt-1 whitespace-pre-wrap">{instructions || message}</p>}
    {name && <p className="mt-1">{name}</p>}
    {safeUrl && <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="underline break-all">Contact link</a>}
    {safeEmail && <a href={`mailto:${safeEmail}`} className="ml-2 underline break-all">{safeEmail}</a>}
  </div>;
}

export default function MemberAiAssistant({ open, onOpenChange, config, identityKey }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState([]); // { role: 'user'|'assistant', content, sources? }
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false); // mobile panel toggle
  const [deleteTarget, setDeleteTarget] = useState(null); // { id, title }
  const scrollRef = useRef(null);
  const hydratedIdRef = useRef(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // History is strictly scoped to the active tenant: the tenant id is part of
  // every history query key, and all local thread state resets when it changes.
  const tenantId = config.tenantId;
  const requestController = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestController.current?.abort();
    };
  }, []);
  const closeIfDisabled = async (res) => {
    if (res.status !== 403) return false;
    const body = await res.clone().json().catch(() => null);
    if (body?.code !== "assistant_disabled") return false;
    queryClient.invalidateQueries({ queryKey: ["tenant-ai-assistant"] });
    if (mountedRef.current) onOpenChange(false);
    return true;
  };

  useEffect(() => {
    setActiveConversationId(null);
    hydratedIdRef.current = null;
    setTurns([]);
    setDeleteTarget(null);
  }, [tenantId]);

  const aiName = (config.name || "Dougal").trim() || "Dougal";
  const aiAvatarUrl = config.avatarUrl || dougalAvatar;
  const aiInitial = aiName.charAt(0).toUpperCase();
  const aiDescription = typeof config.description === "string" ? config.description.trim() : "";

  // --- Chat history (best-effort on the read path; chat works without it) ---
  const listQuery = useQuery({
    queryKey: ["/member-ai-conversations", tenantId, identityKey],
    queryFn: ({ signal }) => fetchConversations(tenantId, signal),
    enabled: open,
    staleTime: 30 * 1000,
  });
  const historySupported = !listQuery.data?.notMember;
  const conversations = listQuery.data?.conversations || [];

  const detailQuery = useQuery({
    queryKey: ["/member-ai-conversations", tenantId, identityKey, activeConversationId],
    queryFn: ({ signal }) => fetchConversation(activeConversationId, tenantId, signal),
    enabled: open && !!activeConversationId,
    staleTime: 0,
  });
  useEffect(() => {
    if (listQuery.error?.code === "assistant_disabled" || detailQuery.error?.code === "assistant_disabled") {
      queryClient.invalidateQueries({ queryKey: ["tenant-ai-assistant"] });
      onOpenChange(false);
    }
  }, [listQuery.error, detailQuery.error, queryClient, onOpenChange]);

  // Hydrate turns when a selected conversation's thread arrives.
  useEffect(() => {
    const data = detailQuery.data;
    if (!data?.conversation) return;
    if (data.conversation.id !== activeConversationId) return;
    if (hydratedIdRef.current === activeConversationId) return;
    hydratedIdRef.current = activeConversationId;
    setTurns(
      (data.messages || []).map((m) => ({
        role: m.role,
        content: m.content,
        sources: Array.isArray(m.sources) ? m.sources : undefined,
        escalation: m.escalation,
      }))
    );
  }, [detailQuery.data, activeConversationId]);

  const persistTurn = async ({ conversationId, question, answer }) => {
    const messages = [
      { role: "user", content: question },
      {
        role: "assistant",
        content: answer.answer,
          // The API signs this exact response.  Browser-provided sources are
          // never accepted by the history endpoint.
          answerProvenance: answer.answerProvenance,
      },
    ];
    if (conversationId) {
      const res = await fetch(`/api/member-ai/conversations/${conversationId}`, {
        method: "POST",
        credentials: "include",
        headers: tenantHeaders(tenantId),
        body: JSON.stringify({ messages }),
      });
      if (!res.ok) {
        await closeIfDisabled(res);
        throw new Error("append_failed");
      }
      return conversationId;
    }
    const res = await fetch("/api/member-ai/conversations", {
      method: "POST",
      credentials: "include",
      headers: tenantHeaders(tenantId),
      body: JSON.stringify({ title: deriveTitle(question), messages }),
    });
    if (res.status === 403) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        // ignore
      }
      if (body?.code === "not_member") return null; // persistence unsupported (admin preview)
      if (body?.code === "assistant_disabled") await closeIfDisabled(res);
      throw new Error("create_failed");
    }
    if (!res.ok) throw new Error("create_failed");
    const body = await res.json();
    return body?.conversation?.id || null;
  };

  const askMutation = useMutation({
    mutationFn: async (variables) => {
      const controller = new AbortController();
      requestController.current = controller;
      try {
        return await askMemberAi({ ...variables, signal: controller.signal });
      } catch (error) {
        if (error.code === "assistant_disabled") {
          queryClient.invalidateQueries({ queryKey: ["tenant-ai-assistant"] });
          if (mountedRef.current) onOpenChange(false);
        }
        throw error;
      } finally {
        if (requestController.current === controller) requestController.current = null;
      }
    },
    onSuccess: async (data, variables) => {
      if (!mountedRef.current) return;
      setTurns((prev) => [
        ...prev,
        { role: "user", content: variables.question },
        {
          role: "assistant",
          content: data.answer,
          sources: Array.isArray(data.sources) ? data.sources : [],
          escalation: data.escalation,
        },
      ]);
      // Persist the turn alongside the (stateless) ask flow. Saves must
      // surface errors — the chat keeps working, but the member is told.
      if (!historySupported) return;
      // No-answer fallbacks deliberately have no source-provenance envelope;
      // do not convert them into an unverifiable persisted assistant reply.
      if (!data.answerProvenance) return;
      // Don't persist into the wrong tenant if the active tenant changed
      // between asking and answering.
      if (!mountedRef.current || variables.tenantId !== tenantId) return;
      try {
        const savedId = await persistTurn({
          conversationId: variables.conversationId,
          question: variables.question,
          answer: data,
        });
        if (!mountedRef.current) return;
        if (savedId && !variables.conversationId) {
          hydratedIdRef.current = savedId; // local turns are canonical
          setActiveConversationId(savedId);
        }
        queryClient.invalidateQueries({
          queryKey: ["/member-ai-conversations", variables.tenantId],
        });
      } catch {
        toast({
          variant: "destructive",
          title: "Couldn't save this chat",
          description:
            "Your conversation continues, but this turn wasn't saved to history.",
        });
      }
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
    if (q.length < 3 || askMutation.isPending || !config.enabled) return;
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    askMutation.mutate({
      question: q,
      history,
      conversationId: activeConversationId,
      tenantId,
    });
    setQuestion("");
  };

  const handleNewChat = () => {
    if (askMutation.isPending) return;
    setActiveConversationId(null);
    hydratedIdRef.current = null;
    setTurns([]);
    askMutation.reset();
    setHistoryOpen(false);
  };

  const handleSelectConversation = (id) => {
    if (askMutation.isPending || id === activeConversationId) return;
    hydratedIdRef.current = null;
    setActiveConversationId(id);
    setTurns([]);
    askMutation.reset();
    setHistoryOpen(false);
    queryClient.invalidateQueries({
      queryKey: ["/member-ai-conversations", tenantId, identityKey, id],
    });
  };

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const res = await fetch(`/api/member-ai/conversations/${id}`, {
        method: "DELETE",
        credentials: "include",
        headers: tenantHeaders(tenantId),
      });
      if (!res.ok) {
        await closeIfDisabled(res);
        throw new Error("Failed to delete conversation");
      }
      return id;
    },
    onSuccess: (id) => {
      if (!mountedRef.current) return;
      queryClient.invalidateQueries({
        queryKey: ["/member-ai-conversations", tenantId],
      });
      queryClient.removeQueries({
        queryKey: ["/member-ai-conversations", tenantId, identityKey, id],
      });
      if (id === activeConversationId) {
        setActiveConversationId(null);
        hydratedIdRef.current = null;
        setTurns([]);
        askMutation.reset();
      }
      setDeleteTarget(null);
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Couldn't delete the conversation",
        description: "Please try again.",
      });
    },
  });

  const showHistoryPanel = historySupported;
  const loadingThread =
    !!activeConversationId &&
    detailQuery.isLoading &&
    hydratedIdRef.current !== activeConversationId;
  const isEmpty = turns.length === 0 && !askMutation.isPending && !loadingThread;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] max-h-[85vh] w-[95vw] max-w-6xl flex-col gap-0 overflow-hidden p-0"
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
              <DialogDescription className="mt-0.5 whitespace-pre-wrap break-words" data-testid="text-member-ai-description">
                {aiDescription ||
                  "Your AI guide to everything in the member portal."}
              </DialogDescription>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="mt-1.5 inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary underline-offset-2 hover:underline"
                    data-testid="button-member-ai-explainer"
                  >
                    <Info className="h-3.5 w-3.5" />
                    What {aiName} knows
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[min(20rem,calc(95vw-2rem))]"
                  data-testid="popover-member-ai-explainer"
                >
                  <div className="space-y-3 text-sm">
                    <p className="font-semibold text-foreground">
                      Where {aiName}'s answers come from
                    </p>
                    <ul className="space-y-2.5 text-muted-foreground">
                      <li className="flex items-start gap-2">
                        <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <span>
                          Answers come from your organisation's published portal
                          content — resources, events, news, articles and portal
                          pages.
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <span>
                          {aiName} only uses content you're allowed to see, based
                          on your access, role and groups.
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <span>
                          Answers are drawn from that content only — {aiName}{" "}
                          won't invent answers or use general world knowledge.
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <span>
                          Every answer links to the sources it used, so you can
                          check them yourself.
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <span>
                          If something isn't published in the portal yet,{" "}
                          {aiName} won't know about it.
                        </span>
                      </li>
                    </ul>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            {showHistoryPanel && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="ml-auto mr-8 md:hidden"
                onClick={() => setHistoryOpen((v) => !v)}
                data-testid="button-member-ai-history-toggle"
              >
                {historyOpen ? (
                  <X className="h-4 w-4" />
                ) : (
                  <History className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        </DialogHeader>

        <div className="relative flex min-h-0 flex-1">
          {showHistoryPanel && (
            <aside
              className={`${
                historyOpen ? "flex" : "hidden"
              } absolute inset-y-0 left-0 z-10 w-72 flex-col border-r bg-background md:static md:z-auto md:flex md:w-64 lg:w-72`}
              data-testid="member-ai-history-panel"
            >
              <div className="p-3">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start gap-2"
                  onClick={handleNewChat}
                  disabled={askMutation.isPending}
                  data-testid="button-member-ai-new-chat"
                >
                  <Plus className="h-4 w-4" />
                  New chat
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 pb-3">
                {listQuery.isLoading && (
                  <div className="space-y-2">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                  </div>
                )}
                {listQuery.isError && (
                  <p
                    className="px-1 text-xs text-muted-foreground"
                    data-testid="member-ai-history-error"
                  >
                    Couldn't load your chat history. Your chat still works.
                  </p>
                )}
                {!listQuery.isLoading &&
                  !listQuery.isError &&
                  conversations.length === 0 && (
                    <p
                      className="px-1 text-xs text-muted-foreground"
                      data-testid="member-ai-history-empty"
                    >
                      Your previous chats will appear here.
                    </p>
                  )}
                <ul className="space-y-1">
                  {conversations.map((c) => {
                    const isActive = c.id === activeConversationId;
                    return (
                      <li key={c.id} className="group relative">
                        <button
                          type="button"
                          onClick={() => handleSelectConversation(c.id)}
                          className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 pr-9 text-left hover-elevate ${
                            isActive ? "bg-muted" : ""
                          }`}
                          data-testid={`button-member-ai-conversation-${c.id}`}
                        >
                          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">
                              {c.title || "Untitled chat"}
                            </span>
                          </span>
                          <span className="pl-5 text-xs text-muted-foreground">
                            {c.updated_at
                              ? formatDistanceToNow(new Date(c.updated_at), {
                                  addSuffix: true,
                                })
                              : ""}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget({ id: c.id, title: c.title });
                          }}
                          className="absolute right-1.5 top-2 rounded-md p-1 text-muted-foreground opacity-0 hover-elevate focus:opacity-100 group-hover:opacity-100"
                          aria-label="Delete conversation"
                          data-testid={`button-member-ai-delete-${c.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </aside>
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              className="flex-1 space-y-4 overflow-y-auto p-5"
              data-testid="member-ai-thread"
            >
              {loadingThread && (
                <div className="space-y-4" data-testid="member-ai-thread-loading">
                  <div className="flex justify-end">
                    <Skeleton className="h-10 w-2/5" />
                  </div>
                  <div className="flex items-start gap-3">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-5/6" />
                      <Skeleton className="h-4 w-2/3" />
                    </div>
                  </div>
                </div>
              )}

              {isEmpty && (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <div className="rounded-full bg-primary/10 p-4 text-primary">
                    <Sparkles className="h-7 w-7" />
                  </div>
                  <p className="max-w-md text-muted-foreground">
                    Ask me about events, resources, news, articles, or portal
                    pages available to you. For example, "What events are coming
                    up?" or "Where can I find the onboarding guide?"
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
                        <AnswerWithCitations
                          content={turn.content}
                          sources={turn.sources}
                          onSourceClick={() => onOpenChange(false)}
                        />
                        <EscalationNotice escalation={turn.escalation} />
                      </div>
                      {Array.isArray(turn.sources) && turn.sources.some((source) => !source?._memberAiAnswerKind) && (
                        <div className="mt-2 flex flex-col gap-1.5">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Sources
                          </p>
                          {turn.sources.filter((source) => !source?._memberAiAnswerKind).map((source, si) => {
                            const Icon = TYPE_ICON[source.type] || BookOpen;
                            const inner = (
                              <>
                                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                 {source.citationId && (
                                   <span className="shrink-0 text-xs font-semibold text-primary">
                                     [{source.citationId}]
                                   </span>
                                 )}
                                 <span className="min-w-0 flex-1">
                                   <span className="block truncate">{source.title}</span>
                                   <SourceDates dates={source.dates} />
                                 </span>
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
                <div
                  className="flex items-start gap-3"
                  data-testid="member-ai-loading"
                >
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
          </div>
        </div>
      </DialogContent>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-member-ai-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.title || "Untitled chat"}" and all of its messages
              will be permanently deleted. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-member-ai-delete-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-member-ai-delete-confirm"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
