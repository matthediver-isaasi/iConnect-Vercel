import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useQuery, useMutation } from "@tanstack/react-query";
import { base44, getActiveTenantId } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  BookOpen,
  ChevronRight,
  LifeBuoy,
  Search,
  Loader2,
  ArrowRight,
} from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import dougalAvatar from "@assets/ChatGPT_Image_Jul_4,_2026,_06_26_22_PM_1783182456658.png";

const UNCATEGORISED = "General";

async function askHelp(question) {
  const tenantId = getActiveTenantId();
  const res = await fetch("/api/help/ask", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(tenantId ? { "X-Tenant-Id": tenantId } : {}),
    },
    body: JSON.stringify({ question }),
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

export default function Help() {
  const [search, setSearch] = useState("");
  const [question, setQuestion] = useState("");
  const { isFeatureExcluded, isAccessReady, isAdmin } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin && isFeatureExcluded("page_Help")) {
        window.location.href = createPageUrl("Dashboard");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isAdmin, isFeatureExcluded]);

  const askMutation = useMutation({
    mutationFn: askHelp,
  });

  const handleAsk = (e) => {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 3 || askMutation.isPending) return;
    askMutation.mutate(q);
  };

  const answer = askMutation.data;

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

  const { data: articles, isLoading, isError } = useQuery({
    queryKey: ["/help-articles", "published"],
    queryFn: () =>
      base44.entities.HelpArticle.list({
        filter: { status: "published" },
        sort: { sort_order: "asc" },
      }),
  });

  const grouped = useMemo(() => {
    const list = (Array.isArray(articles) ? articles : []).filter(
      (article) =>
        !article.required_feature || !isFeatureExcluded(article.required_feature)
    );
    list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    const query = search.trim().toLowerCase();
    const filtered = query
      ? list.filter((article) => {
          const haystack = [article.title, article.summary, article.body]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return haystack.includes(query);
        })
      : list;

    const groups = new Map();
    for (const article of filtered) {
      const key = (article.category || "").trim() || UNCATEGORISED;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(article);
    }
    return Array.from(groups.entries());
  }, [articles, search, isFeatureExcluded]);

  const isSearching = search.trim().length > 0;

  if (!isAccessReady || !accessChecked) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <Skeleton className="mb-8 h-16 w-full" />
        <Skeleton className="mb-4 h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-8 flex items-start gap-3">
        <div className="rounded-md bg-primary/10 p-2 text-primary">
          <LifeBuoy className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-help-title">
            Help Center
          </h1>
          <p className="mt-1 text-muted-foreground">
            Guides and answers to help you get the most out of the platform.
          </p>
        </div>
      </div>

      <Card className="mb-8">
        <CardContent className="pt-6">
          <div className="mb-3 flex items-center gap-2">
            <Avatar className="h-16 w-16">
              <AvatarImage src={aiAvatarUrl} alt={aiName} />
              <AvatarFallback>{aiInitial}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold" data-testid="text-ask-dougal-heading">Ask {aiName}</h2>
              {aiDescription && (
                <p className="text-sm text-muted-foreground" data-testid="text-ai-persona-description">{aiDescription}</p>
              )}
            </div>
          </div>
          <form onSubmit={handleAsk} className="flex flex-wrap items-center gap-2">
            <Input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. How do I book an event?"
              className="min-w-0 flex-1"
              data-testid="input-help-ask"
            />
            <Button
              type="submit"
              disabled={question.trim().length < 3 || askMutation.isPending}
              data-testid="button-help-ask"
            >
              {askMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              Ask
            </Button>
          </form>

          {askMutation.isPending && (
            <div className="mt-4 space-y-2" data-testid="help-ask-loading">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}

          {askMutation.isError && !askMutation.isPending && (
            <p className="mt-4 text-sm text-muted-foreground" data-testid="help-ask-error">
              {askMutation.error?.message ||
                "We couldn't answer that right now. Please try again."}
            </p>
          )}

          {answer && !askMutation.isPending && !askMutation.isError && (
            <div className="mt-4" data-testid="help-ask-answer">
              <p className="whitespace-pre-wrap leading-relaxed text-foreground">
                {answer.answer}
              </p>
              {Array.isArray(answer.sources) && answer.sources.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Sources
                  </p>
                  <div className="flex flex-col gap-2">
                    {answer.sources.map((source) => (
                      <Link
                        key={source.slug}
                        to={`/help/${encodeURIComponent(source.slug)}`}
                        className="inline-flex items-center gap-2 text-sm font-medium text-primary hover-elevate rounded-md px-2 py-1 -mx-2"
                        data-testid={`link-help-source-${source.slug}`}
                      >
                        <BookOpen className="h-4 w-4 shrink-0" />
                        <span>{source.title}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {!isError && (
        <div className="relative mb-8">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search the Help Center..."
            className="pl-9"
            data-testid="input-help-search"
          />
        </div>
      )}

      {isLoading && (
        <div className="space-y-4" data-testid="help-loading">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-md" />
          ))}
        </div>
      )}

      {isError && !isLoading && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground" data-testid="help-error">
            We couldn't load the Help Center right now. Please try again later.
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && grouped.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center" data-testid="help-empty">
            <BookOpen className="h-8 w-8 text-muted-foreground" />
            {isSearching ? (
              <p className="text-muted-foreground">
                No articles match "{search.trim()}".
              </p>
            ) : (
              <p className="text-muted-foreground">No help articles are available yet.</p>
            )}
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && grouped.length > 0 && (
        <div className="space-y-8">
          {grouped.map(([category, items]) => (
            <section key={category} data-testid={`help-category-${category}`}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {category}
              </h2>
              <div className="space-y-3">
                {items.map((article) => (
                  <Link
                    key={article.id}
                    to={`/help/${encodeURIComponent(article.slug)}`}
                    className="block"
                    data-testid={`link-help-article-${article.slug}`}
                  >
                    <Card className="hover-elevate">
                      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                        <div>
                          <CardTitle className="text-base">{article.title}</CardTitle>
                          {article.summary && (
                            <p className="mt-1 text-sm text-muted-foreground">{article.summary}</p>
                          )}
                        </div>
                        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                      </CardHeader>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
