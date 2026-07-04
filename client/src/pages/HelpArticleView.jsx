import React from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft } from "lucide-react";
import HelpArticleContent from "@/components/help/HelpArticleContent";

export default function HelpArticleView() {
  const { slug } = useParams();

  const { data: article, isLoading, isError } = useQuery({
    queryKey: ["/help-articles", "slug", slug],
    queryFn: async () => {
      const rows = await base44.entities.HelpArticle.list({
        filter: { slug, status: "published" },
      });
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },
    enabled: !!slug,
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
        <Link to="/Help" data-testid="link-help-back">
          <ArrowLeft className="h-4 w-4" />
          Back to Help Center
        </Link>
      </Button>

      {isLoading && (
        <div className="space-y-4" data-testid="help-article-loading">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-40 w-full rounded-md" />
        </div>
      )}

      {!isLoading && (isError || !article) && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center" data-testid="help-article-notfound">
            <p className="text-muted-foreground">This help article isn't available.</p>
            <Button asChild variant="outline" size="sm">
              <Link to="/Help">Browse all articles</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && article && (
        <article data-testid="help-article">
          {article.category && (
            <p className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
              {article.category}
            </p>
          )}
          <h1 className="text-3xl font-semibold tracking-tight" data-testid="text-help-article-title">
            {article.title}
          </h1>
          {article.summary && (
            <p className="mt-2 text-lg text-muted-foreground">{article.summary}</p>
          )}
          <div className="mt-6">
            <HelpArticleContent body={article.body} />
          </div>
        </article>
      )}
    </div>
  );
}
