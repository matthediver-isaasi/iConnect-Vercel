import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Edit, Eye, FileQuestion, SlidersHorizontal } from "lucide-react";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import ArticleFilter from "../components/blog/ArticleFilter";
import ArticleCard from "../components/blog/ArticleCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function MyNewsPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedSubcategories, setSelectedSubcategories] = useState([]);
  const [sortBy, setSortBy] = useState("newest");

  const { data: news = [], isLoading: newsLoading } = useQuery({
    queryKey: ['my-news'],
    queryFn: async () => {
      const allNews = await base44.entities.NewsPost.list('-created_at');
      return allNews;
    },
    enabled: !isFeatureExcluded('content.news-management'),
    staleTime: 0, // Admin views need instant freshness after edits
  });

  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['resourceCategories'],
    queryFn: async () => {
      const cats = await base44.entities.ResourceCategory.list();
      return cats
        .filter(c => c.is_active && c.applies_to_content_types?.includes("News"))
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
  });

  const { data: buttonStyles = [] } = useQuery({
    queryKey: ['article-button-styles'],
    queryFn: async () => {
      const allStyles = await base44.entities.ButtonStyle.list();
      return allStyles.filter(s => s.is_active && s.card_type === 'article');
    },
  });

  const filteredNews = useMemo(() => {
    return news.filter(item => {
      const matchesSearch = item.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           item.summary?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           item.tags?.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchesStatus = statusFilter === "all" || item.status === statusFilter;
      
      const matchesSubcategory = selectedSubcategories.length === 0 || 
        (item.subcategories && item.subcategories.some(sub => selectedSubcategories.includes(sub)));
      
      return matchesSearch && matchesStatus && matchesSubcategory;
    });
  }, [news, searchQuery, statusFilter, selectedSubcategories]);

  const sortedNews = useMemo(() => {
    const sorted = [...filteredNews];
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
      default:
        break;
    }
    return sorted;
  }, [filteredNews, sortBy]);

  const handleSubcategoryToggle = (subcategory) => {
    setSelectedSubcategories(prev => {
      if (prev.includes(subcategory)) {
        return prev.filter(s => s !== subcategory);
      } else {
        return [...prev, subcategory];
      }
    });
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'published': return 'bg-green-100 text-green-700 border-green-200';
      case 'draft': return 'bg-amber-100 text-amber-700 border-amber-200';
      case 'archived': return 'bg-slate-100 text-slate-700 border-slate-200';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const isLoading = newsLoading || categoriesLoading;

  if (isFeatureExcluded('content.news-management')) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="border-red-200">
          <CardContent className="p-8 text-center">
            <p className="text-red-600">Administrator access required</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              News Management
            </h1>
            <p className="text-slate-600">Create and manage news content</p>
          </div>
          <Link to={createPageUrl('NewsEditor')}>
            <Button className="bg-blue-600 hover:bg-blue-700 gap-2">
              <Plus className="w-4 h-4" />
              New News Article
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
            ) : sortedNews.length === 0 ? (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-12 text-center">
                  <FileQuestion className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">
                    {searchQuery || statusFilter !== 'all' || selectedSubcategories.length > 0 ? 'No news found' : 'No news yet'}
                  </h3>
                  <p className="text-slate-600 mb-6">
                    {searchQuery || statusFilter !== 'all' || selectedSubcategories.length > 0
                      ? 'Try adjusting your search or filters' 
                      : 'Start creating your first news article'}
                  </p>
                  {!searchQuery && statusFilter === 'all' && selectedSubcategories.length === 0 && (
                    <Link to={createPageUrl('NewsEditor')}>
                      <Button className="bg-blue-600 hover:bg-blue-700 gap-2">
                        <Plus className="w-4 h-4" />
                        Create First News
                      </Button>
                    </Link>
                  )}
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-3">
                  <div className="text-sm text-slate-600">
                    Showing {sortedNews.length} {sortedNews.length === 1 ? 'article' : 'articles'}
                  </div>
                  
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger className="w-48">
                      <SlidersHorizontal className="w-4 h-4 mr-2" />
                      <SelectValue placeholder="Sort By" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="newest">Newest First</SelectItem>
                      <SelectItem value="oldest">Oldest First</SelectItem>
                      <SelectItem value="title-asc">Title A-Z</SelectItem>
                      <SelectItem value="title-desc">Title Z-A</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="grid md:grid-cols-2 gap-6">
                  {sortedNews.map(item => {
                    const isFuturePublished = item.published_date && new Date(item.published_date) > new Date();
                    return (
                    <div key={item.id}>
                      <div className="relative">
                        <div className="absolute top-2 right-2 z-10 flex gap-1">
                          <Badge className={getStatusColor(item.status)}>
                            {item.status}
                          </Badge>
                          {isFuturePublished && (
                            <Badge className="bg-purple-100 text-purple-700">
                              Scheduled
                            </Badge>
                          )}
                        </div>
                        <ArticleCard article={item} buttonStyles={buttonStyles} showActions={false} />
                      </div>
                      <div className="flex gap-2 mt-3">
                        <Link to={`${createPageUrl('NewsEditor')}?id=${item.id}`} className="flex-1">
                          <Button variant="outline" size="sm" className="w-full gap-2">
                            <Edit className="w-3 h-3" />
                            Edit
                          </Button>
                        </Link>
                        {item.status === 'published' && (
                          <Link to={`${createPageUrl('NewsView')}?slug=${item.slug}`} className="flex-1">
                            <Button variant="outline" size="sm" className="w-full gap-2">
                              <Eye className="w-3 h-3" />
                              View
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