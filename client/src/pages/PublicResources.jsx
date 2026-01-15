import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button"; 
import { FileQuestion, ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import ResourceFilter from "../components/resources/ResourceFilter";
import ResourceCard from "../components/resources/ResourceCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useResourceRealtime } from "@/hooks/useResourceRealtime";

export default function PublicResourcesPage() {
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [selectedSubcategories, setSelectedSubcategories] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [sortBy, setSortBy] = useState("newest");
  const [itemsPerPage, setItemsPerPage] = useState(6);

  useResourceRealtime(['public-resources']);

  const isLoggedIn = useMemo(() => {
    const storedMember = localStorage.getItem('agcas_member');
    if (!storedMember) return false;
    
    const member = JSON.parse(storedMember);
    if (member.sessionExpiry && new Date(member.sessionExpiry) < new Date()) {
      return false;
    }
    return true;
  }, []);

  const { data: resources = [], isLoading: resourcesLoading } = useQuery({
    queryKey: ['public-resources'],
    queryFn: async () => {
      const response = await fetch('/api/public/resources');
      if (!response.ok) {
        throw new Error('Failed to fetch resources');
      }
      return response.json();
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['resourceCategories-public'],
    queryFn: async () => {
      const response = await fetch('/api/public/resource-categories');
      if (!response.ok) {
        throw new Error('Failed to fetch categories');
      }
      const cats = await response.json();
      const resourceCategories = cats.filter(c =>
        c.applies_to_content_types &&
        c.applies_to_content_types.includes("Resources")
      );
      return resourceCategories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
    refetchOnWindowFocus: true
  });

  const { data: buttonStyles = [] } = useQuery({
    queryKey: ['buttonStyles-resources'],
    queryFn: async () => {
      const styles = await base44.entities.ButtonStyle.list();
      return styles.filter(s => s.card_type === 'resource' && s.is_active);
    },
    refetchOnWindowFocus: true
  });

  const filteredResources = useMemo(() => {
    return resources.filter(resource => {
      const matchesSearch = resource.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           resource.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           resource.tags?.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesSubcategory = selectedSubcategories.length === 0 ||
        (resource.subcategories && resource.subcategories.some(sub => selectedSubcategories.includes(sub)));

      return matchesSearch && matchesSubcategory;
    });
  }, [resources, searchQuery, selectedSubcategories]);

  const sortedResources = useMemo(() => {
    const sorted = [...filteredResources];
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
      default:
        break;
    }
    return sorted;
  }, [filteredResources, sortBy]);

  const totalPages = Math.ceil(sortedResources.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedResources = sortedResources.slice(startIndex, endIndex);

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

  const isLoading = resourcesLoading || categoriesLoading;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      <style>{`
        .agcas-pagination-button {
          box-shadow: inset 0 0 0 2px black;
          background: transparent;
          border: none;
          border-radius: 0;
          transition: all 0.3s;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-weight: 500;
          color: #334155; /* slate-700 */
        }
        .agcas-pagination-button:hover:not(:disabled) {
          background: linear-gradient(to right top, rgb(92, 0, 133), rgb(186, 0, 135), rgb(238, 0, 195), rgb(255, 66, 41), rgb(255, 176, 0));
          color: white;
          box-shadow: none !important;
        }
        .agcas-pagination-button.active {
          background: linear-gradient(to right top, rgb(92, 0, 133), rgb(186, 0, 135), rgb(238, 0, 195), rgb(255, 66, 41), rgb(255, 176, 0));
          color: white;
          box-shadow: none !important;
        }
        .agcas-pagination-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
      
      <div className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white py-16">
        <div className="max-w-7xl mx-auto px-4 md:px-8">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Resources & Materials
          </h1>
          <p className="text-lg md:text-xl text-blue-100 max-w-3xl">
            Access our comprehensive library of resources, guides, and materials to support your work
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 md:px-8 py-8">
        <div className="flex flex-col lg:flex-row gap-8">
          <div className="lg:w-64 flex-shrink-0">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 sticky top-8">
              <ResourceFilter
                categories={categories}
                selectedSubcategories={selectedSubcategories}
                onSubcategoryToggle={handleSubcategoryToggle}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onClearSearch={() => setSearchQuery("")}
                isLoading={categoriesLoading}
              />
            </div>
          </div>

          <div className="flex-1">
            {resourcesLoading ? (
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
            ) : sortedResources.length === 0 ? (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-12 text-center">
                  <FileQuestion className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">
                    No resources found
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
                    Showing {startIndex + 1}-{Math.min(endIndex, sortedResources.length)} of {sortedResources.length} resources
                  </div>

                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger className="w-48 rounded-none">
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

                <div className="grid md:grid-cols-2 gap-6 mb-8">
                  {paginatedResources.map(resource => (
                    <ResourceCard 
                      key={resource.id} 
                      resource={resource}
                      isLocked={!resource.is_public && !isLoggedIn}
                      buttonStyles={buttonStyles}
                    />
                  ))}
                </div>

                {sortedResources.length > 0 && (
                  <Card className="border-slate-200 shadow-sm">
                    <CardContent className="p-6">
                      <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-slate-600">Items per page:</span>
                          <Select value={itemsPerPage.toString()} onValueChange={(val) => {
                            setItemsPerPage(Number(val));
                            setCurrentPage(1);
                          }}>
                            <SelectTrigger className="w-20 rounded-none">
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
                          <button
                            onClick={() => handlePageChange(currentPage - 1)}
                            disabled={currentPage === 1}
                            className="agcas-pagination-button px-3 py-2"
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </button>

                          {getPageNumbers().map((page, idx) => (
                            <React.Fragment key={idx}>
                              {page === '...' ? (
                                <span className="px-2 text-slate-400">...</span>
                              ) : (
                                <button
                                  onClick={() => handlePageChange(page)}
                                  className={`agcas-pagination-button px-3 py-2 min-w-[2.5rem] ${currentPage === page ? 'active' : ''}`}
                                >
                                  {page}
                                </button>
                              )}
                            </React.Fragment>
                          ))}

                          <button
                            onClick={() => handlePageChange(currentPage + 1)}
                            disabled={currentPage === totalPages}
                            className="agcas-pagination-button px-3 py-2"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </button>
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