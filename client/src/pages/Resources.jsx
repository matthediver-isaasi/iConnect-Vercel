import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileQuestion, ChevronLeft, ChevronRight, SlidersHorizontal, Sparkles, Save, X, ArrowLeft } from "lucide-react";
import ResourceFilter from "../components/resources/ResourceFilter";
import ResourceCard from "../components/resources/ResourceCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useResourceRealtime } from "@/hooks/useResourceRealtime";
import { useLayoutContext } from "@/contexts/LayoutContext";

export default function ResourcesPage() {
  const { memberInfo, memberRole, isAdmin } = useMemberAccess();
  const { hasBanner, sessionValidated, authResolved } = useLayoutContext();
  
  // SECURITY: Only consider user authenticated when all conditions are true:
  // 1. authResolved is true (server completed the auth check)
  // 2. sessionValidated is true (server confirmed the session via /api/auth/me)
  // 3. memberInfo.id exists (user data is valid)
  const isAuthenticated = authResolved && sessionValidated && !!memberInfo?.id;
  
  // Get resourceId from URL query params (used when redirecting back from login)
  const urlParams = new URLSearchParams(window.location.search);
  const resourceIdFromUrl = urlParams.get('resourceId');
  
  // State for filtering to a specific resource (e.g., after login redirect)
  const [filteredResourceId, setFilteredResourceId] = useState(resourceIdFromUrl || null);
  
  // When URL changes (e.g., after login redirect), update the filtered resource ID
  useEffect(() => {
    if (resourceIdFromUrl) {
      setFilteredResourceId(resourceIdFromUrl);
    }
  }, [resourceIdFromUrl]);
  
  // Clear the filter and remove the query param from URL
  const clearResourceFilter = () => {
    setFilteredResourceId(null);
    // Remove the query param from URL without reload
    window.history.replaceState({}, '', '/resources');
  };
  
  
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSubcategories, setSelectedSubcategories] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortBy, setSortBy] = useState("newest");
  const [itemsPerPage, setItemsPerPage] = useState(12);
  const [hasLoadedPreferences, setHasLoadedPreferences] = useState(false);

  const queryClient = useQueryClient();
  
  // SECURITY: Once auth is resolved as NOT authenticated, remove any registered authenticated query keys
  // This prevents realtime invalidations from triggering base44 fetches for guests
  useEffect(() => {
    // Only clean up after auth has resolved (not during initial loading)
    if (authResolved && !isAuthenticated) {
      // Cancel and remove any authenticated queries that might have been registered
      queryClient.cancelQueries({ queryKey: ['authenticated-resources'] });
      queryClient.removeQueries({ queryKey: ['authenticated-resources'] });
      queryClient.cancelQueries({ queryKey: ['authenticated-resource-categories'] });
      queryClient.removeQueries({ queryKey: ['authenticated-resource-categories'] });
      queryClient.cancelQueries({ queryKey: ['buttonStyles-resources'] });
      queryClient.removeQueries({ queryKey: ['buttonStyles-resources'] });
      queryClient.cancelQueries({ queryKey: ['resourceAuthorSettings'] });
      queryClient.removeQueries({ queryKey: ['resourceAuthorSettings'] });
      queryClient.cancelQueries({ queryKey: ['member-resource-categories'] });
      queryClient.removeQueries({ queryKey: ['member-resource-categories'] });
      queryClient.cancelQueries({ queryKey: ['current-user'] });
      queryClient.removeQueries({ queryKey: ['current-user'] });
    }
  }, [authResolved, isAuthenticated, queryClient]);
  
  // Only subscribe to realtime updates after auth is resolved
  // This prevents invalidating authenticated query keys for guests
  // Uses isAuthenticated (authResolved && sessionValidated && memberInfo?.id) to ensure server confirmed the session
  useResourceRealtime(authResolved ? (isAuthenticated ? ['authenticated-resources'] : ['public-resources']) : []);

  // Fetch current user's preferences (authenticated only)
  const { data: currentUser } = useQuery({
    queryKey: ['current-user', memberInfo?.email],
    queryFn: async () => {
      const user = await base44.auth.me();
      return user;
    },
    enabled: isAuthenticated
  });

  // Fetch member's saved category preferences from database (member_resource_category table)
  const { data: memberCategoryPreferences = [], isLoading: memberCategoriesLoading } = useQuery({
    queryKey: ['member-resource-categories', memberInfo?.id],
    queryFn: async () => {
      if (!memberInfo?.id) return [];
      const response = await fetch(`/api/members/${memberInfo.id}/categories`);
      if (!response.ok) {
        console.error('[Resources] Failed to fetch member category preferences');
        return [];
      }
      return response.json();
    },
    enabled: isAuthenticated
  });

  // Public resources query - only runs for unauthenticated users AFTER auth check completes
  // Must wait for authResolved to prevent race conditions
  const { data: publicResources = [], isLoading: publicResourcesLoading } = useQuery({
    queryKey: ['public-resources'],
    queryFn: async () => {
      console.log('[Resources] Fetching public resources via public API');
      const resources = await publicClient.listResources();
      console.log('[Resources] Public resources loaded:', resources.length);
      return resources;
    },
    enabled: authResolved && !isAuthenticated,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Authenticated resources query - only runs for authenticated users
  // Uses isAuthenticated which requires both sessionValidated AND memberInfo.id
  const { data: authenticatedResources = [], isLoading: authResourcesLoading } = useQuery({
    queryKey: ['authenticated-resources', memberRole?.id, isAdmin],
    queryFn: async () => {
      console.log('[Resources] ========== AUTHENTICATED FETCH START ==========');
      console.log('[Resources] memberRole:', memberRole?.id || 'none');
      console.log('[Resources] isAdmin:', isAdmin);
      
      const allResources = await base44.entities.Resource.list('-release_date');
      console.log('[Resources] Total resources from API:', allResources.length);
      
      // Filter by status and permissions for authenticated users
      const filtered = allResources.filter(resource => {
        // Always filter out draft resources
        if (resource.status === 'draft') return false;
        
        // Admins can see everything (except drafts)
        if (isAdmin) return true;
        
        // Public resources are visible to all authenticated users
        if (resource.is_public === true) return true;
        
        // For non-public resources, check role permissions
        if (memberRole) {
          // If no allowed_role_ids specified, it's available to all authenticated users
          if (!resource.allowed_role_ids || resource.allowed_role_ids.length === 0) {
            return true;
          }
          
          // Check if member's role is in the allowed list
          return resource.allowed_role_ids.includes(memberRole.id);
        }
        
        // Authenticated but no role loaded yet - show public only for now
        return resource.is_public === true;
      });
      
      console.log('[Resources] After filtering:', filtered.length, 'resources');
      console.log('[Resources] ========== AUTHENTICATED FETCH END ==========');
      return filtered;
    },
    enabled: isAuthenticated,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Combine resources based on auth state
  const resources = isAuthenticated ? authenticatedResources : publicResources;
  const resourcesLoading = isAuthenticated ? authResourcesLoading : publicResourcesLoading;

  // Public categories query - only runs for unauthenticated users AFTER auth check completes
  const { data: publicCategories = [], isLoading: publicCategoriesLoading } = useQuery({
    queryKey: ['public-resource-categories'],
    queryFn: async () => {
      const cats = await publicClient.listResourceCategories();
      const resourceCategories = cats.filter(c => 
        c.is_active && 
        c.applies_to_content_types && 
        c.applies_to_content_types.includes("Resources")
      );
      return resourceCategories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
    enabled: authResolved && !isAuthenticated,
    refetchOnWindowFocus: true
  });

  // Authenticated categories query - only runs for authenticated users
  const { data: authCategories = [], isLoading: authCategoriesLoading } = useQuery({
    queryKey: ['authenticated-resource-categories'],
    queryFn: async () => {
      const cats = await base44.entities.ResourceCategory.list();
      const resourceCategories = cats.filter(c => 
        c.is_active && 
        c.applies_to_content_types && 
        c.applies_to_content_types.includes("Resources")
      );
      return resourceCategories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
    enabled: isAuthenticated,
    refetchOnWindowFocus: true
  });

  // Combine categories based on auth state
  const categories = isAuthenticated ? authCategories : publicCategories;
  const categoriesLoading = isAuthenticated ? authCategoriesLoading : publicCategoriesLoading;

  // Fetch button styles once at page level (authenticated only - display config)
  const { data: buttonStyles = [] } = useQuery({
    queryKey: ['buttonStyles-resources'],
    queryFn: async () => {
      const styles = await base44.entities.ButtonStyle.list();
      return styles.filter(s => s.card_type === 'resource' && s.is_active);
    },
    enabled: isAuthenticated,
    refetchOnWindowFocus: true
  });

  // Fetch resource author settings for social icons configuration (authenticated only)
  const { data: resourceSettings } = useQuery({
    queryKey: ['resourceAuthorSettings'],
    queryFn: async () => {
      const settings = await base44.entities.ResourceAuthorSettings.list();
      return settings[0] || null;
    },
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });

  // Get enabled social icons from settings, default to all enabled
  const enabledSocialIcons = resourceSettings?.enabled_social_icons || ['x', 'linkedin', 'email'];
  
  // Get hide empty subcategories setting
  const hideEmptySubcategories = resourceSettings?.hide_empty_subcategories === true;

  // Load saved category preferences from database (member_resource_category table)
  // Priority: Database-backed category preferences > legacy UI preferences
  React.useEffect(() => {
    if (hasLoadedPreferences) return;
    
    // Wait for member category query to resolve if member is authenticated
    if (memberInfo?.id && memberCategoriesLoading) return;
    
    // First priority: Use database-backed category preferences (member_resource_category table)
    if (memberCategoryPreferences.length > 0) {
      const savedSubcategories = memberCategoryPreferences
        .filter(record => record.subcategory_name)
        .map(record => record.subcategory_name);
      
      if (savedSubcategories.length > 0) {
        setSelectedSubcategories(savedSubcategories);
        setHasLoadedPreferences(true);
        return;
      }
    }
    
    // Fallback: Use legacy UI preferences from currentUser.preferences.resources
    if (currentUser?.preferences?.resources?.selectedSubcategories?.length > 0) {
      setSelectedSubcategories(currentUser.preferences.resources.selectedSubcategories);
      setHasLoadedPreferences(true);
      return;
    }
    
    // Mark as loaded if we've checked all sources
    if (memberInfo?.id && !memberCategoriesLoading) {
      setHasLoadedPreferences(true);
    }
  }, [memberCategoryPreferences, memberCategoriesLoading, memberInfo?.id, currentUser, hasLoadedPreferences]);

  // Save preferences mutation - saves to member_resource_category table
  const savePreferencesMutation = useMutation({
    mutationFn: async () => {
      if (!memberInfo?.id) {
        throw new Error('You must be logged in to save preferences');
      }
      
      // Build selections array: map each selected subcategory to its parent category_id
      const selections = [];
      for (const subcatName of selectedSubcategories) {
        // Find the category that contains this subcategory
        const parentCategory = categories.find(cat => 
          cat.subcategories && cat.subcategories.includes(subcatName)
        );
        if (parentCategory) {
          selections.push({
            category_id: parentCategory.id,
            subcategory_name: subcatName
          });
        }
      }
      
      const response = await fetch(`/api/members/${memberInfo.id}/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections })
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to save preferences');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-resource-categories', memberInfo?.id] });
      toast.success('Filter preferences saved as default');
    },
    onError: (error) => {
      toast.error('Failed to save preferences: ' + error.message);
    }
  });

  const filteredResources = useMemo(() => {
    return resources.filter(resource => {
      // If filtering to a specific resource (e.g., after login redirect), only show that one
      // Compare as strings to handle numeric IDs from URL query params
      if (filteredResourceId) {
        return String(resource.id) === String(filteredResourceId);
      }
      
      // If no search query, match all resources
      const matchesSearch = !searchQuery.trim() || 
        resource.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        resource.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        resource.tags?.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));
      
      // If no subcategories are selected, show all resources
      // If subcategories are selected, only show resources that have at least one matching subcategory
      const matchesSubcategory = selectedSubcategories.length === 0 || 
        (resource.subcategories && Array.isArray(resource.subcategories) && resource.subcategories.some(sub => selectedSubcategories.includes(sub)));
      
      return matchesSearch && matchesSubcategory;
    });
  }, [resources, searchQuery, selectedSubcategories, filteredResourceId]);

  const sortedResources = useMemo(() => {
    const sorted = [...filteredResources];
    // Helper to get a valid timestamp from a resource (supports both authenticated and public payloads)
    // For sorting: missing dates go to the end (use Infinity for newest-first, -Infinity for oldest-first)
    const getTimestamp = (r, defaultValue = 0) => {
      const dateStr = r.published_date || r.release_date || r.created_date;
      if (!dateStr) return defaultValue;
      const parsed = Date.parse(dateStr);
      return isNaN(parsed) ? defaultValue : parsed;
    };
    
    switch (sortBy) {
      case 'newest':
        // Items without dates go to end (use -Infinity so they sort last when descending)
        sorted.sort((a, b) => getTimestamp(b, -Infinity) - getTimestamp(a, -Infinity));
        break;
      case 'oldest':
        // Items without dates go to end (use Infinity so they sort last when ascending)
        sorted.sort((a, b) => getTimestamp(a, Infinity) - getTimestamp(b, Infinity));
        break;
      case 'title-asc':
        sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        break;
      case 'title-desc':
        sorted.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
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

  const handleSaveAsDefault = () => {
    savePreferencesMutation.mutate();
  };

  const isLoading = resourcesLoading || categoriesLoading;

  // Check if current filters differ from saved preferences
  const hasUnsavedChanges = useMemo(() => {
    if (!currentUser?.preferences?.resources) return selectedSubcategories.length > 0;
    const savedSubcategories = currentUser.preferences.resources.selectedSubcategories || [];
    
    if (savedSubcategories.length !== selectedSubcategories.length) return true;
    
    return !savedSubcategories.every(sub => selectedSubcategories.includes(sub)) ||
           !selectedSubcategories.every(sub => savedSubcategories.includes(sub));
  }, [currentUser, selectedSubcategories]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <style>{`
        .agcas-pagination-button {
          box-shadow: inset 0 0 0 2px black;
          background: transparent;
          border: none;
          border-radius: 0;
          transition: all 0.3s;
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
      
      <div className="max-w-7xl mx-auto">
        {/* Header - hidden when custom banner is present */}
        {!hasBanner && (
          <div className="mb-8">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
                  Resources
                </h1>
                <p className="text-slate-600">
                  Explore helpful resources curated for you
                </p>
              </div>
              <Button
                onClick={() => {
                  // Only invalidate the query that's currently active based on authentication state
                  if (isAuthenticated) {
                    queryClient.invalidateQueries({ queryKey: ['authenticated-resources'] });
                    queryClient.invalidateQueries({ queryKey: ['authenticated-resource-categories'] });
                  } else {
                    queryClient.invalidateQueries({ queryKey: ['public-resources'] });
                    queryClient.invalidateQueries({ queryKey: ['public-resource-categories'] });
                  }
                  toast.success('Refreshing resources...');
                }}
                variant="outline"
                className="gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Force Refresh
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-col lg:flex-row gap-8">
          <div className="lg:w-64 flex-shrink-0">
            <div className="bg-white rounded-none shadow-sm border border-slate-200 p-6 sticky top-8">
              <ResourceFilter
                categories={categories}
                selectedSubcategories={selectedSubcategories}
                onSubcategoryToggle={handleSubcategoryToggle}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onClearSearch={() => setSearchQuery("")}
                isLoading={categoriesLoading}
                resources={resources}
                hideEmptySubcategories={hideEmptySubcategories}
              />
              
              {memberInfo && hasUnsavedChanges && (
                <div className="mt-4 pt-4 border-t border-slate-200">
                  <Button
                    onClick={handleSaveAsDefault}
                    variant="outline"
                    size="sm"
                    className="w-full gap-2 rounded-none"
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
            </div>
          </div>

          <div className="flex-1">
            {isLoading ? (
              <div className="grid xl:grid-cols-2 gap-6">
                {Array(12).fill(0).map((_, i) => (
                  <Card key={i} className="animate-pulse border-slate-200 rounded-none">
                    <div className="h-48 bg-slate-200" />
                    <div className="p-6">
                      <div className="h-6 bg-slate-200 rounded w-3/4 mb-2" />
                      <div className="h-4 bg-slate-200 rounded w-full" />
                    </div>
                  </Card>
                ))}
              </div>
            ) : sortedResources.length === 0 ? (
              <Card className="border-slate-200 shadow-sm rounded-none">
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
                {/* Banner showing when filtered to a specific resource */}
                {filteredResourceId && (
                  <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-none flex items-center justify-between" data-testid="banner-filtered-resource">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-100 rounded-full">
                        <Sparkles className="w-4 h-4 text-blue-600" />
                      </div>
                      <div>
                        <p className="font-medium text-blue-900">Showing selected resource</p>
                      </div>
                    </div>
                    <Button
                      onClick={clearResourceFilter}
                      variant="outline"
                      size="sm"
                      className="gap-2 border-blue-300 text-blue-700 hover:bg-blue-100 rounded-none"
                      data-testid="button-show-all-resources"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Show all resources
                    </Button>
                  </div>
                )}
                
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-3">
                  <div className="text-sm text-slate-600">
                    Showing {startIndex + 1}-{Math.min(endIndex, sortedResources.length)} of {sortedResources.length} resources
                  </div>
                  
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger className="w-48 rounded-none">
                      <SlidersHorizontal className="w-4 h-4 mr-2" />
                      <SelectValue placeholder="Sort By" />
                    </SelectTrigger>
                    <SelectContent className="rounded-none">
                      <SelectItem value="newest">Newest First</SelectItem>
                      <SelectItem value="oldest">Oldest First</SelectItem>
                      <SelectItem value="title-asc">Title A-Z</SelectItem>
                      <SelectItem value="title-desc">Title Z-A</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid xl:grid-cols-2 gap-6 mb-8">
                  {paginatedResources.map(resource => (
                    <ResourceCard 
                      key={resource.id} 
                      resource={resource}
                      buttonStyles={buttonStyles}
                      enabledSocialIcons={enabledSocialIcons}
                      isAuthenticated={isAuthenticated}
                    />
                  ))}
                </div>

                <Card className="border-slate-200 shadow-sm rounded-none">
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
                            <SelectContent className="rounded-none">
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
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}