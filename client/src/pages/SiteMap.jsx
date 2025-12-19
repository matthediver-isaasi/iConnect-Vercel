import React, { useMemo, useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, FileText, Newspaper, Briefcase, Sparkles, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";

export default function SiteMapPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const { getArticleViewUrl, getPublicArticlesUrl } = useArticleUrl();
  const [accessChecked, setAccessChecked] = useState(false);
  const appBaseUrl = window.location.origin;

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('system.site-map')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: articles = [] } = useQuery({
    queryKey: ['published-articles'],
    queryFn: async () => {
      const allArticles = await base44.entities.BlogPost.list();
      return allArticles.filter(a => a.status === 'published' && new Date(a.published_date) <= new Date());
    }
  });

  const { data: news = [] } = useQuery({
    queryKey: ['published-news'],
    queryFn: async () => {
      const allNews = await base44.entities.NewsPost.list();
      return allNews.filter(n => n.status === 'published' && new Date(n.published_date) <= new Date());
    }
  });

  const { data: jobPostings = [] } = useQuery({
    queryKey: ['active-job-postings'],
    queryFn: async () => {
      const allJobs = await base44.entities.JobPosting.list();
      return allJobs.filter(j => j.status === 'active');
    }
  });

  const { data: customPages = [] } = useQuery({
    queryKey: ['public-custom-pages'],
    queryFn: async () => {
      const allPages = await base44.entities.IEditPage.list();
      return allPages.filter(p => p.is_public);
    }
  });

  const staticPublicPages = [
    { name: 'Home', url: createPageUrl('Home'), icon: ExternalLink },
    { name: 'Public Events', url: createPageUrl('PublicEvents'), icon: ExternalLink },
    { name: 'Public Articles', url: getPublicArticlesUrl(), icon: FileText },
    { name: 'Public News', url: createPageUrl('PublicNews'), icon: Newspaper },
    { name: 'Public Resources', url: createPageUrl('PublicResources'), icon: Sparkles },
    { name: 'Job Board', url: createPageUrl('JobBoard'), icon: Briefcase },
    { name: 'Post Job', url: createPageUrl('PostJob'), icon: Briefcase },
    { name: 'Organisation Directory', url: createPageUrl('OrganisationDirectory'), icon: ExternalLink },
  ];

  const articleUrls = useMemo(() => {
    return articles.map(article => ({
      title: article.title,
      url: getArticleViewUrl(article.slug),
      fullUrl: `${appBaseUrl}${getArticleViewUrl(article.slug)}`,
      author: article.author_name,
      date: article.published_date
    }));
  }, [articles, appBaseUrl, getArticleViewUrl]);

  const newsUrls = useMemo(() => {
    return news.map(post => ({
      title: post.title,
      url: `${createPageUrl('NewsView')}?slug=${post.slug}`,
      fullUrl: `${appBaseUrl}${createPageUrl('NewsView')}?slug=${post.slug}`,
      author: post.author_name,
      date: post.published_date
    }));
  }, [news, appBaseUrl]);

  const jobUrls = useMemo(() => {
    return jobPostings.map(job => ({
      title: job.title,
      url: `${createPageUrl('JobDetails')}?id=${job.id}`,
      fullUrl: `${appBaseUrl}${createPageUrl('JobDetails')}?id=${job.id}`,
      company: job.company_name,
      date: job.created_date
    }));
  }, [jobPostings, appBaseUrl]);

  const customPageUrls = useMemo(() => {
    return customPages.map(page => ({
      title: page.title,
      url: `${createPageUrl('ViewPage')}?slug=${page.slug}`,
      fullUrl: `${appBaseUrl}${createPageUrl('ViewPage')}?slug=${page.slug}`,
      description: page.description,
    }));
  }, [customPages, appBaseUrl]);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast.success('URL copied to clipboard');
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-slate-600">Loading...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Public Site Map
          </h1>
          <p className="text-slate-600">
            All public-facing URLs on your platform
          </p>
        </div>

        <div className="grid gap-6">
          {/* Static Public Pages */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-200">
              <CardTitle className="flex items-center gap-2">
                <ExternalLink className="w-5 h-5 text-blue-600" />
                Static Public Pages
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <div className="space-y-2">
                {staticPublicPages.map((page, idx) => {
                  const Icon = page.icon;
                  return (
                    <div key={idx} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">
                      <div className="flex items-center gap-3">
                        <Icon className="w-4 h-4 text-slate-600" />
                        <div>
                          <p className="font-medium text-slate-900">{page.name}</p>
                          <p className="text-xs text-slate-500 font-mono">{appBaseUrl}{page.url}</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyToClipboard(`${appBaseUrl}${page.url}`)}
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
                        <a href={page.url} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm">
                            <ExternalLink className="w-3 h-3" />
                          </Button>
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Articles */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-200">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5 text-blue-600" />
                  Published Articles
                </CardTitle>
                <Badge>{articleUrls.length} articles</Badge>
              </div>
            </CardHeader>
            <CardContent className="p-6">
              {articleUrls.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">No published articles</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {articleUrls.map((article, idx) => (
                    <div key={idx} className="flex items-start justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-slate-900 truncate">{article.title}</p>
                        {article.author && (
                          <p className="text-xs text-slate-500 mt-0.5">By {article.author}</p>
                        )}
                        <p className="text-xs text-slate-500 font-mono mt-1 break-all">{article.fullUrl}</p>
                      </div>
                      <div className="flex gap-2 ml-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyToClipboard(article.fullUrl)}
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
                        <a href={article.url} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm">
                            <ExternalLink className="w-3 h-3" />
                          </Button>
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* News Posts */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-200">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Newspaper className="w-5 h-5 text-blue-600" />
                  Published News
                </CardTitle>
                <Badge>{newsUrls.length} posts</Badge>
              </div>
            </CardHeader>
            <CardContent className="p-6">
              {newsUrls.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">No published news posts</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {newsUrls.map((post, idx) => (
                    <div key={idx} className="flex items-start justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-slate-900 truncate">{post.title}</p>
                        {post.author && (
                          <p className="text-xs text-slate-500 mt-0.5">By {post.author}</p>
                        )}
                        <p className="text-xs text-slate-500 font-mono mt-1 break-all">{post.fullUrl}</p>
                      </div>
                      <div className="flex gap-2 ml-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyToClipboard(post.fullUrl)}
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
                        <a href={post.url} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm">
                            <ExternalLink className="w-3 h-3" />
                          </Button>
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Job Postings */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-200">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Briefcase className="w-5 h-5 text-blue-600" />
                  Active Job Postings
                </CardTitle>
                <Badge>{jobUrls.length} jobs</Badge>
              </div>
            </CardHeader>
            <CardContent className="p-6">
              {jobUrls.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">No active job postings</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {jobUrls.map((job, idx) => (
                    <div key={idx} className="flex items-start justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-slate-900 truncate">{job.title}</p>
                        {job.company && (
                          <p className="text-xs text-slate-500 mt-0.5">At {job.company}</p>
                        )}
                        <p className="text-xs text-slate-500 font-mono mt-1 break-all">{job.fullUrl}</p>
                      </div>
                      <div className="flex gap-2 ml-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyToClipboard(job.fullUrl)}
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
                        <a href={job.url} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm">
                            <ExternalLink className="w-3 h-3" />
                          </Button>
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Custom Public Pages */}
          {customPageUrls.length > 0 && (
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="border-b border-slate-200">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <ExternalLink className="w-5 h-5 text-blue-600" />
                    Custom Public Pages
                  </CardTitle>
                  <Badge>{customPageUrls.length} pages</Badge>
                </div>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-2">
                  {customPageUrls.map((page, idx) => (
                    <div key={idx} className="flex items-start justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-slate-900 truncate">{page.title}</p>
                        {page.description && (
                          <p className="text-xs text-slate-500 mt-0.5">{page.description}</p>
                        )}
                        <p className="text-xs text-slate-500 font-mono mt-1 break-all">{page.fullUrl}</p>
                      </div>
                      <div className="flex gap-2 ml-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyToClipboard(page.fullUrl)}
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
                        <a href={page.url} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm">
                            <ExternalLink className="w-3 h-3" />
                          </Button>
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}