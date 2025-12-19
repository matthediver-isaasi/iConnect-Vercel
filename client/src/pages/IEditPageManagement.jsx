
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileEdit, Plus, Eye, Pencil, Trash2, ExternalLink, Search, Zap, Copy, Home } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useNavigate } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function IEditPageManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('site-builder.pages')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [pageToDelete, setPageToDelete] = useState(null);
  const [newPage, setNewPage] = useState({
    title: "",
    slug: "",
    description: "",
    layout_type: "public",
    status: "draft"
  });

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: pages = [], isLoading } = useQuery({
    queryKey: ['iedit-pages'],
    queryFn: () => base44.entities.IEditPage.list(),
    staleTime: 0
  });

  // Query for current home page setting
  const { data: homePageSlug } = useQuery({
    queryKey: ['home-page-setting'],
    queryFn: async () => {
      const settings = await base44.entities.SystemSettings.list();
      const homeSetting = settings.find(s => s.setting_key === 'public_home_page_slug');
      return homeSetting?.setting_value || null;
    },
    staleTime: 0
  });

  const createPageMutation = useMutation({
    mutationFn: (pageData) => base44.entities.IEditPage.create(pageData),
    onSuccess: (newPage) => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      setShowCreateDialog(false);
      setNewPage({ title: "", slug: "", description: "", layout_type: "public", status: "draft" });
      toast.success('Page created successfully');
      navigate(createPageUrl('IEditPageEditor') + `?pageId=${newPage.id}`);
    },
    onError: (error) => {
      toast.error('Failed to create page: ' + error.message);
    }
  });

  const deletePageMutation = useMutation({
    mutationFn: async (pageId) => {
      const allElements = await base44.entities.IEditPageElement.filter({ page_id: pageId });
      for (const element of allElements) {
        await base44.entities.IEditPageElement.delete(element.id);
      }
      await base44.entities.IEditPage.delete(pageId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      setShowDeleteDialog(false);
      setPageToDelete(null);
      toast.success('Page deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete page: ' + error.message);
    }
  });

  const togglePublishMutation = useMutation({
    mutationFn: async (page) => {
      const newStatus = page.status === 'published' ? 'draft' : 'published';
      const updateData = { 
        status: newStatus,
        published_at: newStatus === 'published' ? new Date().toISOString() : null
      };
      await base44.entities.IEditPage.update(page.id, updateData);
      return { ...page, ...updateData };
    },
    onSuccess: (updatedPage) => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      if (updatedPage.status === 'published') {
        toast.success(`Page published! Now live at ${window.location.origin}/${updatedPage.slug}`);
      } else {
        toast.success('Page unpublished and returned to draft');
      }
    },
    onError: (error) => {
      toast.error('Failed to update page status: ' + error.message);
    }
  });

  const duplicatePageMutation = useMutation({
    mutationFn: async (page) => {
      // Generate a unique slug by adding -copy or incrementing number
      let newSlug = `${page.slug}-copy`;
      const existingSlugs = pages.map(p => p.slug);
      let counter = 1;
      while (existingSlugs.includes(newSlug)) {
        newSlug = `${page.slug}-copy-${counter}`;
        counter++;
      }

      // Create the new page (as draft)
      const newPageData = {
        title: `${page.title} (Copy)`,
        slug: newSlug,
        description: page.description || '',
        layout_type: page.layout_type || 'public',
        status: 'draft',
        meta_title: page.meta_title,
        meta_description: page.meta_description
      };

      const createdPage = await base44.entities.IEditPage.create(newPageData);

      // Copy all elements from the original page
      const originalElements = await base44.entities.IEditPageElement.filter({ page_id: page.id });
      
      for (const element of originalElements) {
        const { id, page_id, created_date, updated_date, ...elementData } = element;
        await base44.entities.IEditPageElement.create({
          ...elementData,
          page_id: createdPage.id
        });
      }

      return createdPage;
    },
    onSuccess: (newPage) => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      toast.success(`Page duplicated! New page: "${newPage.title}"`);
    },
    onError: (error) => {
      toast.error('Failed to duplicate page: ' + error.message);
    }
  });

  // Mutation to toggle home page
  const toggleHomePageMutation = useMutation({
    mutationFn: async (page) => {
      // If this page is already the home page, remove it
      const isCurrentlyHome = homePageSlug === page.slug;
      const newSlug = isCurrentlyHome ? '' : page.slug;
      
      // Use dedicated function endpoint for reliability
      const response = await fetch('/api/functions/setPublicHomePage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: newSlug })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update home page');
      }
      
      return { slug: newSlug, wasHome: isCurrentlyHome };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['home-page-setting'] });
      if (result.wasHome) {
        toast.success('Home page removed. Default Events page will be shown.');
      } else {
        toast.success(`Home page set! Visitors to the root URL will now see /${result.slug}`);
      }
    },
    onError: (error) => {
      toast.error('Failed to update home page: ' + error.message);
    }
  });

  const handleCreatePage = () => {
    if (!newPage.title.trim() || !newPage.slug.trim()) {
      toast.error('Title and slug are required');
      return;
    }

    const slugRegex = /^[a-z0-9-]+$/;
    if (!slugRegex.test(newPage.slug)) {
      toast.error('Slug must be lowercase with hyphens only (no spaces or special characters)');
      return;
    }

    createPageMutation.mutate(newPage);
  };

  const handleDeletePage = () => {
    if (pageToDelete) {
      deletePageMutation.mutate(pageToDelete.id);
    }
  };

  const filteredPages = pages.filter(page => 
    page.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    page.slug?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    page.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getStatusBadge = (status) => {
    const variants = {
      draft: "bg-slate-100 text-slate-700",
      published: "bg-green-100 text-green-700",
      archived: "bg-amber-100 text-amber-700"
    };
    return variants[status] || variants.draft;
  };

  const getPublicUrl = (slug) => {
    // Dynamic pages are accessed via their slug directly as a route
    return `/${slug}`;
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Page Editor
            </h1>
            <p className="text-slate-600">
              Create and manage custom pages with drag-and-drop elements
            </p>
          </div>
          <Button onClick={() => setShowCreateDialog(true)} className="bg-blue-600 hover:bg-blue-700">
            <Plus className="w-4 h-4 mr-2" />
            New Page
          </Button>
        </div>

        {/* Search */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-8">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
            <Input
              placeholder="Search pages by title, slug, or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {/* Pages Grid */}
        {isLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array(6).fill(0).map((_, i) => (
              <Card key={i} className="animate-pulse border-slate-200">
                <CardHeader>
                  <div className="h-6 bg-slate-200 rounded w-3/4 mb-2" />
                  <div className="h-4 bg-slate-200 rounded w-full" />
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : filteredPages.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <FileEdit className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                {searchQuery ? 'No Pages Found' : 'No Pages Yet'}
              </h3>
              <p className="text-slate-600 mb-6">
                {searchQuery 
                  ? 'Try adjusting your search query' 
                  : 'Create your first custom page to get started'}
              </p>
              {!searchQuery && (
                <Button onClick={() => setShowCreateDialog(true)} className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="w-4 h-4 mr-2" />
                  Create First Page
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredPages.map((page) => (
              <Card key={page.id} className="border-slate-200 hover:shadow-lg transition-shadow">
                <CardHeader>
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-lg">{page.title}</CardTitle>
                      {homePageSlug === page.slug && (
                        <Badge className="bg-blue-100 text-blue-700 border-blue-300">
                          <Home className="w-3 h-3 mr-1" />
                          Home
                        </Badge>
                      )}
                    </div>
                    <Badge className={getStatusBadge(page.status)}>
                      {page.status}
                    </Badge>
                  </div>
                  {page.description && (
                    <p className="text-sm text-slate-600 line-clamp-2">{page.description}</p>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="text-sm">
                    <span className="text-slate-500">Slug:</span>
                    <span className="ml-2 font-mono text-slate-700">/{page.slug}</span>
                  </div>
                  
                  <div className="text-sm">
                    <span className="text-slate-500">View:</span>
                    <Badge variant="outline" className="ml-2">
                      {page.layout_type === 'public' && 'Public'}
                      {page.layout_type === 'member' && 'Portal'}
                      {page.layout_type === 'hybrid' && 'Hybrid'}
                      {!['public', 'member', 'hybrid'].includes(page.layout_type) && (page.layout_type || 'Public')}
                    </Badge>
                  </div>

                  {page.updated_date && (
                    <div className="text-xs text-slate-500">
                      Updated {format(new Date(page.updated_date), 'MMM d, yyyy')}
                    </div>
                  )}

                  <div className="flex gap-2 pt-2 border-t border-slate-200">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(createPageUrl('IEditPageEditor') + `?pageId=${page.id}`)}
                      className="flex-1"
                    >
                      <Pencil className="w-3 h-3 mr-1" />
                      Edit
                    </Button>
                    {page.status === 'published' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => window.open(getPublicUrl(page.slug), '_blank')}
                        title="View Published Page"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => duplicatePageMutation.mutate(page)}
                      disabled={duplicatePageMutation.isPending}
                      title="Duplicate Page"
                      data-testid={`button-duplicate-page-${page.id}`}
                    >
                      <Copy className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setPageToDelete(page);
                        setShowDeleteDialog(true);
                      }}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>

                  {/* Publish/Unpublish Toggle */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => togglePublishMutation.mutate(page)}
                    disabled={togglePublishMutation.isPending}
                    className={`w-full ${
                      page.status === 'published' 
                        ? 'text-orange-600 hover:text-orange-700 hover:bg-orange-50' 
                        : 'text-green-600 hover:text-green-700 hover:bg-green-50'
                    }`}
                    data-testid={`button-toggle-publish-${page.id}`}
                  >
                    <Zap className="w-3 h-3 mr-1" />
                    {page.status === 'published' ? 'Unpublish Page' : `Publish to /${page.slug}`}
                  </Button>

                  {/* Home Page Toggle - only show for published public pages */}
                  {page.status === 'published' && page.layout_type === 'public' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleHomePageMutation.mutate(page)}
                      disabled={toggleHomePageMutation.isPending}
                      className={`w-full ${
                        homePageSlug === page.slug
                          ? 'bg-blue-100 text-blue-700 border-blue-300 hover:bg-blue-200'
                          : 'text-blue-600 hover:text-blue-700 hover:bg-blue-50'
                      }`}
                      data-testid={`button-toggle-home-${page.id}`}
                    >
                      <Home className="w-3 h-3 mr-1" />
                      {homePageSlug === page.slug ? 'Remove as Home Page' : 'Set as Home Page'}
                    </Button>
                  )}
                  
                  {/* Show live URL when published */}
                  {page.status === 'published' && (
                    <div className="text-xs text-green-600 bg-green-50 rounded px-2 py-1 text-center" data-testid={`text-live-url-${page.id}`}>
                      Live at: <a href={`/${page.slug}`} target="_blank" rel="noopener noreferrer" className="underline font-medium">/{page.slug}</a>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Create Page Dialog */}
        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Create New Page</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="title">Page Title *</Label>
                <Input
                  id="title"
                  value={newPage.title}
                  onChange={(e) => {
                    const title = e.target.value;
                    setNewPage({
                      ...newPage,
                      title,
                      slug: newPage.slug === '' ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : newPage.slug
                    });
                  }}
                  placeholder="e.g., About Our Organisation"
                />
              </div>

              <div>
                <Label htmlFor="slug">URL Slug *</Label>
                <Input
                  id="slug"
                  value={newPage.slug}
                  onChange={(e) => setNewPage({ ...newPage, slug: e.target.value.toLowerCase() })}
                  placeholder="e.g., about-our-organisation"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Lowercase letters, numbers, and hyphens only
                </p>
              </div>

              <div>
                <Label htmlFor="description">Description (Optional)</Label>
                <Textarea
                  id="description"
                  value={newPage.description}
                  onChange={(e) => setNewPage({ ...newPage, description: e.target.value })}
                  placeholder="Brief description for admin reference..."
                  rows={3}
                />
              </div>

              <div>
                <Label htmlFor="layout_type">View Type</Label>
                <Select
                  value={newPage.layout_type}
                  onValueChange={(value) => setNewPage({ ...newPage, layout_type: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public (Anyone can view, public layout)</SelectItem>
                    <SelectItem value="member">Portal (Members only, with sidebar)</SelectItem>
                    <SelectItem value="hybrid">Hybrid (Anyone can view, members see portal)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500 mt-1">
                  {newPage.layout_type === 'public' && 'Accessible to everyone with public header/footer layout'}
                  {newPage.layout_type === 'member' && 'Only logged-in members can access, displayed within the portal sidebar'}
                  {newPage.layout_type === 'hybrid' && 'Anyone can view; logged-in members see it within the portal sidebar'}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreatePage}
                disabled={createPageMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Create & Edit
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete Page</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-slate-600">
                Are you sure you want to delete <strong>{pageToDelete?.title}</strong>? 
                This will also delete all elements on this page. This action cannot be undone.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleDeletePage}
                disabled={deletePageMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete Page
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
