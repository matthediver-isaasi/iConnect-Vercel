import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileQuestion, ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import { createPageUrl } from "@/utils";
import ArticleFilter from "../components/blog/ArticleFilter";
import ArticleCard from "../components/blog/ArticleCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBlogPostRealtime } from "@/hooks/useBlogPostRealtime";

export default function PublicArticlesPage() {
  useBlogPostRealtime(['public-articles']);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSubcategories, setSelectedSubcategories] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortBy, setSortBy] = useState("newest");
  const [itemsPerPage, setItemsPerPage] = useState(6);

  const { data: articlesData = { articles: [], authors: {}, guestWriters: {} }, isLoading: articlesLoading } = useQuery({
    queryKey: ['public-articles'],
    queryFn: async () => {
      const response = await fetch('/api/public/articles');
      if (!response.ok) {
        throw new Error('Failed to fetch articles');
      }
      return response.json();
    },
    staleTime: 0,
  });

  const articles = articlesData.articles || [];

  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['resourceCategories-articles'],
    queryFn: async () => {
      const response = await fetch('/api/public/resource-categories');
      if (!response.ok) {
        throw new Error('Failed to fetch categories');
      }
      const cats = await response.json();
      const articleCategories = cats.filter(c =>
        c.applies_to_content_types &&
        c.applies_to_content_types.includes("Articles")
      );
      return articleCategories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
    refetchOnMount: true
  });

  const authorHandles = useMemo(() => {
    const handles = {};
    Object.entries(articlesData.authors || {}).forEach(([id, data]) => {
      if (data.handle) {
        handles[id] = data.handle;
      }
    });
    return handles;
  }, [articlesData.authors]);

  const authorNames = useMemo(() => {
    const names = {};
    Object.entries(articlesData.authors || {}).forEach(([id, data]) => {
      if (data.name) {
        names[id] = data.name;
      }
    });
    Object.entries(articlesData.guestWriters || {}).forEach(([id, data]) => {
      if (data.name) {
        names[`guest_${id}`] = data.name;
      }
    });
    return names;
  }, [articlesData.authors, articlesData.guestWriters]);

  const articleStats = useMemo(() => {
    const stats = {};
    articles.forEach(article => {
      stats[article.id] = {
        viewCount: 0,
        likeCount: 0
      };
    });
    return stats;
  }, [articles]);

  const filteredArticles = useMemo(() => {
    return articles.filter(article => {
      const matchesSearch = article.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           article.summary?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           article.tags?.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));
      
      const matchesSubcategory = selectedSubcategories.length === 0 || 
        (article.subcategories && article.subcategories.some(sub => selectedSubcategories.includes(sub)));
      
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
        sorted.sort((a, b) => new Date(a.published_date || a.created_date) - new Date(b.published_date || b.created_date));
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
  }, [selectedSubcategories, searchQuery, sortBy, itemsPerPage]);

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

  const isLoading = articlesLoading || categoriesLoading;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Hero Section */}
        <div className="mb-12 text-center">
          <h1 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4">
            {articleDisplayName}
          </h1>
          <p className="text-xl text-slate-600 max-w-2xl mx-auto">
            Explore {articleDisplayName.toLowerCase()} from the careers education community
          </p>
        </div>

        <div className="flex flex-col lg:flex-row gap-8">
          {/* Filter Sidebar */}
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
            </div>
          </div>

          {/* Articles List */}
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
                    {searchQuery || selectedSubcategories.length > 0
                      ? 'Try adjusting your search or filters' 
                      : 'Check back later for new content'}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-3">
                  <div className="text-sm text-slate-600">
                    Showing {startIndex + 1}-{Math.min(endIndex, sortedArticles.length)} of {sortedArticles.length} {articleDisplayName.toLowerCase()}
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

                <div className="grid md:grid-cols-2 gap-6 mb-8">
                  {paginatedArticles.map(article => (
                    <ArticleCard 
                      key={article.id} 
                      article={article}
                      displayName={articleDisplayName}
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
    </div>
  );
}