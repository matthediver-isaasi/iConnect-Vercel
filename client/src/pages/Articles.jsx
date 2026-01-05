import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileQuestion, ChevronLeft, ChevronRight, SlidersHorizontal, Save, User, Plus, ArrowLeft } from "lucide-react";
import { Link, useParams, useNavigate } from "react-router-dom";
import ArticleFilter from "../components/blog/ArticleFilter";
import ArticleCard from "../components/blog/ArticleCard";
import FollowedAuthorsCard from "../components/blog/FollowedAuthorsCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useBlogPostRealtime } from "@/hooks/useBlogPostRealtime";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";
import { useLayoutContext } from "@/contexts/LayoutContext";

export default function ArticlesPage() {
  useBlogPostRealtime(['published-articles']);
  const { hasBanner } = useLayoutContext();
  const { memberInfo, isFeatureExcluded } = useMemberAccess();
  const { getArticleEditorUrl } = useArticleUrl();
  const { authorHandle } = useParams();
  const navigate = useNavigate();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [articleToDelete, setArticleToDelete] = useState(null);

  const hasAdminEditPermission = !isFeatureExcluded('content.articles.edit');
  const hasAdminDeletePermission = !isFeatureExcluded('content.articles.delete');
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSubcategories, setSelectedSubcategories] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortBy, setSortBy] = useState("newest");
  const [itemsPerPage, setItemsPerPage] = useState(6);
  const [hasLoadedPreferences, setHasLoadedPreferences] = useState(false);
  const [showMyArticlesOnly, setShowMyArticlesOnly] = useState(false);

  const queryClient = useQueryClient();
  
  // Lookup author by handle using server-side API (works in both dev and Vercel)
  const { data: authorInfo, isLoading: authorLoading, isError: authorNotFound } = useQuery({
    queryKey: ['author-by-handle', authorHandle],
    queryFn: async () => {
      console.log('[Articles] Author lookup - calling API for handle:', authorHandle);
      
      const response = await fetch(`/api/articles/lookup-author?handle=${encodeURIComponent(authorHandle)}`);
      
      if (response.status === 404) {
        throw new Error('Author not found');
      }
      
      if (!response.ok) {
        throw new Error('Failed to lookup author');
      }
      
      const data = await response.json();
      console.log('[Articles] Author lookup - API response:', data);
      return data;
    },
    enabled: !!authorHandle,
    staleTime: 60000,
    retry: false, // Don't retry if author not found
  });

  // Fetch current user's preferences
  const { data: currentUser } = useQuery({
    queryKey: ['current-user', memberInfo?.email],
    queryFn: async () => {
      const user = await base44.auth.me();
      return user;
    },
    enabled: !!memberInfo
  });

  // Use memberInfo.id directly for author comparison - no need to look up by email
  // This ensures consistency with how articles are created (using memberInfo.id as author_id)
  const currentMemberId = memberInfo?.id;

  // Fetch published articles for public view
  const { data: publishedArticles = [], isLoading: publishedLoading } = useQuery({
    queryKey: ['published-articles'],
    queryFn: async () => {
      const allArticles = await base44.entities.BlogPost.list('-published_date');
      return allArticles.filter(article => article.status === 'published');
    },
    staleTime: 0,
  });

  // Fetch user's own articles (including drafts) when "My Blogs" is active
  const { data: myArticles = [], isLoading: myArticlesLoading } = useQuery({
    queryKey: ['my-articles', currentMemberId],
    queryFn: async () => {
      const allArticles = await base44.entities.BlogPost.list('-published_date');
      // Get all articles by this author (published + drafts)
      return allArticles.filter(article => String(article.author_id) === String(currentMemberId));
    },
    enabled: !!currentMemberId && showMyArticlesOnly,
    staleTime: 0,
  });

  // Fetch articles by specific author when filtering by author handle
  const { data: authorArticles = [], isLoading: authorArticlesLoading } = useQuery({
    queryKey: ['articles-by-author', authorHandle, authorInfo?.id, authorInfo?.type],
    queryFn: async () => {
      const allArticles = await base44.entities.BlogPost.list('-published_date');
      // Filter by author - only published articles
      return allArticles.filter(article => {
        if (article.status !== 'published') return false;
        if (authorInfo?.type === 'member') {
          return String(article.author_id) === String(authorInfo.id);
        } else if (authorInfo?.type === 'guest_writer') {
          return String(article.guest_writer_id) === String(authorInfo.id);
        }
        return false;
      });
    },
    enabled: !!authorHandle && !!authorInfo,
    staleTime: 0,
  });

  // Use the appropriate article list based on filter mode
  const articles = authorHandle && authorInfo 
    ? authorArticles 
    : (showMyArticlesOnly ? myArticles : publishedArticles);
  const articlesLoading = authorHandle 
    ? (authorLoading || authorArticlesLoading)
    : (showMyArticlesOnly ? myArticlesLoading : publishedLoading);

  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['resourceCategories-articles'], // Updated queryKey
    queryFn: async () => {
      const cats = await base44.entities.ResourceCategory.list();
      // Filter to only show categories that apply to Articles
      const articleCategories = cats.filter(c =>
        c.is_active &&
        c.applies_to_content_types &&
        c.applies_to_content_types.includes("Articles")
      );
      return articleCategories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
    refetchOnWindowFocus: true
  });

  // Fetch all views for sorting
  const { data: allViews = [] } = useQuery({
    queryKey: ['all-article-views'],
    queryFn: async () => {
      return await base44.entities.ArticleView.list();
    }
  });

  // Fetch all reactions for sorting
  const { data: allReactions = [] } = useQuery({
    queryKey: ['all-article-reactions'],
    queryFn: async () => {
      return await base44.entities.ArticleReaction.list();
    }
  });

  // Fetch button styles once at page level
  const { data: buttonStyles = [] } = useQuery({
    queryKey: ['buttonStyles-articles'],
    queryFn: async () => {
      const styles = await base44.entities.ButtonStyle.list();
      return styles.filter(s => s.card_type === 'article' && s.is_active);
    },
    refetchOnWindowFocus: true
  });

  // Fetch member data (handles and names) for article authors
  const { data: authorData = { handles: {}, names: {} } } = useQuery({
    queryKey: ['author-data-for-articles', articles?.map(a => a.author_id).filter(Boolean).join(',')],
    queryFn: async () => {
      // Get unique author IDs from articles
      const uniqueAuthorIds = [...new Set(articles.filter(a => a.author_id).map(a => a.author_id))];
      console.log('[Articles] Fetching author data for', uniqueAuthorIds.length, 'unique authors');
      
      const handles = {};
      const names = {};
      // Fetch each author individually (much smaller than 5000 members)
      await Promise.all(uniqueAuthorIds.map(async (authorId) => {
        try {
          const member = await base44.entities.Member.get(authorId);
          if (member) {
            const memberHandle = member.handle || member.blog_handle;
            if (memberHandle) {
              handles[String(authorId)] = memberHandle;
            }
            const fullName = `${member.first_name || ''} ${member.last_name || ''}`.trim();
            if (fullName) {
              names[String(authorId)] = fullName;
            }
          }
        } catch (e) {
          // Member not found, skip
        }
      }));
      
      // Also fetch guest writer names
      const guestWriterIds = [...new Set(articles.filter(a => a.guest_writer_id).map(a => a.guest_writer_id))];
      if (guestWriterIds.length > 0) {
        const guestWriters = await base44.entities.GuestWriter.list();
        guestWriterIds.forEach(gwId => {
          const gw = guestWriters.find(w => w.id === gwId);
          if (gw) {
            names[`guest_${gwId}`] = gw.full_name;
          }
        });
      }
      
      console.log('[Articles] authorData built with', Object.keys(handles).length, 'handles and', Object.keys(names).length, 'names');
      return { handles, names };
    },
    enabled: !!articles?.length,
    staleTime: 60000 // Cache for 1 minute
  });
  
  // Backwards compatibility
  const authorHandles = authorData.handles;
  const authorNames = authorData.names;

  const { data: articleDisplayName, isLoading: displayNameLoading } = useQuery({
    queryKey: ['article-display-name'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'article_display_name');
      return setting?.setting_value || 'Articles';
    }
  });

  // Load saved preferences once
  React.useEffect(() => {
    if (currentUser?.preferences?.resources && !hasLoadedPreferences) {
      const savedSubcategories = currentUser.preferences.resources.selectedSubcategories || [];
      setSelectedSubcategories(savedSubcategories);
      setHasLoadedPreferences(true);
    }
  }, [currentUser, hasLoadedPreferences]);

  // Save preferences mutation
  const savePreferencesMutation = useMutation({
    mutationFn: async () => {
      const updatedPreferences = {
        ...(currentUser?.preferences || {}),
        resources: {
          selectedCategory: "all",
          selectedSubcategories
        }
      };
      await base44.auth.updateMe({ preferences: updatedPreferences });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['current-user'] });
      toast.success('Filter preferences saved as default');
    },
    onError: (error) => {
      toast.error('Failed to save preferences: ' + error.message);
    }
  });

  // Delete article mutation
  const deleteArticleMutation = useMutation({
    mutationFn: async (articleId) => {
      await base44.entities.BlogPost.delete(articleId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['published-articles'] });
      setDeleteDialogOpen(false);
      setArticleToDelete(null);
      toast.success('Article deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete article: ' + error.message);
    }
  });

  const handleEditArticle = (article) => {
    window.location.href = getArticleEditorUrl(article.id);
  };

  const handleDeleteArticle = (article) => {
    setArticleToDelete(article);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (articleToDelete) {
      deleteArticleMutation.mutate(articleToDelete.id);
    }
  };

  // Calculate view and like counts per article
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
                           article.tags?.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesSubcategory = selectedSubcategories.length === 0 ||
        (article.subcategories && article.subcategories.some(sub => selectedSubcategories.includes(sub)));

      // Note: author filtering is now handled by the separate myArticles query
      // so we don't need to filter by author here anymore

      return matchesSearch && matchesSubcategory;
    });
  }, [articles, searchQuery, selectedSubcategories]);

  const sortedArticles = useMemo(() => {
    const sorted = [...filteredArticles];
    switch (sortBy) {
      case 'newest':
        sorted.sort((a, b) => new Date(b.published_date || b.created_date) - new Date(a.published_date || a.created_date));
        break;
      case 'oldest':
        sorted.sort((a, b) => new Date(a.published_date || a.created_date) - new Date(b.published_date || a.created_date));
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

  const totalPages = Math.ceil(sortedArticles.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedArticles = sortedArticles.slice(startIndex, endIndex);

  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;

    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        if (totalPages > 5) pages.push('...');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1);
        if (totalPages > 5) pages.push('...');
        for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      }
    }
    return pages;
  };

  React.useEffect(() => {
    setCurrentPage(1);
  }, [selectedSubcategories, searchQuery, sortBy, itemsPerPage, showMyArticlesOnly]);

  const handleSubcategoryToggle = (subcategory) => {
    setSelectedSubcategories(prev => {
      if (prev.includes(subcategory)) {
        return prev.filter(s => s !== subcategory);
      } else {
        return [...prev, subcategory];
      }
    });
  };

  const handlePageChange = (page) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSaveAsDefault = () => {
    savePreferencesMutation.mutate();
  };

  const isLoading = articlesLoading || categoriesLoading || displayNameLoading;

  // Check if current filters differ from saved preferences
  const hasUnsavedChanges = useMemo(() => {
    if (!currentUser?.preferences?.resources) return selectedSubcategories.length > 0;
    const savedSubcategories = currentUser.preferences.resources.selectedSubcategories || [];

    if (savedSubcategories.length !== selectedSubcategories.length) return true;

    return !savedSubcategories.every(sub => selectedSubcategories.includes(sub)) ||
           !selectedSubcategories.every(sub => savedSubcategories.includes(sub));
  }, [currentUser, selectedSubcategories]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-7xl mx-auto">
          <div className="grid xl:grid-cols-2 gap-6">
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
        </div>
      </div>
    );
  }

  // Derive singular display name for header card
  const singularDisplayName = articleDisplayName.endsWith('s') 
    ? articleDisplayName.slice(0, -1) 
    : articleDisplayName;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* My Articles header - shown when viewing own articles */}
        {showMyArticlesOnly && (
          <>
            <button
              type="button"
              onClick={() => setShowMyArticlesOnly(false)}
              className="inline-flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-4"
              data-testid="button-back-to-all-articles"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to All {articleDisplayName}
            </button>
            <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h2 className="text-lg font-semibold text-blue-900 flex items-center gap-2">
                <User className="w-5 h-5" />
                My {articleDisplayName}
              </h2>
              <p className="text-sm text-blue-700 mt-1">Viewing your authored {articleDisplayName.toLowerCase()} including drafts</p>
            </div>
          </>
        )}

        {/* Author filter header - shown when viewing articles by specific author */}
        {authorHandle && (
          <>
            <button
              type="button"
              onClick={() => navigate('/Articles')}
              className="inline-flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-4"
              data-testid="button-back-to-all-articles-from-author"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to All {articleDisplayName}
            </button>
            {authorNotFound ? (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                <h2 className="text-lg font-semibold text-red-900 flex items-center gap-2">
                  <FileQuestion className="w-5 h-5" />
                  Author Not Found
                </h2>
                <p className="text-sm text-red-700 mt-1">
                  No author with the handle "{authorHandle}" was found.
                </p>
              </div>
            ) : authorLoading ? (
              <div className="mb-4 p-4 bg-slate-50 border border-slate-200 rounded-lg animate-pulse">
                <div className="h-6 bg-slate-200 rounded w-1/3 mb-2" />
                <div className="h-4 bg-slate-200 rounded w-1/4" />
              </div>
            ) : authorInfo ? (
              <div className="mb-4 p-4 bg-slate-50 border border-slate-200 rounded-lg">
                <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                  <User className="w-5 h-5" />
                  {articleDisplayName} by {authorInfo.name}
                </h2>
                {authorInfo.organization && (
                  <p className="text-sm text-slate-600 mt-1">{authorInfo.organization}</p>
                )}
                <p className="text-sm text-slate-500 mt-1">
                  {authorArticles.length} {authorArticles.length === 1 ? singularDisplayName.toLowerCase() : articleDisplayName.toLowerCase()} published
                </p>
              </div>
            ) : null}
          </>
        )}

        {!hasBanner && !showMyArticlesOnly && !authorHandle && (
          <div className="mb-8">
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              {articleDisplayName}
            </h1>
            <p className="text-slate-600">
              Explore {articleDisplayName.toLowerCase()} shared by our community
            </p>
          </div>
        )}

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
                isLoading={categoriesLoading}
                displayName={articleDisplayName}
              />

              {memberInfo && hasUnsavedChanges && (
                <div className="mt-4 pt-4 border-t border-slate-200">
                  <Button
                    onClick={handleSaveAsDefault}
                    variant="outline"
                    size="sm"
                    className="w-full gap-2"
                    disabled={savePreferencesMutation.isPending}
                  >
                    {savePreferencesMutation.isPending ? (
                      <>
                        <div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="w-3 h-3" />
                        Save as Default
                      </>
                    )}
                  </Button>
                  <p className="text-xs text-slate-500 mt-2 text-center">
                    Apply these filters by default
                  </p>
                </div>
              )}
              
              <FollowedAuthorsCard 
                memberInfo={memberInfo} 
                articleDisplayName={articleDisplayName}
              />
            </div>
          </div>

          <div className="flex-1">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-3">
              <div className="text-sm text-slate-600">
                {sortedArticles.length > 0 
                  ? `Showing ${startIndex + 1}-${Math.min(endIndex, sortedArticles.length)} of ${sortedArticles.length} ${articleDisplayName.toLowerCase()}`
                  : `0 ${articleDisplayName.toLowerCase()}`
                }
              </div>

              <div className="flex items-center gap-2">
                {memberInfo && !isFeatureExcluded('content.my-articles') && (
                  <Button
                    variant={showMyArticlesOnly ? "default" : "outline"}
                    size="sm"
                    onClick={() => setShowMyArticlesOnly(!showMyArticlesOnly)}
                    className="gap-2"
                    data-testid="button-my-articles-filter"
                  >
                    <User className="w-4 h-4" />
                    My {articleDisplayName}
                  </Button>
                )}
                
                {showMyArticlesOnly && (
                  <Link to={getArticleEditorUrl()}>
                    <Button
                      size="sm"
                      className="gap-2 bg-blue-600 hover:bg-blue-700"
                      data-testid="button-add-article"
                    >
                      <Plus className="w-4 h-4" />
                      New {articleDisplayName?.replace(/s$/i, '') || 'Article'}
                    </Button>
                  </Link>
                )}
                
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
            </div>

            {sortedArticles.length === 0 ? (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-12 text-center">
                  <FileQuestion className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">
                    No {articleDisplayName.toLowerCase()} found
                  </h3>
                  <p className="text-slate-600">
                    {showMyArticlesOnly
                      ? `You haven't authored any ${articleDisplayName.toLowerCase()} yet`
                      : searchQuery || selectedSubcategories.length > 0
                        ? 'Try adjusting your search or filters'
                        : 'Check back later for new content'}
                  </p>
                  {showMyArticlesOnly && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowMyArticlesOnly(false)}
                      className="mt-4"
                      data-testid="button-show-all-articles"
                    >
                      Show all {articleDisplayName.toLowerCase()}
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="grid xl:grid-cols-2 gap-6 mb-8">
                  {paginatedArticles.map(article => (
                    <ArticleCard 
                      key={article.id} 
                      article={article}
                      displayName={articleDisplayName}
                      hasAdminEditPermission={memberInfo ? hasAdminEditPermission : false}
                      hasAdminDeletePermission={memberInfo ? hasAdminDeletePermission : false}
                      currentMemberId={currentMemberId}
                      onEdit={handleEditArticle}
                      onDelete={handleDeleteArticle}
                      authorHandles={authorHandles}
                      authorNames={authorNames}
                    />
                  ))}
                </div>

                {sortedArticles.length > 0 && (
                  <Card className="border-slate-200 shadow-sm">
                    <CardContent className="p-6">
                      <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-slate-600">Items per page:</span>
                          <Select value={itemsPerPage.toString()} onValueChange={(val) => {
                            setItemsPerPage(Number(val));
                            setCurrentPage(1);
                          }}>
                            <SelectTrigger className="w-20">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="6">6</SelectItem>
                              <SelectItem value="12">12</SelectItem>
                              <SelectItem value="24">24</SelectItem>
                              <SelectItem value="48">48</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="text-sm text-slate-600">
                          Page {currentPage} of {totalPages}
                        </div>

                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePageChange(currentPage - 1)}
                            disabled={currentPage === 1}
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </Button>

                          {getPageNumbers().map((page, idx) => (
                            <React.Fragment key={idx}>
                              {page === '...' ? (
                                <span className="px-2 text-slate-400">...</span>
                              ) : (
                                <Button
                                  variant={currentPage === page ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => handlePageChange(page)}
                                  className="min-w-[40px]"
                                >
                                  {page}
                                </Button>
                              )}
                            </React.Fragment>
                          ))}

                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePageChange(currentPage + 1)}
                            disabled={currentPage === totalPages}
                          >
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Article</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{articleToDelete?.title}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setDeleteDialogOpen(false)}
              data-testid="button-cancel-delete"
            >
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={confirmDelete}
              disabled={deleteArticleMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteArticleMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}