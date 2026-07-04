import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BookOpen, ChevronRight, LifeBuoy } from "lucide-react";

const UNCATEGORISED = "General";

export default function Help() {
  const { data: articles, isLoading, isError } = useQuery({
    queryKey: ["/help-articles", "published"],
    queryFn: () =>
      base44.entities.HelpArticle.list({
        filter: { status: "published" },
        sort: { sort_order: "asc" },
      }),
  });

  const grouped = useMemo(() => {
    const list = Array.isArray(articles) ? [...articles] : [];
    list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const groups = new Map();
    for (const article of list) {
      const key = (article.category || "").trim() || UNCATEGORISED;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(article);
    }
    return Array.from(groups.entries());
  }, [articles]);

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
            <p className="text-muted-foreground">No help articles are available yet.</p>
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
