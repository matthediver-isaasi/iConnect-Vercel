import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Edit, Eye, FileQuestion, Plus, SlidersHorizontal, User, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import ArticleFilter from "../components/blog/ArticleFilter";
import ArticleCard from "../components/blog/ArticleCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useBlogPostRealtime } from "@/hooks/useBlogPostRealtime";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";

export default function ArticleManagementPage() {
  useBlogPostRealtime(['all-articles-admin']);
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const { getArticleEditorUrl, getArticleViewUrlFromArticle } = useArticleUrl();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedSubcategories, setSelectedSubcategories] = useState([]);
  const [sortBy, setSortBy] = useState("newest");

  const { data: articles = [], isLoading: articlesLoading } = useQuery({
    queryKey: ['all-articles-admin'],
    queryFn: async () => {
      return await base44.entities.BlogPost.list('-published_date');
    },
    staleTime: 0, // Admin views need instant freshness after edits
  });

  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['resourceCategories-articles'],
    queryFn: async () => {
      const cats = await base44.entities.ResourceCategory.list();
      const articleCategories = cats.filter(c =>
        c.is_active &&
        c.applies_to_content_types &&
        c.applies_to_content_types.includes("Articles")
      );
      return articleCategories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    }
  });

  const { data: buttonStyles = [] } = useQuery({
    queryKey: ['article-button-styles'],
    queryFn: async () => {
      const allStyles = await base44.entities.ButtonStyle.list();
      return allStyles.filter(s => s.is_active && s.card_type === 'article');
    }
  });

  const { data: allViews = [] } = useQuery({
    queryKey: ['all-article-views'],
    queryFn: async () => {
      return await base44.entities.ArticleView.list();
    }
  });

  const { data: allReactions = [] } = useQuery({
    queryKey: ['all-article-reactions'],
    queryFn: async () => {
      return await base44.entities.ArticleReaction.list();
    }
  });

  const { data: articleDisplayName = 'Articles' } = useQuery({
    queryKey: ['article-display-name'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'article_display_name');
      return setting?.setting_value || 'Articles';
    }
  });

  const articleStats = useMemo(() => {
    const stats = {};
    articles.forEach(article => {
      stats[article.id] = {
        viewCount: allViews.filter(v => v.article_id === article.id).length,
        likeCount: allReactions.filter(r => r.article_id === article.id && r.reaction_type === 'up').length
      };
    });
    return stats;
  }, [articles, allViews, allReactions]);

  const filteredArticles = useMemo(() => {
    return articles.filter(article => {
      const matchesSearch = article.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           article.summary?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           article.tags?.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase())) ||
                           article.author_name?.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStatus = statusFilter === "all" || article.status === statusFilter;
      
      const matchesSubcategory = selectedSubcategories.length === 0 || 
        (article.subcategories && article.subcategories.some(sub => selectedSubcategories.includes(sub)));
      
      return matchesSearch && matchesStatus && matchesSubcategory;
    });
  }, [articles, searchQuery, statusFilter, selectedSubcategories]);

  const sortedArticles = useMemo(() => {
    const sorted = [...filteredArticles];
    switch (sortBy) {
      case 'newest':
        sorted.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
        break;
      case 'oldest':
        sorted.sort((a, b) => new Date(a.created_date) - new Date(b.created_date));
        break;
      case 'title-asc':
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'title-desc':
        sorted.sort((a, b) => b.title.localeCompare(a.title));
        break;
      case 'most-viewed':
        sorted.sort((a, b) => (articleStats[b.id]?.viewCount || 0) - (articleStats[a.id]?.viewCount || 0));
        break;
      case 'most-liked':
        sorted.sort((a, b) => (articleStats[b.id]?.likeCount || 0) - (articleStats[a.id]?.likeCount || 0));
        break;
      default:
        break;
    }
    return sorted;
  }, [filteredArticles, sortBy, articleStats]);

  const handleSubcategoryToggle = (subcategory) => {
    setSelectedSubcategories(prev => {
      if (prev.includes(subcategory)) {
        return prev.filter(s => s !== subcategory);
      } else {
        return [...prev, subcategory];
      }
    });
  };

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_ArticleManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const getStatusColor = (status) => {
    switch (status) {
      case 'published': return 'bg-green-100 text-green-700 border-green-200';
      case 'draft': return 'bg-amber-100 text-amber-700 border-amber-200';
      case 'archived': return 'bg-slate-100 text-slate-700 border-slate-200';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const isLoading = articlesLoading || categoriesLoading;

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              All {articleDisplayName}
            </h1>
            <p className="text-slate-600">Manage all {articleDisplayName.toLowerCase()} across the platform</p>
          </div>
          <Link to={getArticleEditorUrl()}>
            <Button className="bg-blue-600 hover:bg-blue-700 gap-2">
              <Plus className="w-4 h-4" />
              New {articleDisplayName.endsWith('s') ? articleDisplayName.slice(0, -1) : articleDisplayName}
            </Button>
          </Link>
        </div>

        <div className="flex flex-col lg:flex-row gap-8">
          <div className="lg:w-64 flex-shrink-0">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 sticky top-8">
              <ArticleFilter
                categories={categories}
                selectedSubcategories={selectedSubcategories}
                onSubcategoryToggle={handleSubcategoryToggle}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onClearSearch={() => setSearchQuery("")}
                isLoading={false}
                displayName={articleDisplayName}
              />
              
              <div className="mt-4 pt-4 border-t border-slate-200">
                <h3 className="text-sm font-semibold text-slate-700 mb-3">Status</h3>
                <div className="flex flex-col gap-2">
                  {['all', 'draft', 'published', 'archived'].map(status => (
                    <Button
                      key={status}
                      variant={statusFilter === status ? "default" : "outline"}
                      size="sm"
                      onClick={() => setStatusFilter(status)}
                      className="capitalize justify-start"
                    >
                      {status}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1">
            {isLoading ? (
              <div className="grid md:grid-cols-2 gap-6">
                {Array(6).fill(0).map((_, i) => (
                  <Card key={i} className="animate-pulse border-slate-200">
                    <div className="h-48 bg-slate-200" />
                    <div className="p-6">
                      <div className="h-6 bg-slate-200 rounded w-3/4 mb-2" />
                      <div className="h-4 bg-slate-200 rounded w-full" />
                    </div>
                  </Card>
                ))}
              </div>
            ) : sortedArticles.length === 0 ? (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-12 text-center">
                  <FileQuestion className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">
                    No {articleDisplayName.toLowerCase()} found
                  </h3>
                  <p className="text-slate-600">
                    Try adjusting your search or filters
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-3">
                  <div className="text-sm text-slate-600">
                    Showing {sortedArticles.length} {sortedArticles.length === 1 ? (articleDisplayName.endsWith('s') ? articleDisplayName.slice(0, -1).toLowerCase() : articleDisplayName.toLowerCase()) : articleDisplayName.toLowerCase()}
                  </div>
                  
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger className="w-48">
                      <SlidersHorizontal className="w-4 h-4 mr-2" />
                      <SelectValue placeholder="Sort By" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="newest">Newest First</SelectItem>
                      <SelectItem value="oldest">Oldest First</SelectItem>
                      <SelectItem value="most-viewed">Most Viewed</SelectItem>
                      <SelectItem value="most-liked">Most Liked</SelectItem>
                      <SelectItem value="title-asc">Title A-Z</SelectItem>
                      <SelectItem value="title-desc">Title Z-A</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="grid md:grid-cols-2 gap-6">
                  {sortedArticles.map(article => {
                    const isFuturePublished = article.published_date && new Date(article.published_date) > new Date();
                    return (
                    <div key={article.id}>
                      <div className="relative">
                        <div className="absolute top-2 right-2 z-10 flex gap-1">
                          <Badge className={getStatusColor(article.status)}>
                            {article.status}
                          </Badge>
                          {isFuturePublished && (
                            <Badge className="bg-purple-100 text-purple-700">
                              Scheduled
                            </Badge>
                          )}
                        </div>
                        <ArticleCard article={article} buttonStyles={buttonStyles} showActions={false} displayName={articleDisplayName} />
                      </div>
                      {article.author_name && (
                        <div className="flex items-center gap-2 mt-2 text-sm text-slate-600">
                          <User className="w-3 h-3" />
                          <span>By {article.author_name}</span>
                        </div>
                      )}
                      <div className="flex gap-2 mt-2">
                        <Link to={getArticleEditorUrl(article.id)} className="flex-1">
                          <Button variant="outline" size="sm" className="w-full gap-2">
                            <Edit className="w-3 h-3" />
                            Edit
                          </Button>
                        </Link>
                        {article.status === 'published' ? (
                          <Link to={getArticleViewUrlFromArticle(article)} className="flex-1">
                            <Button variant="outline" size="sm" className="w-full gap-2">
                              <Eye className="w-3 h-3" />
                              View
                            </Button>
                          </Link>
                        ) : (
                          <Link to={`${getArticleViewUrlFromArticle(article)}?preview=true`} className="flex-1">
                            <Button variant="outline" size="sm" className="w-full gap-2 text-amber-600 border-amber-200 hover:bg-amber-50">
                              <Eye className="w-3 h-3" />
                              Preview
                            </Button>
                          </Link>
                        )}
                      </div>
                    </div>
                  );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}