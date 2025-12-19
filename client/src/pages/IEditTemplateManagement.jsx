import React, { useState, useEffect, useMemo } from "react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Layers, Plus, Pencil, Trash2, GripVertical, FileText, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function IEditTemplateManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('site-builder.templates')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  const [showDialog, setShowDialog] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState(null);

  const queryClient = useQueryClient();

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['iedit-templates'],
    queryFn: () => base44.entities.IEditElementTemplate.list({ sort: { display_order: 'asc' } }),
    staleTime: 0
  });

  // Fetch all pages and elements to calculate usage
  const { data: allPages = [] } = useQuery({
    queryKey: ['iedit-pages-all'],
    queryFn: () => base44.entities.IEditPage.list(),
    staleTime: 0
  });

  const { data: allElements = [] } = useQuery({
    queryKey: ['iedit-elements-all'],
    queryFn: () => base44.entities.IEditPageElement.list(),
    staleTime: 0
  });

  // Calculate page usage for each element type
  const elementTypeUsage = useMemo(() => {
    const usage = {};
    
    // Group elements by element_type and collect unique page_ids
    allElements.forEach(element => {
      const elementType = element.element_type;
      if (!usage[elementType]) {
        usage[elementType] = new Set();
      }
      if (element.page_id) {
        usage[elementType].add(element.page_id);
      }
    });
    
    // Convert Sets to arrays and add page details
    const result = {};
    Object.keys(usage).forEach(elementType => {
      const pageIds = Array.from(usage[elementType]);
      const pages = pageIds
        .map(pageId => allPages.find(p => p.id === pageId))
        .filter(Boolean);
      result[elementType] = pages;
    });
    
    return result;
  }, [allElements, allPages]);

  const getPageUsageForTemplate = (template) => {
    return elementTypeUsage[template.element_type] || [];
  };

  const createTemplateMutation = useMutation({
    mutationFn: (templateData) => base44.entities.IEditElementTemplate.create(templateData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-templates'] });
      setShowDialog(false);
      setEditingTemplate(null);
      toast.success('Template created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create template: ' + error.message);
    }
  });

  const updateTemplateMutation = useMutation({
    mutationFn: ({ id, templateData }) => base44.entities.IEditElementTemplate.update(id, templateData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-templates'] });
      setShowDialog(false);
      setEditingTemplate(null);
      toast.success('Template updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update template: ' + error.message);
    }
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: (id) => base44.entities.IEditElementTemplate.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-templates'] });
      setShowDeleteDialog(false);
      setTemplateToDelete(null);
      toast.success('Template deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete template: ' + error.message);
    }
  });

  const handleCreateNew = () => {
    setEditingTemplate({
      name: "",
      element_type: "",
      description: "",
      icon: "Square",
      category: "content",
      default_content: {},
      available_variants: ["default"],
      content_schema: {},
      is_active: true,
      display_order: templates.length
    });
    setShowDialog(true);
  };

  const handleEdit = (template) => {
    setEditingTemplate({ ...template });
    setShowDialog(true);
  };

  const handleSave = () => {
    if (!editingTemplate.name.trim() || !editingTemplate.element_type.trim()) {
      toast.error('Name and element type are required');
      return;
    }

    if (editingTemplate.id) {
      updateTemplateMutation.mutate({
        id: editingTemplate.id,
        templateData: editingTemplate
      });
    } else {
      createTemplateMutation.mutate(editingTemplate);
    }
  };

  const getCategoryBadge = (category) => {
    const variants = {
      layout: "bg-purple-100 text-purple-700",
      content: "bg-blue-100 text-blue-700",
      media: "bg-green-100 text-green-700",
      interactive: "bg-amber-100 text-amber-700"
    };
    return variants[category] || variants.content;
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
              Element Templates
            </h1>
            <p className="text-slate-600">
              Manage reusable element templates for the page editor
            </p>
          </div>
          <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
            <Plus className="w-4 h-4 mr-2" />
            New Template
          </Button>
        </div>

        {/* Templates Grid */}
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
        ) : templates.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <Layers className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Templates Yet</h3>
              <p className="text-slate-600 mb-6">
                Create your first element template to start building custom pages
              </p>
              <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Template
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {templates.map((template) => {
              const usedOnPages = getPageUsageForTemplate(template);
              const pageCount = usedOnPages.length;
              
              return (
                <Card key={template.id} className="border-slate-200 hover:shadow-lg transition-shadow">
                  <CardHeader>
                    <div className="flex items-start justify-between mb-2">
                      <CardTitle className="text-lg">{template.name}</CardTitle>
                      <div className="flex gap-2 flex-wrap justify-end">
                        <Badge className={getCategoryBadge(template.category)}>
                          {template.category}
                        </Badge>
                        {!template.is_active && (
                          <Badge className="bg-slate-100 text-slate-700">Inactive</Badge>
                        )}
                      </div>
                    </div>
                    {template.description && (
                      <p className="text-sm text-slate-600 line-clamp-2">{template.description}</p>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="text-sm">
                      <span className="text-slate-500">Type:</span>
                      <span className="ml-2 font-mono text-slate-700">{template.element_type}</span>
                    </div>

                    <div className="text-sm">
                      <span className="text-slate-500">Variants:</span>
                      <span className="ml-2 text-slate-700">
                        {template.available_variants?.join(', ') || 'default'}
                      </span>
                    </div>

                    {/* Page Usage */}
                    <div className="text-sm">
                      <span className="text-slate-500">Used on:</span>
                      {pageCount === 0 ? (
                        <span className="ml-2 text-slate-400 italic">No pages</span>
                      ) : (
                        <Popover>
                          <PopoverTrigger asChild>
                            <button 
                              className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs font-medium hover:bg-blue-200 transition-colors cursor-pointer"
                              data-testid={`button-page-usage-${template.id}`}
                            >
                              <FileText className="w-3 h-3" />
                              {pageCount} page{pageCount !== 1 ? 's' : ''}
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-72 p-0" align="start">
                            <div className="p-3 border-b border-slate-200">
                              <h4 className="font-semibold text-sm">Pages using this element</h4>
                            </div>
                            <div className="max-h-64 overflow-y-auto">
                              {usedOnPages.map(page => (
                                <button
                                  key={page.id}
                                  onClick={() => {
                                    window.location.href = createPageUrl('IEditPageEditor') + `?id=${page.id}`;
                                  }}
                                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-100 text-left transition-colors"
                                  data-testid={`link-page-${page.id}`}
                                >
                                  <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-slate-900 truncate">
                                      {page.title || 'Untitled Page'}
                                    </p>
                                    <p className="text-xs text-slate-500 truncate">
                                      /{page.slug}
                                    </p>
                                  </div>
                                  <ExternalLink className="w-3 h-3 text-slate-400 flex-shrink-0" />
                                </button>
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>
                      )}
                    </div>

                    <div className="flex gap-2 pt-2 border-t border-slate-200">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEdit(template)}
                        className="flex-1"
                      >
                        <Pencil className="w-3 h-3 mr-1" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setTemplateToDelete(template);
                          setShowDeleteDialog(true);
                        }}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Create/Edit Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingTemplate?.id ? 'Edit Template' : 'Create New Template'}
              </DialogTitle>
            </DialogHeader>
            {editingTemplate && (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="name">Template Name *</Label>
                  <Input
                    id="name"
                    value={editingTemplate.name}
                    onChange={(e) => setEditingTemplate({ ...editingTemplate, name: e.target.value })}
                    placeholder="e.g., Hero Banner"
                  />
                </div>

                <div>
                  <Label htmlFor="element_type">Element Type *</Label>
                  <Input
                    id="element_type"
                    value={editingTemplate.element_type}
                    onChange={(e) => setEditingTemplate({ ...editingTemplate, element_type: e.target.value })}
                    placeholder="e.g., hero_banner (lowercase, underscores)"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Unique identifier for this element type
                  </p>
                </div>

                <div>
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={editingTemplate.description || ''}
                    onChange={(e) => setEditingTemplate({ ...editingTemplate, description: e.target.value })}
                    placeholder="What does this element do?"
                    rows={2}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="icon">Icon Name</Label>
                    <Input
                      id="icon"
                      value={editingTemplate.icon || 'Square'}
                      onChange={(e) => setEditingTemplate({ ...editingTemplate, icon: e.target.value })}
                      placeholder="Lucide icon name"
                    />
                  </div>

                  <div>
                    <Label htmlFor="category">Category</Label>
                    <Select
                      value={editingTemplate.category}
                      onValueChange={(value) => setEditingTemplate({ ...editingTemplate, category: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="layout">Layout</SelectItem>
                        <SelectItem value="content">Content</SelectItem>
                        <SelectItem value="media">Media</SelectItem>
                        <SelectItem value="interactive">Interactive</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <Label htmlFor="variants">Available Variants (comma-separated)</Label>
                  <Input
                    id="variants"
                    value={editingTemplate.available_variants?.join(', ') || 'default'}
                    onChange={(e) => setEditingTemplate({
                      ...editingTemplate,
                      available_variants: e.target.value.split(',').map(v => v.trim()).filter(Boolean)
                    })}
                    placeholder="default, dark, accent"
                  />
                </div>

                <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-lg">
                  <input
                    type="checkbox"
                    id="is_active"
                    checked={editingTemplate.is_active}
                    onChange={(e) => setEditingTemplate({ ...editingTemplate, is_active: e.target.checked })}
                    className="w-4 h-4"
                  />
                  <Label htmlFor="is_active" className="cursor-pointer">
                    Active (available in element palette)
                  </Label>
                </div>

                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-sm text-amber-900">
                    <strong>Note:</strong> After creating a template, you'll need to implement the corresponding React component 
                    in <code className="bg-white px-1 rounded">components/iedit/elements/</code> to render this element type.
                  </p>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={createTemplateMutation.isPending || updateTemplateMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingTemplate?.id ? 'Update' : 'Create'} Template
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Dialog */}
        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete Template</DialogTitle>
            </DialogHeader>
            <p className="text-slate-600">
              Are you sure you want to delete <strong>{templateToDelete?.name}</strong>? 
              This action cannot be undone.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => templateToDelete && deleteTemplateMutation.mutate(templateToDelete.id)}
                disabled={deleteTemplateMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}